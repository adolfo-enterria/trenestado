# Trenestado — Implementation plan (MVP)

Goal: a localhost MVP with Vía libre parity (requirements §1) plus search/tracking, alarms, speed,
proximity anomalies, major-incident alarm and a statistics tab (§2), storing history in a
Supabase-portable schema (§3).

## Stack
- **Node 24**, ESM, plain JavaScript (no build step), `express` for HTTP.
- **SQLite via built-in `node:sqlite`** locally — schema kept Postgres-compatible (`docs/schema.sql`
  later for Supabase). All DB access goes through `server/db.js` so the adapter can be swapped.
- Frontend: vanilla JS modules, **Leaflet** (map, dark CARTO tiles) and **Chart.js** served from
  `node_modules`. No bundler.
- `adm-zip` for GTFS, `es-atlas` + `topojson-client` for autonomous-community polygons (region of
  each station by point-in-polygon).

## Layout
```
server/
  index.js        express app, routes, starts collector
  config.js       URLs, intervals, thresholds
  sources/        renfe-live.js, gtfs-static.js, gtfs-rt.js, renfe-alerts.js, adif.js
  geo.js          haversine, bearing, regions (point-in-polygon)
  products.js     Renfe product codes → types/names
  state.js        in-memory live state (trains, speeds, incidents, source status)
  collector.js    polling loops → state + persistence
  detect.js       derived incidents, proximity anomalies, stopped trains
  db.js           SQLite schema + queries (train_runs, hourly_stats, snapshots, incidents, proximity_events)
  stats.js        stats queries per window/filters
public/
  index.html, css/app.css
  js/app.js (router, polling), map.js, panels.js, train.js, stats.js, alarms.js, search.js, util.js
docs/
data/             sqlite db + cached gtfs (gitignored)
```

## API
| Endpoint | Purpose |
|---|---|
| `GET /api/estado` | live snapshot: trains (pos, delay, speed, vector, product, stations), stations used, incidents, proximity anomalies, source status |
| `GET /api/red` | network segments (from GTFS consecutive stops) |
| `GET /api/tren/:n` | train detail: live + GTFS itinerary with ETAs + status (cancelled/scheduled/finished) + 30-day history |
| `GET /api/buscar?q=` | trains/stations matching |
| `GET /api/stats?w=&tipos=&region=` | KPIs, series, rankings |
| `GET /api/fuentes` | source status |

## Build order
1. Scaffold, config, products, geo/regions.
2. GTFS static loader (stations, trips by train number, stop times, network segments, scheduled/day).
3. Live collector: flotaLD → normalized trains, speed/vector, region; GTFS-RT (cancellations, delays);
   Renfe alerts; Adif best-effort.
4. Detection: stopped trains, mass cancellations, Adif keyword severity → incidents; proximity anomalies.
5. Persistence: train_runs upsert each cycle, 5-min snapshots, hourly rollup, retention cleanup.
6. API endpoints + stats queries.
7. Frontend: map home (parity), panels, card; then search/train page, Mis trenes + alarms, stats tab,
   sources tab.
8. Verify end-to-end in the browser against live data; fix; write README.

## MVP status (2026-10-31)

Built and checked in the browser against live data:

| Area | Status |
|---|---|
| §1 Vía libre parity: map, smooth motion, labels, chips, summary, legend, card, delayed arrivals + zones, incidents on map | ✅ |
| Base map | ✅ self-hosted land polygons (`/api/tierra`, es-atlas + Natural Earth); CARTO tiles needed an API key |
| Search (train number with/without prefix/zeros, station name) | ✅ |
| Train page: live status, GTFS itinerary + ETAs, mini map, 30-day history, share link | ✅ |
| Alarms: delay, cancel, depart, N min before arrival, arrival, stopped, route incident, proximity | ✅ in-page (toast + sound + Notification API) while a tab is open |
| Global alarms: major incidents (by region), proximity | ✅ |
| Speed (server-side, smoothed, jitter-filtered) | ✅ |
| Proximity anomalies (experimental, logged) | ✅ |
| Derived incidents: mass cancellations per corridor, trains stopped between stations | ✅ |
| Stats: KPIs, series, distribution, by type, busiest hours, line rankings, worst/most-often-late trains; windows Ahora…YTD; type + region filters | ✅ (long windows fill up as data is collected) |
| Persistence: SQLite, Supabase-portable schema, 7-day snapshot retention | ✅ |

Added 2026-10-31 (second pass):

| Area | Status |
|---|---|
| Cercanías (map, card, train page, stats, history, duplicate removal, partial-snapshot grace period) | ✅ |
| Station departure/arrival boards (LD timetable + live, Cercanías official board) | ✅ |
| "Llega tarde el X % de los días" (train page, card, search) | ✅ |
| Adif polled once per minute; collector interval configurable (`LIVE_SECONDS`, default 60) | ✅ |
| `supabase/schema.sql` (tables, RLS, functions, nightly roll-up/retention job) | ✅ validated on Postgres (PGlite), re-runnable |
| `docs/free-tier.md` (free architecture and limits) | ✅ |

Next steps: port the collector to a Supabase Edge Function and the API to Postgres functions + Cloudflare
Pages Functions (docs/free-tier.md §5); English UI; automated tests.
