// Public format of the downloadable datasets (column names, Spanish labels, CSV escaping), shared by the
// local server (server/export.js, SQLite) and the daily job that writes monthly files to R2 (scripts/sync-supabase.mjs).
// Rows passed to row() use SQLite-style values: timestamps in epoch ms, booleans as 0/1, dates as "YYYY-MM-DD".
import { gtfs } from "./sources/gtfs-static.js";
import { shortName } from "./lines.js";

const hhmm = (m) => (m == null ? "" : String(Math.floor((m % 1440) / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0"));
const iso = (ms) => (ms == null ? "" : new Date(Number(ms)).toISOString());
const name = (code) => (code ? gtfs.stations.get(code)?.name || shortName(code) : "");

export const FORMAT = {
  recorridos: {
    nombre: "Recorridos",
    descripcion: "Un registro por tren y día: origen, destino, línea, retraso máximo y final, velocidad máxima, si se canceló o llegó a destino.",
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
    row: (r) => ({ id: r.id, fuente: r.source, nivel: r.level, grave: r.major ? 1 : 0, titulo: r.title ?? "", texto: r.body ?? "", ambito: r.scope ?? "", visto_desde: iso(r.first_seen), visto_hasta: iso(r.last_seen) }),
  },
  proximidad: {
    nombre: "Anomalías de proximidad",
    descripcion: "Experimental. Pares de trenes más cerca que la distancia de frenado estimada, con GPS impreciso. No es un registro de seguridad.",
    row: (r) => ({ momento: iso(r.ts), tren_detras: r.train_a, tren_delante: r.train_b, distancia_m: Math.round(r.dist_m ?? 0), frenado_estimado_m: Math.round(r.required_m ?? 0), velocidad_detras_kmh: r.kmh_a ?? "", velocidad_delante_kmh: r.kmh_b ?? "", lat: r.lat ?? "", lon: r.lon ?? "" }),
  },
  horas: {
    nombre: "Horas",
    descripcion: "Agregado por hora y tipo de tren: trenes circulando de media, retraso medio y % con retraso.",
    row: (r) => ({
      hora: r.hour.replace("T", " ") + ":00", tipo: r.type, trenes_medios: r.cycles ? Math.round((10 * r.obs) / r.cycles) / 10 : "",
      retraso_medio_min: r.obs ? Math.round((10 * r.delay_sum) / r.obs) / 10 : "", pct_retraso_5min: r.obs ? Math.round((1000 * r.delayed5) / r.obs) / 10 : "",
      pct_retraso_15min: r.obs ? Math.round((1000 * r.delayed15) / r.obs) / 10 : "",
    }),
  },
};

export const COLS = Object.fromEntries(Object.entries(FORMAT).map(([id, d]) => [id, Object.keys(d.row(new Proxy({}, { get: (t, k) => (k === "hour" ? "2000-01-01T00" : null) })))]));
export const csvCell = (v) => { const s = v == null ? "" : String(v); return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const csvHeader = (id) => "﻿" + COLS[id].join(",") + "\n"; // BOM so Excel reads UTF-8
export const csvLine = (id, raw) => { const r = FORMAT[id].row(raw); return COLS[id].map((c) => csvCell(r[c])).join(",") + "\n"; };
