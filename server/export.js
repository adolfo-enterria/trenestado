// Data downloads (#/datos): streams historical tables as CSV or JSON for a date range.
// Rows go straight from SQLite to the response (statement.iterate), so a full year never sits in memory.
import { db, AGG_SQL } from "./db.js";
import { madridDate } from "./sources/gtfs-static.js";
import { FORMAT, COLS, csvCell } from "./export-format.js";

// Each dataset: SQL with :desde/:hasta (+ optional filters) and a row mapper to public column names.
export const DATASETS = {
  recorridos: {
    range: "SELECT MIN(service_date) AS desde, MAX(service_date) AS hasta, COUNT(*) AS n FROM train_runs",
    filters: { red: "network = :red", tipos: "type IN (SELECT value FROM json_each(:tipos))" },
    sql: (w) => `SELECT * FROM train_runs WHERE service_date BETWEEN :desde AND :hasta ${w} ORDER BY service_date, network, train`,
  },
  lineas: {
    range: "SELECT MIN(service_date) AS desde, MAX(service_date) AS hasta, COUNT(*) AS n FROM (SELECT service_date FROM daily_line_stats UNION ALL SELECT service_date FROM train_runs)",
    filters: { red: "network = :red", tipos: "type IN (SELECT value FROM json_each(:tipos))" },
    // finished days from daily_line_stats + days not rolled up yet (e.g. today) aggregated on the fly
    sql: (w) => `SELECT * FROM (
        SELECT * FROM daily_line_stats WHERE service_date BETWEEN :desde AND :hasta
        UNION ALL
        SELECT * FROM (${AGG_SQL.replace("%WHERE%", "service_date BETWEEN :desde AND :hasta AND service_date NOT IN (SELECT DISTINCT service_date FROM daily_line_stats)")})
      ) WHERE 1 ${w} ORDER BY service_date, network, type, line_key`,
  },
  incidencias: {
    range: "SELECT date(MIN(first_seen) / 1000, 'unixepoch') AS desde, date(MAX(last_seen) / 1000, 'unixepoch') AS hasta, COUNT(*) AS n FROM incidents WHERE source != 'renfe'",
    filters: {},
    sql: () => `SELECT * FROM incidents WHERE source != 'renfe' AND date(first_seen / 1000, 'unixepoch') <= :hasta AND date(last_seen / 1000, 'unixepoch') >= :desde ORDER BY first_seen`,
  },
  proximidad: {
    range: "SELECT date(MIN(ts) / 1000, 'unixepoch') AS desde, date(MAX(ts) / 1000, 'unixepoch') AS hasta, COUNT(*) AS n FROM proximity_events",
    filters: {},
    sql: () => `SELECT * FROM proximity_events WHERE date(ts / 1000, 'unixepoch') BETWEEN :desde AND :hasta ORDER BY ts`,
  },
  horas: {
    range: "SELECT substr(MIN(hour), 1, 10) AS desde, substr(MAX(hour), 1, 10) AS hasta, COUNT(*) AS n FROM hourly_stats",
    filters: { tipos: "type IN (SELECT value FROM json_each(:tipos))" },
    sql: (w) => `SELECT * FROM hourly_stats WHERE substr(hour, 1, 10) BETWEEN :desde AND :hasta ${w} ORDER BY hour, type`,
  },
};


export function exportInfo() {
  return {
    formatos: ["csv", "json"],
    datasets: Object.entries(DATASETS).map(([id, d]) => {
      const r = db.prepare(d.range).get() || {};
      return { id, nombre: FORMAT[id].nombre, descripcion: FORMAT[id].descripcion, columnas: COLS[id], desde: r.desde || null, hasta: r.hasta || null, filasAprox: r.n || 0, filtros: Object.keys(d.filters) };
    }),
  };
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");

/** Streams a dataset to an Express response. */
export function streamExport(req, res) {
  const id = String(req.query.datos || "");
  const d = DATASETS[id];
  if (!d) return res.status(400).json({ error: "Conjunto de datos desconocido", disponibles: Object.keys(DATASETS) });
  const hasta = isDate(req.query.hasta) ? req.query.hasta : madridDate();
  const desde = isDate(req.query.desde) ? req.query.desde : hasta;
  if (desde > hasta) return res.status(400).json({ error: "«desde» es posterior a «hasta»" });
  const formato = req.query.formato === "json" ? "json" : "csv";

  const params = { desde, hasta };
  let where = "";
  if (d.filters.red && ["ld", "cer"].includes(req.query.red)) { where += ` AND ${d.filters.red}`; params.red = req.query.red; }
  const tipos = String(req.query.tipos || "").split(",").filter((t) => /^[a-z]{2,6}$/.test(t));
  if (d.filters.tipos && tipos.length) { where += ` AND ${d.filters.tipos}`; params.tipos = JSON.stringify(tipos); }

  const file = `trenestado_${id}_${desde}_${hasta}.${formato}`;
  res.set({
    "Content-Type": formato === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
    "Content-Disposition": `attachment; filename="${file}"`,
    "Cache-Control": "no-store",
  });
  const cols = COLS[id];
  let buf = formato === "csv" ? "﻿" + cols.join(",") + "\n" : "[";   // BOM so Excel reads UTF-8
  let first = true;
  try {
    for (const raw of db.prepare(d.sql(where)).iterate(params)) {
      const r = FORMAT[id].row(raw);
      if (formato === "csv") buf += cols.map((c) => csvCell(r[c])).join(",") + "\n";
      else { buf += (first ? "\n" : ",\n") + JSON.stringify(r); first = false; }
      if (buf.length > 64_000) { res.write(buf); buf = ""; }
    }
  } catch (e) {
    console.error("[export]", e.message);
    if (!res.headersSent) return res.status(500).json({ error: e.message });
  }
  res.end(formato === "csv" ? buf : buf + "\n]\n");
}
