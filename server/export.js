// Data downloads (#/datos): streams historical tables as CSV or JSON for a date range.
// Rows go straight from SQLite to the response (statement.iterate), so a full year never sits in memory.
import { db, AGG_SQL } from "./db.js";
import { gtfs, madridDate } from "./sources/gtfs-static.js";
import { shortName } from "./lines.js";

const hhmm = (m) => (m == null ? "" : String(Math.floor((m % 1440) / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"));
const iso = (ms) => (ms == null ? "" : new Date(Number(ms)).toISOString());
const name = (code) => (code ? gtfs.stations.get(code)?.name || shortName(code) : "");

// Each dataset: SQL with :desde/:hasta (+ optional filters) and a row mapper to public column names.
export const DATASETS = {
  recorridos: {
    nombre: "Recorridos",
    descripcion: "Un registro por tren y día: origen, destino, línea, retraso máximo y final, velocidad máxima, si se canceló o llegó a destino.",
    range: "SELECT MIN(service_date) AS desde, MAX(service_date) AS hasta, COUNT(*) AS n FROM train_runs",
    filters: { red: "network = :red", tipos: "type IN (SELECT value FROM json_each(:tipos))" },
    sql: (w) => `SELECT * FROM train_runs WHERE service_date BETWEEN :desde AND :hasta ${w} ORDER BY service_date, network, train`,
    row: (r) => ({
      fecha: r.service_date, red: r.network === "cer" ? "cercanias" : "larga_media", tren: r.train, tipo: r.type ?? "",
      origen_codigo: r.origin ?? "", origen: name(r.origin), destino_codigo: r.dest ?? "", destino: name(r.dest),
      region_destino: r.dest_region ?? "", linea: r.line_key ?? "", salida_programada: hhmm(r.sched_dep), llegada_programada: hhmm(r.sched_arr),
      primera_vez_visto: iso(r.first_seen), ultima_vez_visto: iso(r.last_seen), observaciones: r.samples,
      retraso_max_min: r.max_delay ?? "", retraso_ultimo_min: r.last_delay ?? "", retraso_llegada_min: r.final_delay ?? "",
      velocidad_max_kmh: r.max_kmh == null ? "" : Math.round(r.max_kmh), cancelado: r.cancelled ? 1 : 0, llego_a_destino: r.finished ? 1 : 0,
    }),
  },
  lineas: {
    nombre: "Líneas por día",
    descripcion: "Agregado diario por línea y tipo de tren: trenes, cancelados, % con retraso, retraso medio y reparto de retrasos.",
    range: "SELECT MIN(service_date) AS desde, MAX(service_date) AS hasta, COUNT(*) AS n FROM (SELECT service_date FROM daily_line_stats UNION ALL SELECT service_date FROM train_runs)",
    filters: { red: "network = :red", tipos: "type IN (SELECT value FROM json_each(:tipos))" },
    // finished days from daily_line_stats + days not rolled up yet (e.g. today) aggregated on the fly
    sql: (w) => `SELECT * FROM (
        SELECT * FROM daily_line_stats WHERE service_date BETWEEN :desde AND :hasta
        UNION ALL
        SELECT * FROM (${AGG_SQL.replace("%WHERE%", "service_date BETWEEN :desde AND :hasta AND service_date NOT IN (SELECT DISTINCT service_date FROM daily_line_stats)")})
      ) WHERE 1 ${w} ORDER BY service_date, network, type, line_key`,
    row: (r) => ({
      fecha: r.service_date, red: r.network === "cer" ? "cercanias" : "larga_media", tipo: r.type, linea: r.line_key, region_destino: r.dest_region,
      trenes: r.runs, cancelados: r.cancelled, con_retraso_5min: r.late5, con_retraso_15min: r.late15,
      pct_retraso_5min: r.runs ? Math.round((1000 * r.late5) / r.runs) / 10 : "", retraso_medio_min: r.runs ? Math.round((10 * r.delay_sum) / r.runs) / 10 : "",
      retraso_max_min: r.max_delay ?? "", velocidad_max_kmh: r.max_kmh == null ? "" : Math.round(r.max_kmh),
      en_hora: r.b0, retraso_1_4: r.b1, retraso_5_14: r.b2, retraso_15_29: r.b3, retraso_30_59: r.b4, retraso_60_mas: r.b5,
    }),
  },
  incidencias: {
    nombre: "Incidencias",
    descripcion: "Avisos de Adif e incidencias detectadas en los datos de Renfe (cancelaciones masivas, trenes detenidos), con cuándo se vieron.",
    range: "SELECT date(MIN(first_seen) / 1000, 'unixepoch') AS desde, date(MAX(last_seen) / 1000, 'unixepoch') AS hasta, COUNT(*) AS n FROM incidents WHERE source != 'renfe'",
    filters: {},
    sql: () => `SELECT * FROM incidents WHERE source != 'renfe' AND date(first_seen / 1000, 'unixepoch') <= :hasta AND date(last_seen / 1000, 'unixepoch') >= :desde ORDER BY first_seen`,
    row: (r) => ({ id: r.id, fuente: r.source, nivel: r.level, grave: r.major ? 1 : 0, titulo: r.title ?? "", texto: r.body ?? "", ambito: r.scope ?? "", visto_desde: iso(r.first_seen), visto_hasta: iso(r.last_seen) }),
  },
  proximidad: {
    nombre: "Anomalías de proximidad",
    descripcion: "Experimental. Pares de trenes más cerca que la distancia de frenado estimada, con GPS impreciso. No es un registro de seguridad.",
    range: "SELECT date(MIN(ts) / 1000, 'unixepoch') AS desde, date(MAX(ts) / 1000, 'unixepoch') AS hasta, COUNT(*) AS n FROM proximity_events",
    filters: {},
    sql: () => `SELECT * FROM proximity_events WHERE date(ts / 1000, 'unixepoch') BETWEEN :desde AND :hasta ORDER BY ts`,
    row: (r) => ({ momento: iso(r.ts), tren_detras: r.train_a, tren_delante: r.train_b, distancia_m: Math.round(r.dist_m ?? 0), frenado_estimado_m: Math.round(r.required_m ?? 0), velocidad_detras_kmh: r.kmh_a ?? "", velocidad_delante_kmh: r.kmh_b ?? "", lat: r.lat ?? "", lon: r.lon ?? "" }),
  },
  horas: {
    nombre: "Horas",
    descripcion: "Agregado por hora y tipo de tren: trenes circulando de media, retraso medio y % con retraso.",
    range: "SELECT substr(MIN(hour), 1, 10) AS desde, substr(MAX(hour), 1, 10) AS hasta, COUNT(*) AS n FROM hourly_stats",
    filters: { tipos: "type IN (SELECT value FROM json_each(:tipos))" },
    sql: (w) => `SELECT * FROM hourly_stats WHERE substr(hour, 1, 10) BETWEEN :desde AND :hasta ${w} ORDER BY hour, type`,
    row: (r) => ({
      hora: r.hour.replace("T", " ") + ":00", tipo: r.type, trenes_medios: r.cycles ? Math.round((10 * r.obs) / r.cycles) / 10 : "",
      retraso_medio_min: r.obs ? Math.round((10 * r.delay_sum) / r.obs) / 10 : "", pct_retraso_5min: r.obs ? Math.round((1000 * r.delayed5) / r.obs) / 10 : "",
      pct_retraso_15min: r.obs ? Math.round((1000 * r.delayed15) / r.obs) / 10 : "",
    }),
  },
};

const COLS = Object.fromEntries(Object.entries(DATASETS).map(([id, d]) => [id, Object.keys(d.row(new Proxy({}, { get: (t, k) => (k === "hour" ? "2000-01-01T00" : null) })))]));

export function exportInfo() {
  return {
    formatos: ["csv", "json"],
    datasets: Object.entries(DATASETS).map(([id, d]) => {
      const r = db.prepare(d.range).get() || {};
      return { id, nombre: d.nombre, descripcion: d.descripcion, columnas: COLS[id], desde: r.desde || null, hasta: r.hasta || null, filasAprox: r.n || 0, filtros: Object.keys(d.filters) };
    }),
  };
}

const csvCell = (v) => { const s = v == null ? "" : String(v); return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
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
      const r = d.row(raw);
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
