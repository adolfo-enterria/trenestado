// Persistence. SQLite locally (node:sqlite); the schema is plain SQL that ports to Postgres/Supabase
// (INTEGER epoch-ms timestamps, TEXT dates, no SQLite-only types). See docs/requirements.md §3.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DATA_DIR, RETENTION } from "./config.js";

fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(process.env.DB_PATH || path.join(DATA_DIR, "trenestado.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");

// v2: train_runs gains `network` (ld | cer) in its key — Cercanías and LD train numbers can collide.
const cols = db.prepare("PRAGMA table_info(train_runs)").all();
if (cols.length && !cols.some((c) => c.name === "network")) {
  db.exec("ALTER TABLE train_runs RENAME TO train_runs_v1");
  db.exec("DROP INDEX IF EXISTS train_runs_last_seen; DROP INDEX IF EXISTS train_runs_train;");
}

db.exec(`
CREATE TABLE IF NOT EXISTS train_runs (
  service_date TEXT NOT NULL,      -- YYYY-MM-DD (Europe/Madrid)
  network      TEXT NOT NULL DEFAULT 'ld', -- ld (long/medium distance) | cer (Cercanías)
  train        TEXT NOT NULL,      -- 5-digit commercial number
  product      INTEGER,
  type         TEXT,               -- ave | avlo | avant | alvia | ld | md | cer
  origin       TEXT,
  dest         TEXT,
  dest_region  TEXT,               -- autonomous community id of destination
  line_key     TEXT,               -- "Madrid ↔ Sevilla" or "Madrid C4a"
  sched_dep    INTEGER,            -- minutes after midnight (GTFS)
  sched_arr    INTEGER,
  first_seen   INTEGER,            -- epoch ms
  last_seen    INTEGER,
  samples      INTEGER NOT NULL DEFAULT 0,
  delay_sum    INTEGER NOT NULL DEFAULT 0,
  max_delay    INTEGER,
  last_delay   INTEGER,
  final_delay  INTEGER,            -- delay when it reached its destination
  max_kmh      REAL,
  cancelled    INTEGER NOT NULL DEFAULT 0,
  finished     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (service_date, network, train)
);
CREATE INDEX IF NOT EXISTS train_runs_last_seen ON train_runs (last_seen);
CREATE INDEX IF NOT EXISTS train_runs_train ON train_runs (train, network, service_date);

-- one row per day × network × type × line: long windows read this, so they survive train_runs purges
CREATE TABLE IF NOT EXISTS daily_line_stats (
  service_date TEXT NOT NULL,
  network      TEXT NOT NULL,
  type         TEXT NOT NULL,
  line_key     TEXT NOT NULL,
  dest_region  TEXT NOT NULL DEFAULT '',
  runs         INTEGER NOT NULL,   -- ran (not cancelled)
  cancelled    INTEGER NOT NULL,
  late5        INTEGER NOT NULL,
  late15       INTEGER NOT NULL,
  delay_sum    INTEGER NOT NULL,   -- sum of max(0, final delay)
  max_delay    INTEGER,
  max_kmh      REAL,
  b0 INTEGER NOT NULL, b1 INTEGER NOT NULL, b2 INTEGER NOT NULL, b3 INTEGER NOT NULL, b4 INTEGER NOT NULL, b5 INTEGER NOT NULL, -- delay buckets
  PRIMARY KEY (service_date, network, type, line_key, dest_region)
);

CREATE TABLE IF NOT EXISTS scheduled_days (
  service_date TEXT NOT NULL,
  type         TEXT NOT NULL,
  dest_region  TEXT NOT NULL,
  n            INTEGER NOT NULL,
  PRIMARY KEY (service_date, type, dest_region)
);

CREATE TABLE IF NOT EXISTS hourly_stats (
  hour       TEXT NOT NULL,        -- YYYY-MM-DDTHH (Europe/Madrid)
  type       TEXT NOT NULL,
  cycles     INTEGER NOT NULL DEFAULT 0,
  obs        INTEGER NOT NULL DEFAULT 0,  -- train observations (trains × cycles)
  delay_sum  INTEGER NOT NULL DEFAULT 0,
  delayed5   INTEGER NOT NULL DEFAULT 0,
  delayed15  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, type)
);

CREATE TABLE IF NOT EXISTS snapshots (
  ts         INTEGER NOT NULL,
  type       TEXT NOT NULL,
  region     TEXT NOT NULL,        -- destination region id, '' if unknown
  trains     INTEGER NOT NULL,
  delayed5   INTEGER NOT NULL,
  delayed15  INTEGER NOT NULL,
  delay_sum  INTEGER NOT NULL,
  PRIMARY KEY (ts, type, region)
);

CREATE TABLE IF NOT EXISTS incidents (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,       -- adif | derivado | renfe
  level       TEXT NOT NULL,       -- grave | leve | info
  major       INTEGER NOT NULL DEFAULT 0,
  title       TEXT,
  body        TEXT,
  scope       TEXT,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS incidents_first_seen ON incidents (first_seen);

CREATE TABLE IF NOT EXISTS proximity_events (
  id          INTEGER PRIMARY KEY,
  ts          INTEGER NOT NULL,
  train_a     TEXT NOT NULL,
  train_b     TEXT NOT NULL,
  dist_m      REAL,
  required_m  REAL,
  kmh_a       REAL,
  kmh_b       REAL,
  lat         REAL,
  lon         REAL
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`);

if (db.prepare("SELECT name FROM sqlite_master WHERE name = 'train_runs_v1'").get()) {
  db.exec(`INSERT OR IGNORE INTO train_runs (service_date, network, train, product, type, origin, dest, dest_region, line_key, sched_dep, sched_arr,
      first_seen, last_seen, samples, delay_sum, max_delay, last_delay, final_delay, max_kmh, cancelled, finished)
    SELECT service_date, 'ld', train, product, type, origin, dest, dest_region, line_key, sched_dep, sched_arr,
      first_seen, last_seen, samples, delay_sum, max_delay, last_delay, final_delay, max_kmh, cancelled, finished FROM train_runs_v1;
    DROP TABLE train_runs_v1;`);
  console.log("[db] migrated train_runs to v2 (network column)");
}

const q = (sql) => db.prepare(sql);

export const stmts = {
  upsertRun: q(`
    INSERT INTO train_runs (service_date, network, train, product, type, origin, dest, dest_region, line_key, sched_dep, sched_arr,
      first_seen, last_seen, samples, delay_sum, max_delay, last_delay, max_kmh)
    VALUES (:service_date, :network, :train, :product, :type, :origin, :dest, :dest_region, :line_key, :sched_dep, :sched_arr,
      :ts, :ts, 1, :delay, :delay, :delay, :kmh)
    ON CONFLICT (service_date, network, train) DO UPDATE SET
      last_seen = :ts, samples = samples + 1, delay_sum = delay_sum + :delay, line_key = :line_key, dest_region = :dest_region,
      max_delay = MAX(COALESCE(max_delay, :delay), :delay), last_delay = :delay,
      max_kmh = MAX(COALESCE(max_kmh, 0), COALESCE(:kmh, 0)), cancelled = 0`),
  finishRun: q(`UPDATE train_runs SET finished = 1, final_delay = last_delay WHERE service_date = ? AND network = ? AND train = ? AND finished = 0`),
  cancelRun: q(`
    INSERT INTO train_runs (service_date, network, train, product, type, origin, dest, dest_region, line_key, sched_dep, sched_arr, first_seen, last_seen, cancelled)
    VALUES (:service_date, 'ld', :train, :product, :type, :origin, :dest, :dest_region, :line_key, :sched_dep, :sched_arr, :ts, :ts, 1)
    ON CONFLICT (service_date, network, train) DO UPDATE SET cancelled = CASE WHEN samples = 0 THEN 1 ELSE cancelled END, last_seen = MAX(last_seen, :ts)`),
  upsertScheduled: q(`INSERT INTO scheduled_days (service_date, type, dest_region, n) VALUES (?, ?, ?, ?)
    ON CONFLICT (service_date, type, dest_region) DO UPDATE SET n = excluded.n`),
  addHourly: q(`
    INSERT INTO hourly_stats (hour, type, cycles, obs, delay_sum, delayed5, delayed15) VALUES (:hour, :type, 1, :obs, :delay_sum, :d5, :d15)
    ON CONFLICT (hour, type) DO UPDATE SET cycles = cycles + 1, obs = obs + :obs, delay_sum = delay_sum + :delay_sum,
      delayed5 = delayed5 + :d5, delayed15 = delayed15 + :d15`),
  addSnapshot: q(`INSERT OR REPLACE INTO snapshots (ts, type, region, trains, delayed5, delayed15, delay_sum) VALUES (?, ?, ?, ?, ?, ?, ?)`),
  upsertIncident: q(`
    INSERT INTO incidents (id, source, level, major, title, body, scope, first_seen, last_seen) VALUES (:id, :source, :level, :major, :title, :body, :scope, :ts, :ts)
    ON CONFLICT (id) DO UPDATE SET level = :level, major = :major, title = :title, body = :body, scope = :scope, last_seen = :ts`),
  incidentFirstSeen: q(`SELECT first_seen FROM incidents WHERE id = ?`),
  addProximity: q(`INSERT INTO proximity_events (ts, train_a, train_b, dist_m, required_m, kmh_a, kmh_b, lat, lon) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getMeta: q(`SELECT value FROM meta WHERE key = ?`),
  setMeta: q(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`),
  trainHistory: q(`SELECT service_date, COALESCE(final_delay, last_delay) AS delay, max_delay, cancelled, finished, max_kmh
    FROM train_runs WHERE train = ? AND network = ? AND service_date >= ? ORDER BY service_date DESC`),
};

export function tx(fn) {
  db.exec("BEGIN");
  try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; }
}

// Aggregates train_runs into daily_line_stats rows (the same SQL is used for "today" on the fly).
export const AGG_SQL = `
  SELECT service_date, network, COALESCE(type, '') AS type, COALESCE(line_key, '') AS line_key, COALESCE(dest_region, '') AS dest_region,
    SUM(cancelled = 0) AS runs, SUM(cancelled) AS cancelled,
    SUM(cancelled = 0 AND COALESCE(final_delay, last_delay) >= 5) AS late5,
    SUM(cancelled = 0 AND COALESCE(final_delay, last_delay) >= 15) AS late15,
    SUM(CASE WHEN cancelled = 0 THEN MAX(0, COALESCE(final_delay, last_delay, 0)) ELSE 0 END) AS delay_sum,
    MAX(CASE WHEN cancelled = 0 THEN max_delay END) AS max_delay, MAX(max_kmh) AS max_kmh,
    SUM(cancelled = 0 AND COALESCE(final_delay, last_delay) <= 0) AS b0,
    SUM(cancelled = 0 AND COALESCE(final_delay, last_delay) BETWEEN 1 AND 4) AS b1,
    SUM(cancelled = 0 AND COALESCE(final_delay, last_delay) BETWEEN 5 AND 14) AS b2,
    SUM(cancelled = 0 AND COALESCE(final_delay, last_delay) BETWEEN 15 AND 29) AS b3,
    SUM(cancelled = 0 AND COALESCE(final_delay, last_delay) BETWEEN 30 AND 59) AS b4,
    SUM(cancelled = 0 AND COALESCE(final_delay, last_delay) >= 60) AS b5
  FROM train_runs WHERE %WHERE% AND (cancelled = 1 OR last_delay IS NOT NULL)
  GROUP BY service_date, network, COALESCE(type, ''), COALESCE(line_key, ''), COALESCE(dest_region, '')`;

export function rollupDay(date) {
  tx(() => {
    db.prepare("DELETE FROM daily_line_stats WHERE service_date = ?").run(date);
    db.prepare(`INSERT INTO daily_line_stats (service_date, network, type, line_key, dest_region, runs, cancelled, late5, late15, delay_sum, max_delay, max_kmh, b0, b1, b2, b3, b4, b5)
      ${AGG_SQL.replace("%WHERE%", "service_date = ?")}`).run(date);
  });
}

/** Roll up every finished day not yet rolled up, then apply retention. */
export function cleanup(now = Date.now(), today = null) {
  db.prepare("DELETE FROM snapshots WHERE ts < ?").run(now - RETENTION.snapshotsDays * 86400_000);
  if (!today) return;
  const pending = db.prepare(`SELECT DISTINCT service_date AS d FROM train_runs WHERE service_date < ?
    AND service_date NOT IN (SELECT DISTINCT service_date FROM daily_line_stats)`).all(today);
  for (const { d } of pending) rollupDay(d);
  const cut = new Date(now - RETENTION.cercaniasRunsDays * 86400_000).toISOString().slice(0, 10);
  db.prepare("DELETE FROM train_runs WHERE network = 'cer' AND service_date < ?").run(cut);
}

export const meta = {
  get: (k) => stmts.getMeta.get(k)?.value ?? null,
  set: (k, v) => stmts.setMeta.run(k, String(v)),
};
