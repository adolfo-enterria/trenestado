-- =====================================================================================
-- Trenestado — Supabase schema
-- Run once in the Supabase SQL editor (Dashboard → SQL Editor → New query → Run).
-- Safe to re-run: everything is "if not exists" / "or replace".
--
-- Architecture (docs/free-tier.md):
--   Edge Function "collector" (every minute, Supabase Cron) → writes here with the service_role key
--   Edge Function "gtfs" (daily) → refreshes the gtfs_* timetable tables
--   Browser → reads with the anon key; Row Level Security allows SELECT only
--
-- Size budget on the 500 MB free database (docs/free-tier.md §4):
--   train_runs LD ~100 MB/year (kept 2 years) · Cercanías ~70 MB steady (kept 90 days)
--   daily_line_stats ~20 MB/year (forever) · gtfs_* ~15 MB · snapshots ~5 MB (7 days)
-- =====================================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- -------------------------------------------------------------------------------------
-- Static data: stations and Renfe's timetable (GTFS), replaced daily by the "gtfs" job
-- -------------------------------------------------------------------------------------
create table if not exists public.stations (
  code         text primary key,                 -- 5-digit Renfe/Adif code, e.g. '17000'
  name         text not null,
  lat          double precision not null,
  lon          double precision not null,
  region       text,                             -- autonomous community id ('13' = Madrid)
  region_name  text,
  province     text,
  cercanias    boolean not null default false,   -- only in the Cercanías station list
  updated_at   timestamptz not null default now()
);

create table if not exists public.gtfs_calendar (
  service_id   text primary key,
  start_date   date not null,
  end_date     date not null,
  days         boolean[] not null                -- [mon, tue, wed, thu, fri, sat, sun]
);

create table if not exists public.gtfs_calendar_dates (
  service_id   text not null,
  date         date not null,
  added        boolean not null,                 -- true = runs this day, false = removed this day
  primary key (service_id, date)
);

create table if not exists public.gtfs_trips (
  trip_id      text primary key,
  train        text not null,                    -- commercial number, 5 digits
  product      smallint,                         -- Renfe product code (2 = AVE, 11 = Alvia…)
  route_name   text,
  service_id   text not null
);
create index if not exists gtfs_trips_train on public.gtfs_trips (train);
-- Cercanías trips share the table. Renfe's Cercanías GTFS is 288 MB unzipped (1.9 M stop times: one copy of
-- each trip per service day), so the gtfs job loads only today's and tomorrow's trips (~105k stop times).
alter table public.gtfs_trips add column if not exists network  text not null default 'ld' check (network in ('ld', 'cer'));
alter table public.gtfs_trips add column if not exists line     text;         -- Cercanías line ('C4a')
alter table public.gtfs_trips add column if not exists shape_id text;         -- Cercanías line shape
alter table public.gtfs_trips add column if not exists run_date date;         -- Cercanías: the single date the trip runs
create index if not exists gtfs_trips_network_train on public.gtfs_trips (network, train);

create table if not exists public.gtfs_shapes (
  shape_id     text primary key,
  points       jsonb not null                    -- [[lat, lon], …] in order
);

create table if not exists public.gtfs_stop_times (
  trip_id      text not null references public.gtfs_trips (trip_id) on delete cascade,
  seq          smallint not null,
  station      text not null,
  arr_min      smallint,                         -- minutes after midnight, may exceed 1440
  dep_min      smallint,
  primary key (trip_id, seq)
);
create index if not exists gtfs_stop_times_station on public.gtfs_stop_times (station);

create table if not exists public.cercanias_lines (
  nucleo       text not null,                    -- network id ('10' = Madrid)
  nucleo_name  text not null,
  line         text not null,                    -- 'C4a', 'R2N'…
  color        text,
  geom         jsonb not null,                   -- GeoJSON geometry
  primary key (nucleo, line)
);

-- -------------------------------------------------------------------------------------
-- Live state. The collector runs as a short-lived function, so what it must remember between
-- runs (last fix for speed, when a train stopped, which run it belongs to) lives here.
-- -------------------------------------------------------------------------------------
create table if not exists public.live_trains (
  id             text primary key,               -- '03303' (LD) or 'c23717' (Cercanías)
  network        text not null check (network in ('ld', 'cer')),
  train          text not null,
  type           text not null,                  -- ave | avlo | avant | alvia | ld | md | cer
  product        smallint,
  line           text,                           -- Cercanías line
  line_key       text,                           -- 'Madrid ↔ Sevilla' or 'Madrid C4a'
  lat            double precision not null,
  lon            double precision not null,
  fix_at         timestamptz not null,           -- time of the GPS fix (fetch time for Cercanías)
  kmh            real,
  heading        real,
  vlat           double precision not null default 0,   -- degrees/second, for map extrapolation
  vlon           double precision not null default 0,
  delay_min      integer not null default 0,
  prev_station   text,
  next_station   text,
  origin         text,
  dest           text,
  dest_region    text,
  run_date       date not null,
  stopped_since  timestamptz,
  delay_at_stop  integer,
  near_dest      boolean not null default false,
  last_seen      timestamptz not null default now(),
  extra          jsonb not null default '{}'::jsonb      -- platform, rolling stock, next-stop time…
);
create index if not exists live_trains_last_seen on public.live_trains (last_seen);

create table if not exists public.cancellations (            -- GTFS-RT CANCELED trips (LD/MD only)
  service_date  date not null,
  train         text not null,
  trip_id       text not null,
  seen_at       timestamptz not null default now(),
  primary key (service_date, trip_id)
);

create table if not exists public.source_status (
  name        text primary key,                  -- renfe | cercanias | gtfsRt | gtfs | adif | renfeAlerts
  ok          boolean not null,
  at          timestamptz,                       -- last success
  tried_at    timestamptz,                       -- last attempt
  error       text,
  detail      jsonb not null default '{}'::jsonb
);

-- -------------------------------------------------------------------------------------
-- History
-- -------------------------------------------------------------------------------------
create table if not exists public.train_runs (                -- one row per train per service day
  service_date  date not null,
  network       text not null check (network in ('ld', 'cer')),
  train         text not null,
  product       smallint,
  type          text,
  origin        text,
  dest          text,
  dest_region   text,
  line_key      text,
  sched_dep     smallint,                        -- minutes after midnight (GTFS, LD only)
  sched_arr     smallint,
  first_seen    timestamptz,
  last_seen     timestamptz,
  samples       integer not null default 0,
  delay_sum     integer not null default 0,
  max_delay     integer,
  last_delay    integer,
  final_delay   integer,                         -- delay when it reached its destination
  max_kmh       real,
  cancelled     boolean not null default false,
  finished      boolean not null default false,
  primary key (service_date, network, train)
);
create index if not exists train_runs_last_seen on public.train_runs (last_seen);
create index if not exists train_runs_train on public.train_runs (network, train, service_date desc);

create table if not exists public.daily_line_stats (          -- long windows (1M…YTD) read this
  service_date  date not null,
  network       text not null,
  type          text not null,
  line_key      text not null,
  dest_region   text not null default '',
  runs          integer not null,                -- ran (not cancelled)
  cancelled     integer not null,
  late5         integer not null,
  late15        integer not null,
  delay_sum     integer not null,                -- sum of max(0, final delay)
  max_delay     integer,
  max_kmh       real,
  b0 integer not null, b1 integer not null, b2 integer not null,   -- delay buckets: ≤0, 1–4, 5–14,
  b3 integer not null, b4 integer not null, b5 integer not null,   -- 15–29, 30–59, 60+
  primary key (service_date, network, type, line_key, dest_region)
);

create table if not exists public.scheduled_days (            -- trains scheduled per day (GTFS)
  service_date  date not null,
  type          text not null,
  dest_region   text not null default '',
  n             integer not null,
  primary key (service_date, type, dest_region)
);

create table if not exists public.hourly_stats (              -- busiest hours
  hour          timestamptz not null,            -- start of the hour
  type          text not null,
  cycles        integer not null default 0,
  obs           integer not null default 0,      -- trains × cycles
  delay_sum     integer not null default 0,
  delayed5      integer not null default 0,
  delayed15     integer not null default 0,
  primary key (hour, type)
);

create table if not exists public.snapshots (                 -- 5-minute series for 1D/7D charts
  ts            timestamptz not null,
  type          text not null,
  region        text not null default '',
  trains        integer not null,
  delayed5      integer not null,
  delayed15     integer not null,
  delay_sum     integer not null,
  primary key (ts, type, region)
);

create table if not exists public.incidents (
  id            text primary key,
  source        text not null check (source in ('adif', 'derivado', 'renfe')),
  level         text not null check (level in ('grave', 'leve', 'info')),
  major         boolean not null default false,
  title         text,
  body          text,
  scope         text,
  path          jsonb,                           -- [[lat, lon], …] section on the map
  trains        text[],
  active        boolean not null default true,
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now()
);
create index if not exists incidents_first_seen on public.incidents (first_seen);
create index if not exists incidents_active on public.incidents (active) where active;

create table if not exists public.proximity_events (          -- experimental; see requirements §2.5
  id            bigint generated always as identity primary key,
  ts            timestamptz not null default now(),
  train_a       text not null,                   -- follower
  train_b       text not null,                   -- leader
  dist_m        real,
  required_m    real,
  kmh_a         real,
  kmh_b         real,
  lat           double precision,
  lon           double precision
);
create index if not exists proximity_events_ts on public.proximity_events (ts);

-- Live snapshot (the /api/estado payload), also published to R2. Fallback when R2 isn't reachable.
create table if not exists public.live_state (
  id          smallint primary key default 1 check (id = 1),
  payload     jsonb not null,
  updated_at  timestamptz not null default now()
);

-- Municipalities for place search ("Las Rozas de Madrid"), loaded by the daily job.
create extension if not exists pg_trgm;
create table if not exists public.places (
  name        text not null,
  name_norm   text not null,                    -- lower case, no accents
  province    text,
  lat         double precision not null,
  lon         double precision not null,
  primary key (name, lat, lon)
);
create index if not exists places_name_trgm on public.places using gin (name_norm gin_trgm_ops);

-- Real track path between consecutive stops (from assets/rail.json, OpenStreetMap), loaded by the daily job.
create table if not exists public.rail_pairs (
  pair        text primary key,                 -- "04040-17000" (codes sorted)
  pts         jsonb not null                    -- [lat, lon, lat, lon, …]
);

create table if not exists public.meta (
  key    text primary key,
  value  text
);

-- -------------------------------------------------------------------------------------
-- Row Level Security: anyone may read public data; only the service_role (collector) writes.
-- service_role bypasses RLS, so no write policies are needed.
-- -------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'stations', 'gtfs_calendar', 'gtfs_calendar_dates', 'gtfs_trips', 'gtfs_stop_times', 'gtfs_shapes', 'cercanias_lines',
    'live_trains', 'cancellations', 'source_status', 'train_runs', 'daily_line_stats', 'scheduled_days',
    'hourly_stats', 'snapshots', 'incidents', 'proximity_events', 'live_state', 'places', 'rail_pairs'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'public read') then
      execute format('create policy "public read" on public.%I for select to anon, authenticated using (true)', t);
    end if;
  end loop;
end $$;
alter table public.meta enable row level security;            -- no policy: internal only

-- -------------------------------------------------------------------------------------
-- Functions
-- -------------------------------------------------------------------------------------

-- Does a GTFS service run on a date?
create or replace function public.runs_on(p_service_id text, p_date date)
returns boolean language sql stable as $$
  select coalesce(
    (select added from public.gtfs_calendar_dates where service_id = p_service_id and date = p_date),
    (select p_date between start_date and end_date and days[extract(isodow from p_date)::int]
       from public.gtfs_calendar where service_id = p_service_id),
    false)
$$;

-- "Llega tarde el X % de los días": punctuality of one train over the last N days (finished days only).
create or replace function public.train_punctuality(p_network text, p_train text, p_days integer default 30)
returns json language sql stable as $$
  with r as (
    select * from public.train_runs
    where network = p_network and train = p_train
      and service_date >= (now() at time zone 'Europe/Madrid')::date - p_days
      and (service_date < (now() at time zone 'Europe/Madrid')::date or finished or cancelled)
  ), ran as (select coalesce(final_delay, last_delay) as d from r where not cancelled and coalesce(final_delay, last_delay) is not null)
  select json_build_object(
    'dias',          (select count(*) from r),
    'recorridos',    (select count(*) from ran),
    'cancelados',    (select count(*) from r where cancelled),
    'tarde5',        (select round(100.0 * count(*) filter (where d >= 5) / nullif(count(*), 0)) from ran),
    'tarde15',       (select round(100.0 * count(*) filter (where d >= 15) / nullif(count(*), 0)) from ran),
    'retrasoMedio',  (select round(avg(greatest(d, 0))::numeric, 1) from ran)
  )
$$;

-- Scheduled LD/MD departures (or arrivals) at a station, for the departure board.
-- Live delays/cancellations are merged by the caller from live_trains / cancellations.
create or replace function public.station_timetable(p_code text, p_kind text default 'salidas', p_from_min integer default null, p_to_min integer default null)
returns table (train text, trip_id text, product smallint, route_name text, sched_min integer, other_station text, service_date date)
language sql stable as $$
  with now_m as (
    select (now() at time zone 'Europe/Madrid')::date as today,
           (extract(hour from now() at time zone 'Europe/Madrid') * 60 + extract(minute from now() at time zone 'Europe/Madrid'))::int as m
  ), d as (
    select today as day, 0 as shift from now_m union all select today - 1, -1440 from now_m
  )
  select t.train, t.trip_id, t.product, t.route_name,
         (case when p_kind = 'llegadas' then st.arr_min else st.dep_min end) + d.shift as sched_min,
         (case when p_kind = 'llegadas' then first_st.station else last_st.station end) as other_station,
         d.day
  from public.gtfs_stop_times st
  join public.gtfs_trips t on t.trip_id = st.trip_id and t.network = 'ld'
  join lateral (select station from public.gtfs_stop_times x where x.trip_id = st.trip_id order by seq asc limit 1) first_st on true
  join lateral (select station from public.gtfs_stop_times x where x.trip_id = st.trip_id order by seq desc limit 1) last_st on true
  cross join d cross join now_m
  where st.station = p_code
    and (case when p_kind = 'llegadas' then st.station <> first_st.station else st.station <> last_st.station end)
    and (case when p_kind = 'llegadas' then st.arr_min else st.dep_min end) is not null
    and (case when p_kind = 'llegadas' then st.arr_min else st.dep_min end) + d.shift
        between coalesce(p_from_min, now_m.m - 30) and coalesce(p_to_min, now_m.m + 180)
    and public.runs_on(t.service_id, d.day)
  order by sched_min
$$;

-- Aggregate one day of train_runs into daily_line_stats.
create or replace function public.rollup_day(p_date date)
returns void language sql as $$
  delete from public.daily_line_stats where service_date = p_date;
  insert into public.daily_line_stats (service_date, network, type, line_key, dest_region, runs, cancelled, late5, late15,
                                       delay_sum, max_delay, max_kmh, b0, b1, b2, b3, b4, b5)
  select service_date, network, coalesce(type, ''), coalesce(line_key, ''), coalesce(dest_region, ''),
    count(*) filter (where not cancelled),
    count(*) filter (where cancelled),
    count(*) filter (where not cancelled and coalesce(final_delay, last_delay) >= 5),
    count(*) filter (where not cancelled and coalesce(final_delay, last_delay) >= 15),
    coalesce(sum(greatest(coalesce(final_delay, last_delay, 0), 0)) filter (where not cancelled), 0),
    max(max_delay) filter (where not cancelled),
    max(max_kmh),
    count(*) filter (where not cancelled and coalesce(final_delay, last_delay) <= 0),
    count(*) filter (where not cancelled and coalesce(final_delay, last_delay) between 1 and 4),
    count(*) filter (where not cancelled and coalesce(final_delay, last_delay) between 5 and 14),
    count(*) filter (where not cancelled and coalesce(final_delay, last_delay) between 15 and 29),
    count(*) filter (where not cancelled and coalesce(final_delay, last_delay) between 30 and 59),
    count(*) filter (where not cancelled and coalesce(final_delay, last_delay) >= 60)
  from public.train_runs
  where service_date = p_date and (cancelled or last_delay is not null)
  group by service_date, network, coalesce(type, ''), coalesce(line_key, ''), coalesce(dest_region, '');
$$;

-- Nightly: roll up finished days, then apply retention. Keeps the database under the free 500 MB.
create or replace function public.maintenance()
returns void language plpgsql as $$
declare
  d date;
  today date := (now() at time zone 'Europe/Madrid')::date;
begin
  for d in
    select distinct r.service_date from public.train_runs r
    where r.service_date < today
      and not exists (select 1 from public.daily_line_stats s where s.service_date = r.service_date)
  loop
    perform public.rollup_day(d);
  end loop;

  delete from public.snapshots        where ts < now() - interval '7 days';
  delete from public.train_runs       where network = 'cer' and service_date < today - 90;
  delete from public.train_runs       where network = 'ld'  and service_date < today - 730;
  delete from public.live_trains      where last_seen < now() - interval '2 hours';
  delete from public.cancellations    where service_date < today - 2;
  delete from public.hourly_stats     where hour < now() - interval '400 days';
  update public.incidents set active = false where active and last_seen < now() - interval '15 minutes';
end $$;

-- Readers may call the read-only helpers; maintenance stays internal.
revoke all on function public.maintenance() from public, anon, authenticated;
revoke all on function public.rollup_day(date) from public, anon, authenticated;
grant execute on function public.runs_on(text, date) to anon, authenticated;
grant execute on function public.train_punctuality(text, text, integer) to anon, authenticated;
grant execute on function public.station_timetable(text, text, integer, integer) to anon, authenticated;

-- -------------------------------------------------------------------------------------
-- Scheduled jobs (Supabase Cron). Times are UTC.
-- -------------------------------------------------------------------------------------
select cron.unschedule(jobid) from cron.job where jobname = 'trenestado-maintenance';
select cron.schedule('trenestado-maintenance', '15 2 * * *', $$select public.maintenance()$$);

-- After deploying the "collector" Edge Function (docs/deploy.md), store the project URL in Vault, generate the
-- collector's shared secret inside the database (the function reads it from Vault too, so nobody copies it),
-- then schedule the collector every minute:
--
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'cron_secret');
--
--   select cron.schedule('trenestado-collector', '* * * * *', $$
--     select net.http_post(
--       url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/collector',
--       headers := jsonb_build_object('x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
--                                     'Content-Type', 'application/json'),
--       body    := '{}'::jsonb, timeout_milliseconds := 55000)
--   $$);
--
-- Timetables are loaded daily by GitHub Actions (.github/workflows/daily.yml), not by Supabase.
