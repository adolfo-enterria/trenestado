// Renfe GTFS (long + medium distance): stations, itineraries by train number, network segments.
import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { DATA_DIR, URLS, UA } from "../config.js";
import { placeOf } from "../geo.js";
import { productFromGtfsName } from "../products.js";
import { decodeText } from "./http.js";

const ZIP = path.join(DATA_DIR, "gtfs_ld.zip");

export const gtfs = {
  loadedAt: null,
  stations: new Map(), // code → { code, name, lat, lon, region, regionName, province }
  trips: new Map(), // tripId → { tripId, train, product, serviceId, stops: [{ code, arr, dep }] }
  byTrain: new Map(), // train → [tripId]
  byStation: new Map(), // station code → [{ trip, i }] (i = index of the stop in trip.stops)
  segments: [], // [lat1, lon1, lat2, lon2]
  services: new Map(), // serviceId → { start, end, days: [mon..sun], add: Set, remove: Set }
};

export const normCode = (c) => String(c ?? "").trim().replace(/^0+/, "").padStart(5, "0");
export const normTrain = (n) => String(n ?? "").trim().replace(/\D/g, "").replace(/^0+/, "").padStart(5, "0");

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const head = lines[0].replace(/^﻿/, "").split(",").map((h) => h.trim());
  return lines.slice(1).map((l) => {
    const cells = l.split(","); // Renfe GTFS has no quoted commas
    const o = {};
    head.forEach((h, i) => (o[h] = (cells[i] ?? "").trim()));
    return o;
  });
}
const toMin = (hms) => { if (!hms) return null; const [h, m] = hms.split(":").map(Number); return h * 60 + m; };

async function download() {
  const r = await fetch(URLS.gtfsStatic, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("GTFS HTTP " + r.status);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ZIP, Buffer.from(await r.arrayBuffer()));
}

export async function loadGtfs({ force = false } = {}) {
  const fresh = fs.existsSync(ZIP) && Date.now() - fs.statSync(ZIP).mtimeMs < 24 * 3600_000;
  if (force || !fresh) {
    try { await download(); } catch (e) { if (!fs.existsSync(ZIP)) throw e; console.warn("[gtfs] download failed, using cached file:", e.message); }
  }
  const zip = new AdmZip(ZIP);
  const read = (n) => parseCsv(decodeText(zip.readFile(n)));

  const stations = new Map();
  for (const s of read("stops.txt")) {
    const lat = Number(s.stop_lat), lon = Number(s.stop_lon);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const code = normCode(s.stop_id);
    stations.set(code, { code, name: s.stop_name, lat, lon, ...placeOf(lat, lon) });
  }

  // Cercanías/Rodalies stations fill in codes the LD timetable doesn't have (regional trains start/end there)
  try {
    const geo = JSON.parse(decodeText(new Uint8Array(await (await fetch(URLS.cercaniasStations, { headers: { "User-Agent": UA } })).arrayBuffer())));
    for (const f of geo.features || []) {
      const p = f.properties || {};
      const code = normCode(p.CODIGO_ESTACION);
      const lat = Number(p.LATITUD), lon = Number(p.LONGITUD);
      if (stations.has(code) || !isFinite(lat) || !isFinite(lon)) continue;
      stations.set(code, { code, name: p.NOMBRE_ESTACION, lat, lon, ...placeOf(lat, lon), cercanias: true });
    }
  } catch (e) { console.warn("[gtfs] cercanías stations:", e.message); }

  const routes = new Map(read("routes.txt").map((r) => [r.route_id, r.route_short_name]));
  const services = new Map();
  for (const c of read("calendar.txt")) {
    services.set(c.service_id, {
      start: c.start_date, end: c.end_date,
      days: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((d) => c[d] === "1"),
      add: new Set(), remove: new Set(),
    });
  }
  if (zip.getEntry("calendar_dates.txt")) for (const c of read("calendar_dates.txt")) {
    const s = services.get(c.service_id) || { start: "99999999", end: "00000000", days: Array(7).fill(false), add: new Set(), remove: new Set() };
    (c.exception_type === "1" ? s.add : s.remove).add(c.date);
    services.set(c.service_id, s);
  }

  const trips = new Map(), byTrain = new Map();
  for (const t of read("trips.txt")) {
    const train = normTrain(t.trip_short_name || t.trip_id.slice(0, 5));
    const name = routes.get(t.route_id);
    trips.set(t.trip_id, { tripId: t.trip_id, train, routeName: name, product: productFromGtfsName(name), serviceId: t.service_id, stops: [] });
    if (!byTrain.has(train)) byTrain.set(train, []);
    byTrain.get(train).push(t.trip_id);
  }
  for (const st of read("stop_times.txt")) {
    const t = trips.get(st.trip_id);
    if (t) t.stops.push({ seq: Number(st.stop_sequence), code: normCode(st.stop_id), arr: toMin(st.arrival_time), dep: toMin(st.departure_time) });
  }
  const segKeys = new Set(), segments = [], byStation = new Map();
  for (const t of trips.values()) {
    t.stops.sort((a, b) => a.seq - b.seq);
    t.stops.forEach((st, i) => { if (!byStation.has(st.code)) byStation.set(st.code, []); byStation.get(st.code).push({ trip: t, i }); });
    for (let i = 1; i < t.stops.length; i++) {
      const a = t.stops[i - 1].code, b = t.stops[i].code;
      const k = a < b ? a + "-" + b : b + "-" + a;
      if (segKeys.has(k)) continue;
      segKeys.add(k);
      const A = stations.get(a), B = stations.get(b);
      if (A && B) segments.push([A.lat, A.lon, B.lat, B.lon]);
    }
  }

  Object.assign(gtfs, { stations, trips, byTrain, byStation, segments, services, loadedAt: new Date().toISOString() });
  console.log(`[gtfs] ${stations.size} stations, ${trips.size} trips, ${byTrain.size} train numbers, ${segments.length} segments`);
}

// ---------- Service-day helpers ----------
export function madridDate(date = new Date()) {
  // YYYY-MM-DD in Europe/Madrid
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(date);
}
export function madridMinutes(date = new Date()) {
  const [h, m] = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date).split(":").map(Number);
  return h * 60 + m;
}

export function runsOn(serviceId, dateStr /* YYYY-MM-DD */) {
  const s = gtfs.services.get(serviceId);
  if (!s) return false;
  const d = dateStr.replace(/-/g, "");
  if (s.remove.has(d)) return false;
  if (s.add.has(d)) return true;
  if (d < s.start || d > s.end) return false;
  const wd = (new Date(dateStr + "T12:00:00Z").getUTCDay() + 6) % 7;
  return s.days[wd];
}

/** Trip of a train number that runs on a date. */
export function tripFor(train, dateStr = madridDate()) {
  const ids = gtfs.byTrain.get(normTrain(train)) || [];
  for (const id of ids) { const t = gtfs.trips.get(id); if (t && runsOn(t.serviceId, dateStr)) return t; }
  return null;
}

const schedCache = new Map();
/** All trips scheduled on a date: [{ train, tripId, product, origin, dest, dep, arr }] */
export function scheduledOn(dateStr = madridDate()) {
  const key = dateStr + "|" + gtfs.loadedAt;
  if (schedCache.has(key)) return schedCache.get(key);
  const out = [];
  for (const t of gtfs.trips.values()) {
    if (!t.stops.length || !runsOn(t.serviceId, dateStr)) continue;
    const a = t.stops[0], b = t.stops[t.stops.length - 1];
    out.push({ train: t.train, tripId: t.tripId, product: t.product, origin: a.code, dest: b.code, dep: a.dep, arr: b.arr });
  }
  schedCache.clear();
  schedCache.set(key, out);
  return out;
}
