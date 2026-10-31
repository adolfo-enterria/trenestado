# Trenestado

Live map of Renfe trains with delays, network incidents, statistics, train tracking and alarms.
Inspired by [Vía libre](https://vialibre.soft-flow.app/).

## Run

Requires Node 24+ (uses the built-in `node:sqlite`).

```sh
npm install
npm start        # http://localhost:3000
npm run dev      # same, restarts on file changes
```

On start the server downloads Renfe's GTFS timetable (cached in `data/` for 24 h), then polls the live
feeds. History (for the Estadísticas tab and per-train punctuality) accumulates in `data/trenestado.db`
only while the server is running.

## Layout

- `server/` collector (polls Renfe/Adif), detection (stopped trains, mass cancellations, proximity),
  SQLite persistence, stats, Express API
- `public/` vanilla JS frontend (Leaflet, Chart.js), no build step
- `docs/requirements.md` feature list, data sources, storage sizing
- `docs/plan.md` architecture and MVP status
- `docs/free-tier.md` how to run it on free plans (Supabase + Cloudflare)
- `supabase/schema.sql` database schema to run in the Supabase SQL editor

`LIVE_SECONDS=15 npm start` polls Renfe more often locally (default 60 s, the free-tier setting).

## Data

Renfe live map JSON (undocumented), Renfe GTFS + GTFS-RT (official open data), Adif "Estado de la red"
(HTML, best effort). Not affiliated with Renfe or Adif. Iryo and Ouigo publish no data.

The proximity alert is experimental and is **not** a safety system.
