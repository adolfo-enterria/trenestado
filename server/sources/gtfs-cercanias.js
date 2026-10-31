// Renfe Cercanías GTFS (fomento_transit.zip): 16 MB zipped but 288 MB / 1.9 M stop times unzipped, because
// every trip is listed for each service day. We stream it and keep only today's and tomorrow's trips
// (~5 % of the file) plus their shapes, so memory stays small.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import yauzl from "yauzl";
import { DATA_DIR, UA } from "../config.js";
import { normCode, normTrain, madridDate } from "./gtfs-static.js";

const URL_CER = "https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip";
const ZIP = path.join(DATA_DIR, "gtfs_cer.zip");

export const cer = {
  loadedAt: null,
  dates: [],          // service dates covered (YYYY-MM-DD)
  trips: new Map(),   // trip_id → { tripId, train, line, date, shapeId, headsign, stops: [{ code, arr, dep }] }
  byTrain: new Map(), // train → [trip_id]
  shapes: new Map(),  // shape_id → [[lat, lon]]
};

const toMin = (hms) => { if (!hms) return null; const [h, m] = hms.trim().split(":").map(Number); return h * 60 + m; };

async function download() {
  const r = await fetch(URL_CER, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("GTFS Cercanías HTTP " + r.status);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ZIP + ".tmp", Buffer.from(await r.arrayBuffer()));
  fs.renameSync(ZIP + ".tmp", ZIP);
}

/** Calls onRow(object) for every CSV row of one file inside the zip, streaming. */
function eachRow(zipPath, name, onRow) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      let found = false;
      zip.readEntry();
      zip.on("entry", (entry) => {
        if (entry.fileName !== name) return zip.readEntry();
        found = true;
        zip.openReadStream(entry, (e, stream) => {
          if (e) return reject(e);
          const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
          let head = null;
          rl.on("line", (line) => {
            if (!line.trim()) return;
            const cells = line.split(",");
            if (!head) { head = cells.map((h) => h.replace(/^﻿/, "").trim()); return; }
            const o = {};
            for (let i = 0; i < head.length; i++) o[head[i]] = cells[i] ?? "";
            onRow(o);
          });
          rl.on("close", () => { zip.close(); resolve(); });
          rl.on("error", reject);
        });
      });
      zip.on("end", () => { if (!found) resolve(); });
      zip.on("error", reject);
    });
  });
}

export async function loadCercaniasGtfs({ force = false } = {}) {
  const fresh = fs.existsSync(ZIP) && Date.now() - fs.statSync(ZIP).mtimeMs < 24 * 3600_000;
  if (force || !fresh) {
    try { await download(); } catch (e) { if (!fs.existsSync(ZIP)) throw e; console.warn("[gtfs cer] download failed, using cached file:", e.message); }
  }
  const today = madridDate(), tomorrow = madridDate(new Date(Date.now() + 86400_000));
  const want = new Set([today.replace(/-/g, ""), tomorrow.replace(/-/g, "")]);
  const dateOf = (ymd) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;

  // calendar: Renfe publishes one-day services (start = end), with weekday flags; keep today's and tomorrow's
  const services = new Map(); // service_id → date
  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  await eachRow(ZIP, "calendar.txt", (c) => {
    const s = c.start_date.trim(), e = c.end_date.trim();
    for (const d of want) {
      if (d < s || d > e) continue;
      const wd = (new Date(dateOf(d) + "T12:00:00Z").getUTCDay() + 6) % 7;
      if (c[days[wd]]?.trim() === "1") services.set(c.service_id.trim(), dateOf(d));
    }
  });

  const lines = new Map();
  await eachRow(ZIP, "routes.txt", (r) => lines.set(r.route_id.trim(), (r.route_short_name || "").trim()));

  const trips = new Map(), byTrain = new Map(), shapeIds = new Set();
  await eachRow(ZIP, "trips.txt", (t) => {
    const date = services.get(t.service_id.trim());
    if (!date) return;
    const tripId = t.trip_id.trim();
    // trip_id = <núcleo><service>S<train><line>, e.g. 1003S27616C8b
    const m = /S(\d{4,5})/.exec(tripId);
    const train = m ? normTrain(m[1]) : null;
    const shapeId = (t.shape_id || "").trim() || null;
    trips.set(tripId, { tripId, train, line: lines.get(t.route_id.trim()) || "", date, shapeId, headsign: (t.trip_headsign || "").trim(), stops: [] });
    if (train) { if (!byTrain.has(train)) byTrain.set(train, []); byTrain.get(train).push(tripId); }
    if (shapeId) shapeIds.add(shapeId);
  });

  await eachRow(ZIP, "stop_times.txt", (st) => {
    const t = trips.get(st.trip_id.trim());
    if (t) t.stops.push({ seq: Number(st.stop_sequence), code: normCode(st.stop_id), arr: toMin(st.arrival_time), dep: toMin(st.departure_time) });
  });
  for (const t of trips.values()) t.stops.sort((a, b) => a.seq - b.seq);

  const shapes = new Map();
  await eachRow(ZIP, "shapes.txt", (s) => {
    const id = s.shape_id.trim();
    if (!shapeIds.has(id)) return;
    if (!shapes.has(id)) shapes.set(id, []);
    shapes.get(id).push([Number(s.shape_pt_sequence), Number(s.shape_pt_lat), Number(s.shape_pt_lon)]);
  });
  for (const [id, pts] of shapes) shapes.set(id, pts.sort((a, b) => a[0] - b[0]).map(([, lat, lon]) => [lat, lon]));

  Object.assign(cer, { trips, byTrain, shapes, dates: [today, tomorrow], loadedAt: new Date().toISOString() });
  const stops = [...trips.values()].reduce((a, t) => a + t.stops.length, 0);
  console.log(`[gtfs cer] ${trips.size} trips (${today}, ${tomorrow}), ${stops} stop times, ${shapes.size} shapes`);
}

/** Trip for a live Cercanías train: by trip id when the feed gives one, else by train number today. */
export function cerTrip(tripId, train) {
  if (tripId && cer.trips.has(tripId)) return cer.trips.get(tripId);
  const today = madridDate();
  for (const id of cer.byTrain.get(normTrain(train)) || []) { const t = cer.trips.get(id); if (t?.date === today) return t; }
  return null;
}

/** Shape of a trip trimmed to its first and last stop (shapes cover the whole line pattern). */
export function cerRoute(trip, stations) {
  const shape = trip?.shapeId && cer.shapes.get(trip.shapeId);
  if (!shape || shape.length < 2) return [];
  const near = (code) => {
    const s = stations.get(code); if (!s) return -1;
    let bi = 0, bd = Infinity;
    shape.forEach(([la, lo], i) => { const d = (la - s.lat) ** 2 + (lo - s.lon) ** 2; if (d < bd) { bd = d; bi = i; } });
    return bi;
  };
  const a = near(trip.stops[0]?.code), b = near(trip.stops.at(-1)?.code);
  if (a < 0 || b < 0 || a === b) return shape;
  return a < b ? shape.slice(a, b + 1) : shape.slice(b, a + 1).reverse();
}
