// Collector (Supabase Edge Function, called every minute by Supabase Cron). Port of server/collector.js +
// server/detect.js: fetches Renfe/Adif, updates live_trains/train_runs/incidents/…, detects stopped trains,
// mass cancellations and proximity anomalies, and publishes the /api/estado snapshot to R2 (+ live_state).
// State between runs (previous position for speed, stopped-since, run date) lives in live_trains.
import {
  sql, r2Put, json, stations, shortName, lineKey, nearestStationKm, pathForStops, haversineKm, bearingDeg, headingDiff,
  madridDate, madridMinutes, hhmm, typeOf, productName, fetchFleet, fetchCercanias, fetchTripUpdatesLD, fetchAdif, fetchNotices,
  DELAY, STOPPED, PROXIMITY, type Station,
} from "../_shared/core.ts";
import { adifPath } from "../_shared/rail.ts";

type Live = Record<string, unknown> & { id: string; n: string; red: "ld" | "cer"; tipo: string; lat: number; lon: number; ts: number; ret: number };
type Prev = { id: string; network: string; lat: number; lon: number; fix_at: Date; kmh: number | null; heading: number | null; vlat: number; vlon: number;
  run_date: string | Date; stopped_since: Date | null; delay_at_stop: number | null; near_dest: boolean; last_seen: Date; extra: Record<string, unknown> };

const ok = <T,>(r: PromiseSettledResult<T>): r is PromiseFulfilledResult<T> => r.status === "fulfilled";
const errMsg = (r: PromiseSettledResult<unknown>) => (r.status === "rejected" ? String((r.reason as Error)?.message || r.reason).slice(0, 300) : null);
const dateStr = (d: string | Date) => (typeof d === "string" ? d.slice(0, 10) : madridDate(d));

let nucleoCache: Map<string, string> | null = null;
async function nucleos() {
  if (!nucleoCache) nucleoCache = new Map((await sql<{ nucleo: string; nucleo_name: string }[]>`select distinct nucleo, nucleo_name from public.cercanias_lines`).map((r) => [r.nucleo, r.nucleo_name]));
  return nucleoCache;
}

/** Speed/heading from the previous reference fix (kept in extra.ref so short intervals use a longer baseline). */
function motion(p: Prev | undefined, lat: number, lon: number, ts: number, maxKmh: number) {
  const ref = (p?.extra?.ref as [number, number, number]) || (p ? [p.lat, p.lon, +p.fix_at] : null);
  let kmh = p?.kmh ?? null, heading = p?.heading ?? null, vlat = p?.vlat ?? 0, vlon = p?.vlon ?? 0, newRef = ref || [lat, lon, ts];
  if (ref && ts > ref[2]) {
    const dt = (ts - ref[2]) / 1000;
    if (dt >= 10 && dt <= 300) {
      const km = haversineKm(ref[0], ref[1], lat, lon), v = (km / dt) * 3600;
      if (v <= maxKmh) { // above the line's top speed (310 km/h HSL, 160 km/h Cercanías) it's GPS/feed jitter
        kmh = kmh == null ? v : 0.6 * v + 0.4 * kmh;
        if (km > 0.03) heading = bearingDeg(ref[0], ref[1], lat, lon);
        const moving = kmh >= STOPPED.kmh;
        vlat = moving ? (lat - ref[0]) / dt : 0; vlon = moving ? (lon - ref[1]) / dt : 0;
      }
      newRef = [lat, lon, ts];
    } else if (dt > 300) { kmh = null; vlat = vlon = 0; newRef = [lat, lon, ts]; }
  }
  return { kmh, heading, vlat, vlon, ref: newRef };
}

async function run() {
  const now = Date.now(), minute = Math.floor(now / 60000);
  const today = madridDate(), yday = madridDate(new Date(now - 86400_000)), nowMin = madridMinutes();
  const [ld, cer, tu, adif, notices] = await Promise.allSettled([
    fetchFleet(), fetchCercanias(), fetchTripUpdatesLD(), fetchAdif(), minute % 5 === 0 ? fetchNotices() : Promise.resolve(null),
  ]);
  const st = await stations();
  const nuc = await nucleos();
  const prevRows = (await sql`select * from public.live_trains`) as unknown as Prev[];
  const prev = new Map(prevRows.map((r) => [r.id, r]));

  // ---------- LD/MD: timetable trips for the trains in the feed ----------
  const ldFeed = ok(ld) ? ld.value.trains.filter((t: Live) => isFinite(t.lat) && isFinite(t.lon) && !(t.lat === 0 && t.lon === 0)) : [];
  const ldNums = [...new Set(ldFeed.map((t: Live) => t.n))] as string[];
  type TripRow = { train: string; trip_id: string; product: number | null; day: string; stops: [string, number | null, number | null][] };
  const tripRows = (ldNums.length ? await sql`
    select t.train, t.trip_id, t.product, d.day::text as day,
      (select json_agg(json_build_array(s.station, s.arr_min, s.dep_min) order by s.seq) from public.gtfs_stop_times s where s.trip_id = t.trip_id) as stops
    from public.gtfs_trips t cross join (values (${today}::date), (${yday}::date)) as d(day)
    where t.network = 'ld' and t.train = any(${ldNums}) and public.runs_on(t.service_id, d.day)` : []) as unknown as TripRow[];
  const tripsBy = new Map<string, typeof tripRows>();
  for (const r of tripRows) { if (!tripsBy.has(r.train)) tripsBy.set(r.train, []); tripsBy.get(r.train)!.push(r); }
  const tripOf = (n: string, runDate?: string) => {
    const list = tripsBy.get(n) || [];
    if (runDate) { const t = list.find((x) => x.day === runDate); if (t) return t; }
    const t = list.find((x) => x.day === today), y = list.find((x) => x.day === yday);
    if (t && t.stops?.[0]?.[2] != null && t.stops[0][2]! <= nowMin + 60) return t;
    if (y && (y.stops?.at(-1)?.[1] ?? 0) >= 1440) return y;
    return t || null;
  };

  const trains = new Map<string, Live>(), present = new Set<string>();
  const liveRows: Record<string, unknown>[] = [], runRows: Record<string, unknown>[] = [];
  let noPosition = ok(ld) ? ld.value.trains.length - ldFeed.length : 0;

  for (const r of ldFeed) {
    const id = r.n, p = prev.get(id);
    present.add(id);
    const m = motion(p, r.lat, r.lon, r.ts, 320);
    const stopped = m.kmh != null && m.kmh < STOPPED.kmh;
    const stoppedSince = stopped ? (p?.stopped_since ? +p.stopped_since : r.ts) : null;
    const delayAtStop = stopped ? (p?.delay_at_stop ?? r.ret) : null;
    const trip = tripOf(r.n, p ? dateStr(p.run_date) : undefined);
    const runDate = p ? dateStr(p.run_date) : trip?.day || today;
    const stops = trip?.stops || [];
    const destStop = stops.find((s) => s[0] === r.des) || stops.at(-1);
    const dest = st.get(r.des);
    const nearStation = nearestStationKm(st, r.lat, r.lon) < 1.5;
    const nearDest = (p?.near_dest ?? false) || r.sig === r.des || r.ant === r.des;
    const t: Live = {
      id, n: r.n, red: "ld", p: r.p, tipo: typeOf(r.p), nom: productName(r.p), lat: r.lat, lon: r.lon, ts: r.ts,
      kmh: m.kmh == null ? null : Math.round(m.kmh), rumbo: m.heading == null ? null : Math.round(m.heading), vlat: m.vlat, vlon: m.vlon,
      ret: r.ret, ant: r.ant, sig: r.sig, ori: r.ori, des: r.des, hs: r.nextAt ? r.nextAt.slice(11, 16) : null,
      lleg: hhmm(destStop?.[1] ?? null), sal: hhmm(stops[0]?.[2] ?? null), acc: r.acc, mat: r.mat,
      dreg: dest?.region ?? null, dprov: dest?.province ?? null, parado: stoppedSince ? Math.round((r.ts - stoppedSince) / 60000) : 0,
      entre: r.ant !== r.sig && !nearStation,
      _near: nearStation, _line: lineKey(st, r.ori, r.des), _trip: trip?.trip_id ?? null,
    };
    trains.set(id, t);
    liveRows.push(liveRow(t, runDate, m, stoppedSince, delayAtStop, nearDest, now));
    runRows.push(runRow(t, runDate, stops, now));
  }

  if (ok(cer)) for (const r of cer.value) {
    if (!isFinite(r.lat) || !isFinite(r.lon) || (r.lat === 0 && r.lon === 0)) continue;
    // Rodalies R14/R16/R2S, Bilbao, Cantabria… appear in both feeds: keep the LD copy (it has the timetable)
    const twin = trains.get(r.n);
    if (twin && (twin.ori === r.ori || twin.des === r.des || haversineKm(twin.lat, twin.lon, r.lat, r.lon) < 3)) continue;
    const id = "c" + r.n, p = prev.get(id);
    present.add(id);
    const m = motion(p, r.lat, r.lon, now, 160); // no fix time in this feed: the fetch time stands in for it
    const stopped = m.kmh != null && m.kmh < STOPPED.kmh;
    const stoppedSince = stopped ? (p?.stopped_since ? +p.stopped_since : now) : null;
    const runDate = p ? dateStr(p.run_date) : today;
    const dest = st.get(r.des);
    const nearStation = nearestStationKm(st, r.lat, r.lon) < 0.6;
    const nearDest = (p?.near_dest ?? false) || r.sig === r.des || r.act === r.des;
    const nucleo = nuc.get(r.nucleo) || "Cercanías";
    const t: Live = {
      id, n: r.n, red: "cer", p: null, tipo: "cer", nom: `Cercanías ${r.line}`.trim(), linea: r.line, nucleo,
      lat: r.lat, lon: r.lon, ts: now, kmh: m.kmh == null ? null : Math.round(m.kmh), rumbo: m.heading == null ? null : Math.round(m.heading),
      vlat: m.vlat, vlon: m.vlon, ret: r.ret, ant: r.act, sig: r.sig, ori: r.ori, des: r.des,
      hs: r.nextAt ? String(r.nextAt).slice(11, 16) : null, lleg: null, sal: null, acc: r.acc, via: r.via,
      dreg: dest?.region ?? null, dprov: dest?.province ?? null, parado: stoppedSince ? Math.round((now - stoppedSince) / 60000) : 0,
      entre: r.act !== r.sig && !nearStation,
      _near: nearStation, _line: `${nucleo} ${r.line}`.trim(), _trip: r.tripId || null,
    };
    trains.set(id, t);
    liveRows.push(liveRow(t, runDate, m, stoppedSince, stopped ? (p?.delay_at_stop ?? r.ret) : null, nearDest, now));
    runRows.push(runRow(t, runDate, [], now));
  }

  // trains missing from this snapshot: a failed feed keeps its trains; partial snapshots get a 150 s grace
  const gone: { date: string; net: string; n: string }[] = [], drop: string[] = [];
  for (const p of prevRows) {
    if (present.has(p.id)) continue;
    const feedOk = p.network === "ld" ? ok(ld) : ok(cer);
    const t = p.extra?.t as Live | undefined;
    if (!feedOk || now - +p.last_seen < 150_000) { if (t) trains.set(p.id, { ...t, stale: true }); continue; }
    if (p.near_dest && t) gone.push({ date: dateStr(p.run_date), net: p.network, n: t.n });
    drop.push(p.id);
  }

  // ---------- cancellations (GTFS-RT, LD/MD only) ----------
  const cancelled = ok(tu) ? tu.value.cancelled : [];
  const cRows = cancelled.length ? await sql<{ train: string; day: string; product: number | null; first: [string, number, number]; last: [string, number, number]; codes: string[] }[]>`
    select t.train, c.day::text as day, t.product,
      (select json_build_array(s.station, s.arr_min, s.dep_min) from public.gtfs_stop_times s where s.trip_id = t.trip_id order by s.seq asc limit 1) as first,
      (select json_build_array(s.station, s.arr_min, s.dep_min) from public.gtfs_stop_times s where s.trip_id = t.trip_id order by s.seq desc limit 1) as last,
      (select json_agg(s.station order by s.seq) from public.gtfs_stop_times s where s.trip_id = t.trip_id) as codes
    from unnest(${cancelled.map((c) => c.train)}::text[], ${cancelled.map((c) => c.date)}::date[]) as c(train, day)
    join public.gtfs_trips t on t.train = c.train and t.network = 'ld' and public.runs_on(t.service_id, c.day)` : [];

  // ---------- derived incidents ----------
  const derived: Record<string, unknown>[] = [];
  const byLine = new Map<string, { trains: string[]; codes: string[] }>();
  for (const c of cRows) {
    if (c.day !== today || !c.first || !c.last) continue;
    const k = lineKey(st, c.first[0], c.last[0]);
    if (!byLine.has(k)) byLine.set(k, { trains: [], codes: c.codes });
    if (!byLine.get(k)!.trains.includes(c.train)) byLine.get(k)!.trains.push(c.train);
  }
  for (const [k, { trains: ts, codes }] of byLine) if (ts.length >= 3) derived.push({
    id: `der-cancel-${today}-${k}`, source: "derivado", level: "grave", major: true, title: `${ts.length} trenes cancelados hoy en ${k}`,
    text: [`Renfe marca como cancelados los trenes ${ts.slice(0, 12).join(", ")}${ts.length > 12 ? "…" : ""}.`], scope: k, codes,
  });
  for (const t of trains.values()) {
    if (t.red !== "ld" || t.stale || !t.entre || (t.parado as number) < STOPPED.majorMinutes) continue;
    const p = liveRows.find((r) => r.id === t.id)!;
    const rise = t.ret - ((p.delay_at_stop as number) ?? t.ret), major = rise >= STOPPED.majorDelayRise;
    derived.push({
      id: `der-stop-${t.n}-${+(p.stopped_since as Date)}`, source: "derivado", level: major ? "grave" : "leve", major,
      title: `Tren ${t.n} detenido ${t.parado} min entre ${shortName(st, t.ant as string)} y ${shortName(st, t.sig as string)}`,
      text: [`Lleva ${t.parado} minutos parado fuera de estación; su retraso ha subido ${Math.max(0, rise)} min desde que se detuvo.`],
      scope: `${shortName(st, t.ori as string)} → ${shortName(st, t.des as string)}`, codes: [t.ant, t.sig], trains: [t.n],
    });
  }
  const adifList = ok(adif) ? adif.value : [];
  const incidents = [...adifList, ...derived] as { id: string; source: string; level: string; major: boolean; title: string; text: string[]; scope: string; codes?: string[]; trains?: string[]; path?: unknown }[];
  const known = incidents.length ? new Map((await sql<{ id: string; path: unknown }[]>`select id, path from public.incidents where id = any(${incidents.map((i) => i.id)})`).map((r) => [r.id, r.path])) : new Map();
  for (const i of incidents) {
    if (known.get(i.id)) { i.path = known.get(i.id); continue; }
    if (i.codes) i.path = await pathForStops(st, i.codes);
    else if (i.source === "adif") i.path = await adifPath(st, i).catch(() => null);
  }

  // ---------- proximity (experimental; LD only) ----------
  const [streakRow] = await sql<{ value: string }[]>`select value from public.meta where key = 'prox_streak'`;
  const streak = new Map<string, number>(Object.entries(streakRow ? JSON.parse(streakRow.value) : {}));
  const proximity = proximityAnomalies([...trains.values()].filter((t) => !t.stale), streak, now);

  // ---------- persist ----------
  const hour = new Date(Math.floor(now / 3600_000) * 3600_000);
  const byType = new Map<string, { obs: number; delay_sum: number; delayed5: number; delayed15: number }>();
  for (const t of trains.values()) {
    if (t.stale) continue;
    const h = byType.get(t.tipo) || { obs: 0, delay_sum: 0, delayed5: 0, delayed15: 0 };
    h.obs++; h.delay_sum += Math.max(0, t.ret); if (t.ret >= DELAY.leve) h.delayed5++; if (t.ret >= DELAY.grave) h.delayed15++;
    byType.set(t.tipo, h);
  }
  const statusRows = [
    src("renfe", ld, ok(ld) ? { fleetUpdated: ld.value.updated } : {}), src("cercanias", cer, ok(cer) ? { count: cer.value.length } : {}),
    src("gtfsRt", tu, ok(tu) ? { cancelled: tu.value.cancelled.length } : {}), src("adif", adif, ok(adif) ? { count: adif.value.length } : {}),
    ...(minute % 5 === 0 ? [src("renfeAlerts", notices, ok(notices) && notices.value ? { count: notices.value.length } : {})] : []),
  ];

  await sql.begin(async (tx) => {
    if (liveRows.length) await tx`insert into public.live_trains ${tx(liveRows)}
      on conflict (id) do update set network = excluded.network, train = excluded.train, type = excluded.type, product = excluded.product, line = excluded.line,
        line_key = excluded.line_key, lat = excluded.lat, lon = excluded.lon, fix_at = excluded.fix_at, kmh = excluded.kmh, heading = excluded.heading,
        vlat = excluded.vlat, vlon = excluded.vlon, delay_min = excluded.delay_min, prev_station = excluded.prev_station, next_station = excluded.next_station,
        origin = excluded.origin, dest = excluded.dest, dest_region = excluded.dest_region, run_date = excluded.run_date, stopped_since = excluded.stopped_since,
        delay_at_stop = excluded.delay_at_stop, near_dest = excluded.near_dest, last_seen = excluded.last_seen, extra = excluded.extra`;
    if (drop.length) await tx`delete from public.live_trains where id = any(${drop})`;
    if (runRows.length) await tx`insert into public.train_runs ${tx(runRows)}
      on conflict (service_date, network, train) do update set last_seen = excluded.last_seen, samples = train_runs.samples + 1,
        delay_sum = train_runs.delay_sum + excluded.delay_sum, max_delay = greatest(train_runs.max_delay, excluded.max_delay), last_delay = excluded.last_delay,
        max_kmh = greatest(coalesce(train_runs.max_kmh, 0), coalesce(excluded.max_kmh, 0)), line_key = excluded.line_key, dest_region = excluded.dest_region, cancelled = false`;
    for (const g of gone) await tx`update public.train_runs set finished = true, final_delay = last_delay where service_date = ${g.date} and network = ${g.net} and train = ${g.n} and not finished`;
    for (const [type, h] of byType) await tx`insert into public.hourly_stats (hour, type, cycles, obs, delay_sum, delayed5, delayed15) values (${hour}, ${type}, 1, ${h.obs}, ${h.delay_sum}, ${h.delayed5}, ${h.delayed15})
      on conflict (hour, type) do update set cycles = hourly_stats.cycles + 1, obs = hourly_stats.obs + excluded.obs, delay_sum = hourly_stats.delay_sum + excluded.delay_sum,
        delayed5 = hourly_stats.delayed5 + excluded.delayed5, delayed15 = hourly_stats.delayed15 + excluded.delayed15`;
    if (minute % 5 === 0) {
      const g = new Map<string, { trains: number; delayed5: number; delayed15: number; delay_sum: number }>();
      for (const t of trains.values()) {
        if (t.stale) continue;
        const k = t.tipo + "|" + (t.dreg || "");
        const s = g.get(k) || { trains: 0, delayed5: 0, delayed15: 0, delay_sum: 0 };
        s.trains++; if (t.ret >= DELAY.leve) s.delayed5++; if (t.ret >= DELAY.grave) s.delayed15++; s.delay_sum += Math.max(0, t.ret);
        g.set(k, s);
      }
      const ts5 = new Date(Math.floor(now / 300_000) * 300_000);
      const rows = [...g].map(([k, s]) => ({ ts: ts5, type: k.split("|")[0], region: k.split("|")[1], ...s }));
      if (rows.length) await tx`insert into public.snapshots ${tx(rows)} on conflict (ts, type, region) do nothing`;
    }
    if (cancelled.length) {
      await tx`insert into public.cancellations ${tx(cancelled.map((c) => ({ service_date: c.date, train: c.train, trip_id: c.tripId })))} on conflict (service_date, trip_id) do nothing`;
      const seen = new Set<string>();
      const rows = cRows.filter((c) => c.first && c.last && !seen.has(c.day + c.train) && seen.add(c.day + c.train)).map((c) => ({
        service_date: c.day, network: "ld", train: c.train, product: c.product, type: c.product != null ? typeOf(c.product) : null,
        origin: c.first[0], dest: c.last[0], dest_region: st.get(c.last[0])?.region ?? null, line_key: lineKey(st, c.first[0], c.last[0]),
        sched_dep: c.first[2], sched_arr: c.last[1], first_seen: new Date(now), last_seen: new Date(now), cancelled: true,
      }));
      if (rows.length) await tx`insert into public.train_runs ${tx(rows)}
        on conflict (service_date, network, train) do update set cancelled = case when train_runs.samples = 0 then true else train_runs.cancelled end,
          last_seen = greatest(train_runs.last_seen, excluded.last_seen)`;
    }
    for (const i of incidents) await tx`
      insert into public.incidents (id, source, level, major, title, body, scope, path, trains, active, first_seen, last_seen)
      values (${i.id}, ${i.source}, ${i.level}, ${i.major}, ${i.title}, ${i.text.join("\n")}, ${i.scope || ""}, ${i.path ? tx.json(i.path as never) : null}, ${i.trains ?? null}, true, now(), now())
      on conflict (id) do update set level = excluded.level, major = excluded.major, title = excluded.title, body = excluded.body, scope = excluded.scope,
        path = coalesce(incidents.path, excluded.path), trains = excluded.trains, active = true, last_seen = now()`;
    const ids = incidents.map((i) => i.id);
    await tx`update public.incidents set active = false where active and source = 'derivado' and not (id = any(${ids}))`;
    if (ok(adif)) await tx`update public.incidents set active = false where active and source = 'adif' and not (id = any(${ids}))`;
    for (const a of proximity.filter((x) => x.firstFired)) await tx`insert into public.proximity_events (train_a, train_b, dist_m, required_m, kmh_a, kmh_b, lat, lon)
      values (${a.follower}, ${a.leader}, ${a.distM}, ${a.requiredM}, ${a.kmh[0]}, ${a.kmh[1]}, ${a.lat}, ${a.lon})`;
    await tx`insert into public.meta (key, value) values ('prox_streak', ${JSON.stringify(Object.fromEntries(streak))}) on conflict (key) do update set value = excluded.value`;
    if (ok(notices) && notices.value) await tx`insert into public.meta (key, value) values ('renfe_notices', ${JSON.stringify(notices.value)}) on conflict (key) do update set value = excluded.value`;
    if (!(await tx`select 1 from public.meta where key = 'collecting_since'`).length) await tx`insert into public.meta (key, value) values ('collecting_since', ${String(now)})`;
    for (const s of statusRows) await tx`
      insert into public.source_status (name, ok, at, tried_at, error, detail) values (${s.name}, ${s.ok}, ${s.ok ? new Date(now) : null}, ${new Date(now)}, ${s.error}, ${tx.json(s.detail as never)})
      on conflict (name) do update set ok = excluded.ok, at = coalesce(excluded.at, source_status.at), tried_at = excluded.tried_at, error = excluded.error,
        detail = case when excluded.ok then excluded.detail else source_status.detail end`;
  });

  // ---------- snapshot for the map (/api/estado) ----------
  const payload = await snapshot(st, trains, proximity, noPosition, ok(ld) ? ld.value.updated : null, today);
  const body = JSON.stringify(payload);
  let r2 = false;
  try { r2 = await r2Put("live/estado.json", body, "application/json", "public, max-age=30"); } catch (e) { console.error("R2:", (e as Error).message); }
  await sql`insert into public.live_state (id, payload, updated_at) values (1, ${sql.json(payload as never)}, now()) on conflict (id) do update set payload = excluded.payload, updated_at = now()`;
  return { trains: trains.size, ld: ldFeed.length, cer: ok(cer) ? cer.value.length : 0, incidents: incidents.length, proximity: proximity.length, r2, ms: Date.now() - now,
    errors: Object.fromEntries(statusRows.filter((s) => !s.ok).map((s) => [s.name, s.error])) };

  function liveRow(t: Live, runDate: string, m: ReturnType<typeof motion>, stoppedSince: number | null, delayAtStop: number | null, nearDest: boolean, now: number) {
    const { _near, _line, _trip, ...pub } = t;
    return {
      id: t.id, network: t.red, train: t.n, type: t.tipo, product: (t.p as number) ?? null, line: (t.linea as string) ?? null, line_key: _line,
      lat: t.lat, lon: t.lon, fix_at: new Date(t.ts), kmh: t.kmh ?? null, heading: t.rumbo ?? null, vlat: t.vlat ?? 0, vlon: t.vlon ?? 0, delay_min: t.ret,
      prev_station: t.ant, next_station: t.sig, origin: t.ori, dest: t.des, dest_region: t.dreg ?? null, run_date: runDate,
      stopped_since: stoppedSince ? new Date(stoppedSince) : null, delay_at_stop: delayAtStop, near_dest: nearDest, last_seen: new Date(now),
      extra: sql.json({ t: pub, ref: m.ref, trip: _trip, near: _near } as never),
    };
  }
  function runRow(t: Live, runDate: string, stops: [string, number | null, number | null][], now: number) {
    return {
      service_date: runDate, network: t.red, train: t.n, product: (t.p as number) ?? null, type: t.tipo, origin: t.ori, dest: t.des,
      dest_region: t.dreg ?? null, line_key: t._line, sched_dep: stops[0]?.[2] ?? null, sched_arr: stops.at(-1)?.[1] ?? null,
      first_seen: new Date(now), last_seen: new Date(now), samples: 1, delay_sum: t.ret, max_delay: t.ret, last_delay: t.ret, max_kmh: t.kmh ?? null,
    };
  }
}

function src(name: string, r: PromiseSettledResult<unknown>, detail: Record<string, unknown>) {
  return { name, ok: r.status === "fulfilled", error: errMsg(r), detail };
}

function proximityAnomalies(list: Live[], streak: Map<string, number>, now: number) {
  const P = PROXIMITY;
  const cand = list.filter((t) => t.red === "ld" && t.kmh != null && (t.kmh as number) >= P.minKmh && t.rumbo != null && now - t.ts < P.maxFixAgeS * 1000 + 60_000 && !t._near);
  const seen = new Set<string>(), out: { id: string; follower: string; leader: string; distM: number; requiredM: number; kmh: number[]; lat: number; lon: number; firstFired: boolean }[] = [];
  for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) {
    const a = cand[i], b = cand[j];
    const same = (a.ant === b.ant && a.sig === b.sig) || a.sig === b.ant || b.sig === a.ant;
    if (!same || headingDiff(a.rumbo as number, b.rumbo as number) > P.maxHeadingDiff) continue;
    const t0 = Math.max(a.ts, b.ts);
    const pa = [a.lat + (a.vlat as number) * (t0 - a.ts) / 1000, a.lon + (a.vlon as number) * (t0 - a.ts) / 1000];
    const pb = [b.lat + (b.vlat as number) * (t0 - b.ts) / 1000, b.lon + (b.vlon as number) * (t0 - b.ts) / 1000];
    const dist = haversineKm(pa[0], pa[1], pb[0], pb[1]) * 1000;
    const toB = (Math.atan2(pb[1] - pa[1], pb[0] - pa[0]) * 180) / Math.PI;
    const aFollows = headingDiff((toB + 360) % 360, a.rumbo as number) < 90;
    const f = aFollows ? a : b, l = aFollows ? b : a, v = (f.kmh as number) / 3.6;
    const required = (v * v) / (2 * P.decel) + P.marginM;
    if (dist >= required) continue;
    if (dist < 100 && Math.abs((a.kmh as number) - (b.kmh as number)) < 10) continue; // coupled units, not two trains
    const key = [a.id, b.id].sort().join("|");
    seen.add(key);
    const s = (streak.get(key) || 0) + 1;
    streak.set(key, s);
    if (s < P.persistCycles) continue;
    out.push({ id: "prox-" + key, follower: f.id, leader: l.id, distM: Math.round(dist), requiredM: Math.round(required), kmh: [f.kmh as number, l.kmh as number],
      lat: (pa[0] + pb[0]) / 2, lon: (pa[1] + pb[1]) / 2, firstFired: s === P.persistCycles });
  }
  for (const k of [...streak.keys()]) if (!seen.has(k)) streak.delete(k);
  return out;
}

async function snapshot(st: Map<string, Station>, trains: Map<string, Live>, proximity: unknown[], noPosition: number, flotaHora: string | null, today: string) {
  const [inc, src, meta, canc] = await Promise.all([
    sql`select id, source, level, major, title, body, scope, path, trains, first_seen from public.incidents where active and source <> 'renfe'
        order by case level when 'grave' then 0 when 'leve' then 1 else 2 end, first_seen desc`,
    sql`select name, ok, at, tried_at, error, detail from public.source_status`,
    sql`select key, value from public.meta where key in ('gtfs_loaded_at', 'renfe_notices')`,
    sql`select distinct train from public.cancellations where service_date = ${today}`,
  ]);
  const m = new Map(meta.map((r) => [r.key, r.value]));
  const fuentes = Object.fromEntries(src.map((s) => [s.name, { ok: s.ok, at: s.at, triedAt: s.tried_at, error: s.error, ...(s.detail || {}) }]));
  const codes = new Set<string>();
  const trenes = [...trains.values()].map((t) => {
    const { _near, _line, _trip, stale, ...pub } = t;
    for (const c of [t.ant, t.sig, t.ori, t.des] as string[]) codes.add(c);
    return pub;
  });
  const est: Record<string, unknown> = {};
  for (const c of codes) { const s = st.get(c); est[c] = s ? { n: s.name, c: shortName(st, c), lat: s.lat, lon: s.lon, reg: s.region, prov: s.province } : { n: shortName(st, c), c: shortName(st, c) }; }
  return {
    generado: new Date().toISOString(), flotaHora, sinPosicion: noPosition, fuentes, adifHora: fuentes.adif?.at ?? null, red: m.get("gtfs_loaded_at") ?? null,
    trenes, est,
    incidencias: inc.map((i) => ({ id: i.id, source: i.source, level: i.level, major: i.major, title: i.title, text: (i.body || "").split("\n").filter(Boolean),
      scope: i.scope, path: i.path, trains: i.trains, seen: +new Date(i.first_seen) })),
    avisosRenfe: m.get("renfe_notices") ? JSON.parse(m.get("renfe_notices")!).length : 0,
    proximidad: proximity, cancelados: canc.map((c) => c.train),
  };
}

// Only Supabase Cron may run this (it sends the shared secret); otherwise anyone could burn invocations.
const SECRET = Deno.env.get("CRON_SECRET");
Deno.serve(async (req) => {
  if (!SECRET || req.headers.get("x-cron-secret") !== SECRET) return json({ error: "No autorizado" }, 401);
  try { return json(await run()); }
  catch (e) { console.error(e); return json({ error: String((e as Error)?.message || e) }, 500); }
});
