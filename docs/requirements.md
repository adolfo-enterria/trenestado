# Trenestado — Requirements

A live map and statistics site for Spain's rail network, inspired by
[Vía libre](https://vialibre.soft-flow.app/), plus train tracking, alarms and historical statistics.

UI language: **Spanish** (same audience as Vía libre). Code and docs: English.

---

## 0. Data sources (verified 2026-10-31)

| Source | URL | Gives us | Notes |
|---|---|---|---|
| Renfe live map, long/medium distance | `https://tiempo-real.renfe.com/renfe-visor/flotaLD.json` | ~100–300 trains: GPS position, delay (min), product code, prev/next station, origin/destination, next-station time, rolling stock, accessible flag | Same feed Vía libre uses (verified record-for-record). Undocumented; GPS fix age median 14 s, p90 43 s. UTF-8. |
| Renfe live map, previous snapshot | `.../renfe-visor/flotaLD_anterior.json` | Previous snapshot | Can bootstrap speed on startup. |
| Renfe live map, Cercanías | `.../renfe-visor/flota.json`, `.../renfe-visor/lineas.geojson`, `.../data/estaciones.geojson` | ~200–600 commuter trains (13 networks): position, line, delay, current/next station, platform; line shapes and colours; stations | In scope (§2.9). No per-train fix time. Occasionally returns a partial snapshot (146 vs 215 trains a minute apart). Some regional services appear in both feeds. |
| Renfe station departures | `.../renfe-json-cutter/write/salidas/estacion/{code}.json` | Departure board per station: planned vs real time, platform, line, destination | **Cercanías stations only** (LD stations like `60000` return 404). Used by §2.10. |
| Renfe notices | `.../renfe-visor/alerts.json` | Station/line notices (lifts, works), multi-language | Mostly Cercanías/accessibility. |
| Renfe GTFS-RT (official open data) | `https://gtfsrt.renfe.com/trip_updates_LD.json`, `alerts.json`, `vehicle_positions.json`, `trip_updates.json` | LD delays per trip incl. **CANCELED/ADDED** trips; service alerts | Official, stable. 38 LD cancellations seen on 2026-10-31. |
| Renfe GTFS static (official open data) | `https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip` | ~1,000 stations (same codes as live feed), routes, **~1,900 scheduled trains/day** with full stop lists and times, keyed by train number | Refresh daily. UTF-8. |
| Adif "Estado de la red" | `https://www.adif.es/viajeros/estado-de-la-red` | Hand-written network incident notices (HTML, no API) | Akamai returned 403 to curl and to Vía libre's backend, but **answered 200 to our plain Node `fetch`** (honest User-Agent) on 2026-10-31. Unreliable either way: best-effort only, no bot-check circumvention. |

Not available anywhere public: **Iryo and Ouigo** positions/delays.

---

## 1. Parity with Vía libre (must have)

### 1.1 Live map (home page)
- [ ] Map of Spain with all trains currently circulating, as dots coloured by delay:
      green `< 5 min`, amber `5–14 min`, red `≥ 15 min`.
- [ ] Rail network drawn underneath (segments between consecutive scheduled stops).
- [ ] Smooth motion: interpolate each train between updates using its velocity vector (max 60 s ahead);
      respect `prefers-reduced-motion`.
- [ ] Regional/medium-distance trains drawn smaller and fainter; high-speed and most-delayed trains on top.
- [ ] Labels: train number + delay (`03303 +12`), shown progressively with zoom, collision-avoided.
      City names; station names at high zoom.
- [ ] Zoom: +/− buttons, "whole Spain" button, mouse wheel, double-click, pinch, drag;
      keyboard `+`, `-`, `0`, `Esc`.
- [ ] Header: brand, live indicator ("En vivo, datos de Renfe de las HH:MM") that turns stale/red when
      Renfe hasn't answered for > 3 min, and count of trains without position.
- [ ] Train-type filter chips with live counts, persisted in `localStorage`:
      AVE, Avlo, Avant, Alvia, Euromed & Intercity, Media distancia & regionales,
      Iryo (*sin datos*, disabled), Ouigo (*sin datos*, disabled).
- [ ] Summary box: trains on map, trains delayed (≥ 5 min), median delay.
- [ ] Legend (the three delay levels + "tramo con incidencia").
- [ ] Offline/error banner: "No hay conexión con el servidor. Reintentando cada 15 segundos."

### 1.2 Train card ("ficha")
Opened by clicking a train (map or list). Map follows the selected train. Shows:
- [ ] Product + number, origin → destination
- [ ] Delay ("En hora", "N min", "N min adelantado", "1 h 5 min")
- [ ] Scheduled and estimated arrival
- [ ] Speed (≈ km/h, "Parado", "calculando…")
- [ ] Where ("En X" / "Entre X y Y"), time at next station
- [ ] Accessible

### 1.3 Delayed arrivals panel (right side)
- [ ] Trains with delay ≥ 5 min sorted by delay, showing `+N`, product, origin → destination, number,
      location, scheduled time struck through + estimated time.
- [ ] Zone filter by destination: Toda España, Madrid, Cataluña, C. Valenciana, Andalucía, Galicia, Norte
      (persisted).
- [ ] 12 rows (6 on mobile) + "Ver N más".
- [ ] Click a row → select and centre the train on the map.

### 1.4 Network incidents panel
- [ ] List of incidents: level (Grave / Afecta / Aviso), title, text, scope, "detectada HH:MM", source and
      last-update time.
- [ ] Incidents tied to a section are drawn on the map as a dashed coloured segment with a diamond marker;
      clicking the incident zooms to it.
- [ ] Empty/unavailable states ("Adif no publica ninguna incidencia…", "no se pueden leer los avisos de
      Adif. Se reintenta cada 3 minutos.").

### 1.5 General
- [ ] Polls own backend every 15 s (and on tab focus). Browser never calls Renfe/Adif directly.
- [ ] Responsive (two columns desktop, stacked on mobile), dark theme, accessible (ARIA labels, keyboard).
- [ ] Footer: data from Renfe and Adif, not affiliated with either.

---

## 2. New features

### 2.1 Navigation
Tabs in the header: **Mapa** (home, = §1) · **Estadísticas** · **Mis trenes** (tracked trains & alarms) ·
**Fuentes** (data sources + status). A global **search bar** is always visible. Hash routing so every view
is linkable (`#/tren/03303`, `#/stats?w=7D&tipo=ave`).

### 2.2 Train search & tracking
- [ ] Search by train number (with or without leading zeros / product prefix: `03303`, `3303`, `AVE 03303`)
      and by station name ("Sevilla" → trains to/from Sevilla now).
- [ ] Train page `#/tren/{n}`:
  - live status (as the card), map zoomed on the train, followed
  - **full itinerary** from GTFS: every stop with scheduled time, estimated time (scheduled + current
    delay), passed/next/remaining
  - status: running / not started yet (next departure today) / finished / **cancelled** / not running today
  - history for this train number: punctuality over the last 30 days (needs collected data)
  - **share link** so relatives can open it directly
- [ ] If the train isn't running now, say why when we know (cancelled per GTFS-RT, scheduled later, etc.).

### 2.3 Alarms (per tracked train)
User adds a train to *Mis trenes* and picks triggers:
- [ ] Delay reaches ≥ X min (default 15), and when it changes by ≥ 5 min afterwards
- [ ] Train cancelled
- [ ] Train stopped unexpectedly (stopped between stations ≥ 5 min)
- [ ] Departure from origin / arrival at destination / N min before arrival
- [ ] A major incident affects its route
- [ ] Proximity anomaly involving this train (§2.5)

Delivery (MVP): browser notification (Notification API) + sound + in-app toast, while the site is open
in a tab (also in the background). Tracked trains stored in `localStorage` (no accounts).
Later: Web Push (works with the browser closed), then optional accounts / Telegram / email.

### 2.4 Speed
- [ ] Speed computed server-side from consecutive GPS fixes (haversine / Δt), ignoring Δt < 10 s or > 5 min
      and implausible values (> 320 km/h; Spain's commercial max is 310), smoothed. Velocity vector used for map interpolation.
- [ ] Shown on card, train page, and as a stat (max speed per line).

### 2.5 Proximity alert (experimental)
Goal: alert when two trains are closer than the braking distance required at their speed.

**This is not, and must never be presented as, a safety system.** Real separation is enforced by
signalling (ASFA/LZB/ERTMS) with track-level data we don't have. Our data has GPS error, 10–60 s
latency, no track topology (double track = trains pass meters apart constantly) and no Iryo/Ouigo trains
— the 2026-10-30 Mora–Orgaz collision involved an Iryo train, which this alert could never have seen.

Rule (to minimise false positives):
- both fixes fresh (< 60 s), both projected to the same instant using their velocity
- both moving ≥ 30 km/h, **same direction** (heading Δ < 30°) and on the same section
  (same previous+next station, or one's next = other's previous)
- neither within 1.5 km of a station
- distance < braking distance of the follower `v²/(2·0.5 m/s²)` + 500 m margin
  (e.g. 300 km/h → ≈ 7.4 km; 120 km/h → ≈ 1.6 km)
- must persist for 2 consecutive updates before firing
- ignore pairs < 100 m apart at the same speed: two train numbers running coupled as one consist
  (first false positive found in real data, Galician regional trains 12453 + 12526)

Shown as "Anomalía de proximidad (experimental)" on the map and in a list; opt-in alarm; every event logged
so we can measure the false-positive rate before promoting it. LD/MD only (Cercanías has no fix timestamps
and runs on dense multi-track lines).

**Kept as is until Iryo/Ouigo data exists** (decision 2026-10-31). Notes on tracks for later:
- On **double track**, each direction normally has its own track. Two trains in the **same direction share
  the track** (one follows the other) — that is the case this rule checks, and it's what a rear-end
  collision ("alcance", like Mora–Orgaz) is. Opposite directions are on different tracks and just cross,
  so the rule ignores them. Origin/destination alone doesn't identify the track (trains with different
  origins/destinations share sections); previous/next station + heading do.
- On **single track** (much of the conventional network: Galicia, Extremadura, many regional lines),
  opposite-direction trains share the track and must cross at stations/loops, so head-on approach between
  stations *is* relevant there. To detect it we need to know which sections are single track: OpenStreetMap
  railway data has a `tracks=1/2` tag per section (Adif's network statement is the official source).

### 2.6 Major incident alarm
"Major incident" = any of:
- Adif notice with keywords: *interrumpida, suspendida, cortada, accidente, descarrilamiento, alcance,
  arrollamiento, incendio* (when Adif is readable)
- ≥ 3 cancellations on the same corridor in the last 2 h (GTFS-RT `CANCELED`)
- a train stopped between stations ≥ 15 min with delay rising ≥ 15 min
Global opt-in alarm ("Avisarme de incidencias graves"), optionally limited to a region.

### 2.7 Statistics tab
Filters: **train type** (multi), **time window** `Ahora, 1D, 7D, 1M, 3M, 6M, 1A, YTD`, **region**
(autonomous community; a train counts in the region of its destination), optionally line.

KPIs:
- trains circulating (now) / trains per day (observed vs scheduled)
- average and median delay; % trains delayed ≥ 5 min and ≥ 15 min (punctuality)
- cancellations (count, %)
- incidents (count, by level)
- **service availability %** — see note below
- max/average speed

Charts & rankings:
- delay over time (hourly for ≤ 7D, daily beyond)
- distribution of delays (buckets)
- by train type
- **lines with the worst average delay**, **lines with most / fewest trains**, most punctual lines
- worst trains of the window (highest delay), most frequently late train numbers
- busiest hours
- data coverage indicator ("datos recogidos desde …", gaps)

> **"Opened tracks %"**: Adif doesn't publish structured infrastructure state, so a literal "% of track
> open" isn't measurable. We define **disponibilidad del servicio = 1 − cancelled / scheduled trains**,
> plus **corridors affected** (corridors with an active incident or ≥ 3 cancellations).

A "line" for LD/MD = corridor between origin and destination stations (unordered pair), e.g.
"Madrid ↔ Sevilla", optionally split by product.

### 2.9 Cercanías
- [x] Live Cercanías/Rodalies trains on the map (smaller dots), chip with count, line shapes when zoomed in
- [x] Card/train page: line, network, current/next station, platform, delay; no full itinerary (Renfe's
      Cercanías GTFS is 16 MB and isn't loaded)
- [x] History + stats per Cercanías line ("Madrid C4a"); train_runs kept 90 days, daily roll-up forever
- [x] Duplicates: services published in both feeds (Rodalies R14/R16/R2S, Bilbao/Cantabria) are kept once
      (same number + same origin or destination)
- Cancellations are only known for LD/MD (GTFS-RT covers LD only)

### 2.10 Station departure boards
- [x] `#/estacion/{code}`: departures and arrivals for the next 3 hours, refreshed every 30 s
- [x] LD/MD from the GTFS timetable + live delay + cancellations (no platform: Renfe doesn't publish it)
- [x] Cercanías from Renfe's official board (planned/real time, platform); departures only
- [x] Reached from search (station results) and by clicking city names on the map

### 2.11 "This train is late X % of days"
- [x] Train page badge, map card and search results: % of finished runs arriving ≥ 5 min late
      (and ≥ 15 min, average delay, cancellations) over the last 30 days
- [x] SQL function `train_punctuality()` in the Supabase schema for the same figure

### 2.8 Sources tab
Status of each source (ok / error / last success / last error), what each provides, known gaps
(Iryo, Ouigo, Adif blocking), disclaimer.

---

## 3. Storage & the time-window question

**Yes, `1A`/YTD windows are doable without blowing up storage** — as long as we never keep raw
positions long-term and store one summary row per train run instead.

| Table | Granularity | Rows | Size/year (est., incl. indexes) | Retention |
|---|---|---|---|---|
| `train_runs` | 1 row per train per service day (product, origin, destination, regions, line, first/last seen, max/last/final delay, cancelled, max speed…) | ~1,900/day → ~700k/yr | **~100 MB** | forever (or roll up to daily after 2 yrs) |
| `hourly_stats` | per hour × product | ~240/day → ~90k/yr | ~10 MB | forever |
| `snapshots` | every 5 min × product × region | ~25k/day | rolling ~30 MB | **7 days** |
| `incidents`, `proximity_events` | per event | small | < 5 MB | forever |
| raw positions | — | — | in memory only | none |

Total ≈ **120–150 MB in year one**, which fits the Supabase free tier's 500 MB database for ~3 years. If we
add Cercanías (~5,000 runs/day) it roughly triples, so we'd keep Cercanías history shorter or aggregated.

Windows map to tables: `Ahora` → in-memory live state; `1D` → snapshots + train_runs;
`7D`…`1A`/`YTD` → train_runs + hourly_stats.

**Important:** history only exists while the collector runs. A laptop on localhost will leave gaps, so
production needs the collector running 24/7 (small VPS / Fly.io / Render, or a scheduled function writing to
Supabase). The MVP stores to local SQLite with a schema that ports 1:1 to Postgres/Supabase.

---

## 4. Non-functional
- Poll Renfe every 15 s (LD positions), GTFS-RT every 60 s, Adif every 3 min (honest, no evasion),
  GTFS static daily. One server fetch serves all users (cache).
- Survive any source failing (show last data + stale indicator).
- Mobile-first responsive, dark theme, accessible.
- No secrets in the client; no personal data stored server-side (MVP has no accounts).

## 5. Out of MVP scope (later)
- Cercanías full itineraries (needs the 16 MB Cercanías GTFS)
- Web Push — **not wanted** (alarms only need to work while the tab is open)
- Accounts, Telegram/email alarms
- English UI
- Iryo/Ouigo (no public data — revisit if they publish)

## 6. Open questions / things to decide
1. ~~Hosting for the 24/7 collector~~ → free plan: Supabase Edge Function + Cron, Cloudflare Pages + R2
   (see `docs/free-tier.md`). Schema: `supabase/schema.sql`.
2. Adif: polled once per minute (honest requests); ask Adif for an official feed if it starts blocking.
3. Map basemap provider for production (CARTO dark tiles in MVP; check terms if commercial).
4. Whether the proximity alert ships publicly at all, or stays internal until the false-positive rate is known.
5. Legal: Renfe open-data licence attribution; the live-map JSON is undocumented (may change without notice).
