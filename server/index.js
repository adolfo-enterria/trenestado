import path from "node:path";
import express from "express";
import { createRequire } from "node:module";
import * as topojson from "topojson-client";
import { PORT, ROOT, EVERY } from "./config.js";
import { TYPES, productName, typeOf } from "./products.js";
import { REGIONS, ZONES, searchMunicipalities } from "./geo.js";
import { gtfs, tripFor, runsOn, normTrain, normCode, madridDate, madridMinutes } from "./sources/gtfs-static.js";
import { fetchSalidas } from "./sources/renfe.js";
import { cerTrip, cerRoute } from "./sources/gtfs-cercanias.js";
import { shortName, lineKey, cityName } from "./lines.js";
import { state, isCancelled, cancelledOn } from "./state.js";
import { db, stmts } from "./db.js";
import { computeStats, WINDOWS } from "./stats.js";
import { startCollector } from "./collector.js";
import { networkSegments, pathForStops } from "./rail.js";
import { exportInfo, streamExport } from "./export.js";

const app = express();
app.disable("x-powered-by");
const hhmm = (min) => (min == null ? null : String(Math.floor(((min % 1440) + 1440) % 1440 / 60)).padStart(2, "0") + ":" + String(((min % 60) + 60) % 60).padStart(2, "0"));
const yesterday = () => madridDate(new Date(Date.now() - 86400_000));

const stationOut = (code) => { const s = gtfs.stations.get(code); return s ? { n: s.name, c: shortName(code), lat: s.lat, lon: s.lon, reg: s.region, prov: s.province } : { n: shortName(code), c: shortName(code) }; };
const incidentsOut = () => [...state.incidents.adif, ...state.incidents.derived]
  .map(({ id, source, level, major, title, text, scope, path, seen, trains }) => ({ id, source, level, major, title, text, scope, path, seen, trains }))
  .sort((a, b) => ({ grave: 0, leve: 1, info: 2 }[a.level] - { grave: 0, leve: 1, info: 2 }[b.level]) || (b.seen || 0) - (a.seen || 0));

/** Parses "03303", "c23717" → { network, n, id }. */
function parseId(raw) {
  const s = String(raw || "").trim().toLowerCase();
  const network = s.startsWith("c") ? "cer" : "ld";
  const n = normTrain(s);
  return { network, n, id: network === "cer" ? "c" + n : n };
}

// ---------- punctuality ("llega tarde el X % de los días") ----------
const punctStmt = db.prepare(`SELECT COUNT(*) AS days, SUM(cancelled) AS cancelled,
    SUM(cancelled = 0 AND COALESCE(final_delay, last_delay) IS NOT NULL) AS ran,
    SUM(cancelled = 0 AND COALESCE(final_delay, last_delay) >= 5) AS late5,
    SUM(cancelled = 0 AND COALESCE(final_delay, last_delay) >= 15) AS late15,
    AVG(CASE WHEN cancelled = 0 THEN MAX(0, COALESCE(final_delay, last_delay)) END) AS avg_delay
  FROM train_runs WHERE network = ? AND train = ? AND service_date >= ? AND (service_date < ? OR finished = 1 OR cancelled = 1)`);
function punctuality(network, n, days = 30) {
  const since = madridDate(new Date(Date.now() - days * 86400_000));
  const r = punctStmt.get(network, n, since, madridDate());
  if (!r || !r.days) return { dias: 0 };
  return {
    dias: r.days, recorridos: r.ran || 0, cancelados: r.cancelled || 0,
    tarde5: r.ran ? Math.round((100 * r.late5) / r.ran) : null,
    tarde15: r.ran ? Math.round((100 * r.late15) / r.ran) : null,
    retrasoMedio: r.avg_delay == null ? null : Math.round(r.avg_delay * 10) / 10,
  };
}

// ---------- static-ish data ----------
let citiesCache = null;
function mainCities() {
  if (citiesCache?.v === gtfs.loadedAt) return citiesCache.d;
  const count = new Map();
  for (const t of gtfs.trips.values()) for (const s of t.stops) count.set(s.code, (count.get(s.code) || 0) + 1);
  const seen = new Set(), d = [];
  for (const [code] of [...count].sort((a, b) => b[1] - a[1])) {
    const s = gtfs.stations.get(code); if (!s) continue;
    const city = cityName(code);
    if (seen.has(city)) continue;
    seen.add(city);
    d.push({ code, n: city, lat: s.lat, lon: s.lon });
    if (d.length >= 60) break;
  }
  citiesCache = { v: gtfs.loadedAt, d };
  return d;
}

app.get("/api/base", (req, res) => {
  res.json({ types: TYPES, zones: ZONES, regions: REGIONS, windows: Object.keys(WINDOWS), principales: mainCities(), pollSeconds: EVERY.live / 1000 });
});

// Land for the map, self-hosted (no tile provider/API key): Spain's regions + neighbouring countries.
const require = createRequire(import.meta.url);
let landCache = null;
function land() {
  if (landCache) return landCache;
  const round = (g) => JSON.parse(JSON.stringify(g, (k, v) => (typeof v === "number" ? Math.round(v * 1e3) / 1e3 : v)));
  const es = require("es-atlas/es/autonomous_regions.json");
  const world = require("world-atlas/countries-50m.json");
  const near = new Set(["620", "250", "020", "504", "012"]);
  landCache = {
    spain: round(topojson.feature(es, es.objects.autonomous_regions)),
    borders: round(topojson.mesh(es, es.objects.autonomous_regions, (a, b) => a !== b)),
    neighbours: round({ type: "FeatureCollection", features: topojson.feature(world, world.objects.countries).features.filter((f) => near.has(f.id)) }),
  };
  return landCache;
}
app.get("/api/tierra", (req, res) => res.set("Cache-Control", "public, max-age=86400").json(land()));

let redCache = null;
app.get("/api/red", (req, res) => {
  if (!redCache || redCache.v !== gtfs.loadedAt) redCache = { v: gtfs.loadedAt, d: networkSegments().map((s) => s.map((x) => Math.round(x * 1e4) / 1e4)) };
  res.set("Cache-Control", "public, max-age=3600").json(redCache.d);
});

let redCerCache = null;
app.get("/api/red-cercanias", (req, res) => {
  const g = state.cercaniasLines;
  if (!g) return res.status(503).json({ error: "Líneas de Cercanías aún no cargadas" });
  if (redCerCache?.v !== g) {
    const r = (c) => (typeof c[0] === "number" ? [Math.round(c[1] * 1e4) / 1e4, Math.round(c[0] * 1e4) / 1e4] : c.map(r)); // → [lat, lon]
    redCerCache = { v: g, d: g.features.map((f) => ({ l: f.properties.CODIGO, n: f.properties.NUCLEO, c: f.properties.COLOR, g: r(f.geometry.coordinates), multi: f.geometry.type === "MultiLineString" })) };
  }
  res.set("Cache-Control", "public, max-age=3600").json(redCerCache.d);
});

// ---------- live ----------
app.get("/api/estado", (req, res) => {
  const trenes = [], codes = new Set();
  for (const t of state.trains.values()) {
    trenes.push({
      id: t.id, n: t.n, red: t.network, p: t.p, tipo: t.type, nom: t.nom, linea: t.line, nucleo: t.nucleoName,
      lat: t.lat, lon: t.lon, ts: t.ts, kmh: t.kmh, rumbo: t.heading,
      vlat: t.vlat, vlon: t.vlon, ret: t.ret, ant: t.ant, sig: t.sig, ori: t.ori, des: t.des, hs: t.hs, lleg: t.lleg, sal: t.sal,
      acc: t.acc, mat: t.mat, via: t.via, dreg: t.destRegion, dprov: t.destProvince, parado: t.stoppedMin, entre: t.between,
    });
    for (const c of [t.ant, t.sig, t.ori, t.des]) codes.add(c);
  }
  const est = {};
  for (const c of codes) est[c] = stationOut(c);
  res.set("Cache-Control", "no-store").json({
    generado: new Date().toISOString(),
    flotaHora: state.fleetUpdated,
    sinPosicion: state.noPosition || 0,
    fuentes: state.sources,
    adifHora: state.incidents.adifReadAt,
    red: gtfs.loadedAt,
    trenes, est,
    incidencias: incidentsOut(),
    avisosRenfe: state.incidents.renfe.length,
    proximidad: state.proximity,
    cancelados: cancelledOn(madridDate()),
  });
});

app.get("/api/incidencias", (req, res) => {
  res.json({ incidencias: incidentsOut(), avisosRenfe: state.incidents.renfe, fuentes: { adif: state.sources.adif, renfeAlerts: state.sources.renfeAlerts } });
});

app.get("/api/puntualidad/:id", (req, res) => {
  const { network, n } = parseId(req.params.id);
  res.json(punctuality(network, n));
});

// ---------- train page ----------
app.get("/api/tren/:id", (req, res) => {
  const { network, n, id } = parseId(req.params.id);
  if (n === "00000") return res.status(400).json({ error: "Número de tren no válido" });
  const live = state.trains.get(id) || null;
  const since = madridDate(new Date(Date.now() - 30 * 86400_000));
  const history = stmts.trainHistory.all(n, network, since);
  const historial = { ...punctuality(network, n), dias_detalle: history };
  const base = { id, n, red: network, proximidad: state.proximity.filter((p) => p.follower === id || p.leader === id), historial };

  if (network === "cer") {
    // Cercanías timetable: today's and tomorrow's trips from Renfe's Cercanías GTFS (sources/gtfs-cercanias.js)
    const trip = cerTrip(live?.tripId, n);
    const nowMin = madridMinutes();
    let status;
    if (live) status = "circulando";
    else if (!trip) status = history.some((h) => h.service_date === madridDate()) ? "finalizado" : "sin-posicion";
    else if (nowMin < trip.stops[0].dep) status = "programado";
    else if (nowMin > trip.stops.at(-1).arr + 15) status = "finalizado";
    else status = "sin-posicion";
    const delay = live?.ret ?? 0;
    let passedIdx = -1;
    if (trip && live) {
      const iAct = trip.stops.findIndex((s) => s.code === live.ant);
      passedIdx = live.ant === live.sig ? iAct - 1 : iAct;
    } else if (trip) passedIdx = trip.stops.reduce((acc, s, i) => ((s.dep ?? s.arr) + delay < nowMin ? i : acc), -1);
    const stops = trip ? trip.stops.map((s, i) => ({
      code: s.code, n: shortName(s.code), full: gtfs.stations.get(s.code)?.name, lat: gtfs.stations.get(s.code)?.lat, lon: gtfs.stations.get(s.code)?.lon,
      arr: hhmm(s.arr), dep: hhmm(s.dep),
      est: hhmm((i === 0 ? s.dep : s.arr) == null ? null : (i === 0 ? s.dep : s.arr) + Math.max(0, delay)),
      estado: i <= passedIdx ? "pasado" : live && (s.code === live.sig || (live.ant === live.sig && s.code === live.ant)) ? "siguiente" : "pendiente",
    })) : [];
    const nucleo = live?.nucleoName;
    return res.json({
      ...base, product: null, nom: live?.nom || (trip ? `Cercanías ${trip.line}` : "Cercanías"), tipo: "cer",
      linea: live?.lineKey || (trip ? trip.line : null), status, delay,
      live: live && { ...live, antN: shortName(live.ant), sigN: shortName(live.sig) },
      origen: trip ? shortName(trip.stops[0].code) : live && shortName(live.ori),
      destino: trip ? shortName(trip.stops.at(-1).code) : live && shortName(live.des),
      nucleo, stops, ruta: trip ? cerRoute(trip, gtfs.stations) : [], incidencias: [],
    });
  }

  const today = madridDate();
  const track = state.track.get(id);
  const trip = track?.trip || tripFor(n, today);
  const nowMin = madridMinutes();
  let status;
  if (live) status = "circulando";
  else if (isCancelled(n, today)) status = "cancelado";
  else if (!trip) status = gtfs.byTrain.has(n) ? "no-circula-hoy" : "desconocido";
  else if (nowMin < trip.stops[0].dep) status = "programado";
  else if (nowMin > trip.stops.at(-1).arr + 30) status = "finalizado";
  else status = "sin-posicion";

  const delay = live?.ret ?? (state.rtDelays.has(n) ? Math.round(state.rtDelays.get(n) / 60) : 0);
  let passedIdx = -1;
  if (trip && live) {
    const iAnt = trip.stops.findIndex((s) => s.code === live.ant);
    passedIdx = live.ant === live.sig ? iAnt - 1 : iAnt;
  } else if (trip) passedIdx = trip.stops.reduce((acc, s, i) => ((s.dep ?? s.arr) + delay < nowMin ? i : acc), -1);
  const stops = trip ? trip.stops.map((s, i) => ({
    code: s.code, n: shortName(s.code), full: gtfs.stations.get(s.code)?.name, lat: gtfs.stations.get(s.code)?.lat, lon: gtfs.stations.get(s.code)?.lon,
    arr: hhmm(s.arr), dep: hhmm(s.dep),
    est: hhmm((i === 0 ? s.dep : s.arr) == null ? null : (i === 0 ? s.dep : s.arr) + Math.max(0, delay)),
    estado: i <= passedIdx ? "pasado" : live && (s.code === live.sig || (live.ant === live.sig && s.code === live.ant)) ? "siguiente" : "pendiente",
  })) : [];
  const product = live?.p ?? trip?.product ?? null;
  const linea = trip ? lineKey(trip.stops[0].code, trip.stops.at(-1).code) : live && lineKey(live.ori, live.des);
  res.json({
    ...base, product, nom: product != null ? productName(product) : trip?.routeName || "Tren", tipo: product != null ? typeOf(product).id : null,
    status, delay, live: live && { ...live, antN: shortName(live.ant), sigN: shortName(live.sig) },
    origen: trip ? shortName(trip.stops[0].code) : live && shortName(live.ori),
    destino: trip ? shortName(trip.stops.at(-1).code) : live && shortName(live.des),
    linea, stops,
    ruta: trip ? pathForStops(trip.stops.map((s) => s.code)) : [],
    incidencias: incidentsOut().filter((i) => i.trains?.includes(n) || (linea && i.scope === linea)),
  });
});

// ---------- station departure/arrival boards ----------
const salidasCache = new Map(); // code → { at, rows | error }
async function cercaniasBoard(code) {
  const c = salidasCache.get(code);
  if (c && Date.now() - c.at < 30_000) return c;
  let v;
  try { v = { at: Date.now(), rows: await fetchSalidas(code) }; }
  catch (e) { v = { at: Date.now(), rows: [], error: e.status === 404 ? null : e.message }; }
  salidasCache.set(code, v);
  if (salidasCache.size > 300) salidasCache.delete(salidasCache.keys().next().value);
  return v;
}

/** LD/MD departures or arrivals at a station from the GTFS timetable + live delays + cancellations. */
function ldBoard(code, kind, fromMin, toMin) {
  const out = [];
  const today = madridDate(), yday = yesterday();
  for (const { trip, i } of gtfs.byStation.get(code) || []) {
    const st = trip.stops[i];
    const last = i === trip.stops.length - 1, first = i === 0;
    if (kind === "salidas" ? last : first) continue; // no departures at the terminus, no arrivals at the origin
    const t0 = kind === "salidas" ? st.dep : st.arr;
    if (t0 == null) continue;
    for (const [date, shift] of [[today, 0], [yday, -1440]]) {
      const t = t0 + shift;
      if (t < fromMin - 30 || t > toMin || !runsOn(trip.serviceId, date)) continue;
      const live = state.trains.get(trip.train);
      const isLive = live && (state.track.get(trip.train)?.trip?.tripId === trip.tripId || !state.track.get(trip.train)?.trip);
      const cancelled = isCancelled(trip.train, date);
      const delay = isLive ? live.ret : state.rtDelays.has(trip.train) ? Math.round(state.rtDelays.get(trip.train) / 60) : null;
      let estado = cancelled ? "cancelado" : isLive ? "circulando" : "programado";
      if (isLive) {
        const iAnt = trip.stops.findIndex((s) => s.code === live.ant);
        if (iAnt > i || (iAnt === i && live.ant !== live.sig && kind === "salidas")) estado = kind === "salidas" ? "salido" : "llegado";
      }
      const est = t + Math.max(0, delay || 0);
      if (est < fromMin - (estado === "programado" ? 5 : 10)) continue;
      const other = kind === "salidas" ? trip.stops.at(-1).code : trip.stops[0].code;
      out.push({ red: "ld", id: trip.train, n: trip.train, nom: trip.product != null ? productName(trip.product) : trip.routeName,
        hora: hhmm(t), est: delay ? hhmm(est) : null, retraso: delay, min: est, otro: shortName(other), via: null, estado });
      break;
    }
  }
  return out;
}

app.get("/api/estacion/:code", async (req, res) => {
  const code = normCode(req.params.code);
  const s = gtfs.stations.get(code);
  if (!s) return res.status(404).json({ error: "Estación desconocida" });
  const kind = req.query.tipo === "llegadas" ? "llegadas" : "salidas";
  const now = madridMinutes(), to = now + 180;
  const rows = ldBoard(code, kind, now, to);
  let cer = { rows: [] };
  if (kind === "salidas") {
    cer = await cercaniasBoard(code);
    for (const r of cer.rows) {
      const p = r.planned ? Number(r.planned.slice(0, 2)) * 60 + Number(r.planned.slice(3)) : null;
      const e = r.real ? Number(r.real.slice(0, 2)) * 60 + Number(r.real.slice(3)) : p;
      if (p == null) continue;
      let min = e; if (min < now - 600) min += 1440;
      const delay = e != null && p != null ? (((e - p) % 1440) + 1440 + 720) % 1440 - 720 : null;
      rows.push({ red: "cer", id: "c" + r.train, n: r.train, nom: `Cercanías ${r.line || ""}`.trim(), linea: r.line,
        hora: r.planned, est: delay ? r.real : null, retraso: delay, min, otro: r.destName || shortName(r.dest), via: r.platform,
        estado: state.trains.has("c" + r.train) ? "circulando" : "programado" });
    }
  }
  rows.sort((a, b) => a.min - b.min);
  res.json({
    code, nombre: s.name, region: s.regionName, lat: s.lat, lon: s.lon, tipo: kind,
    cercanias: kind === "salidas" ? (cer.rows.length ? "ok" : cer.error ? "error" : "sin-datos") : "no-disponible",
    filas: rows.slice(0, 60),
  });
});

// ---------- search ----------
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
app.get("/api/buscar", (req, res) => {
  const raw = String(req.query.q || "").trim().slice(0, 60);
  if (!raw) return res.json({ trenes: [], estaciones: [], lugares: [] });
  const digits = raw.replace(/\D/g, "");
  const trenes = [];
  if (digits.length >= 2) {
    const want = digits.replace(/^0+/, "");
    const seen = new Set();
    const add = (id) => {
      if (seen.has(id) || trenes.length >= 15) return;
      seen.add(id);
      const { network, n } = parseId(id);
      const l = state.trains.get(id);
      const trip = network === "ld" ? tripFor(n) : null;
      const p = l?.p ?? trip?.product;
      trenes.push({
        id, n, red: network, nom: l?.nom || (p != null ? productName(p) : trip?.routeName || "Tren"), vivo: !!l, ret: l?.ret ?? null,
        ruta: trip ? `${shortName(trip.stops[0].code)} → ${shortName(trip.stops.at(-1).code)}` : l ? `${shortName(l.ori)} → ${shortName(l.des)}` : null,
        sal: trip ? hhmm(trip.stops[0].dep) : null, hoy: !!trip || !!l, puntualidad: punctuality(network, n),
      });
    };
    const bare = (x) => x.replace(/^c/, "").replace(/^0+/, "");
    for (const id of state.trains.keys()) if (bare(id) === want) add(id);
    if (gtfs.byTrain.has(normTrain(want))) add(normTrain(want));
    for (const id of state.trains.keys()) if (bare(id).startsWith(want)) add(id);
    for (const n of gtfs.byTrain.keys()) if (n.replace(/^0+/, "").startsWith(want)) add(n);
  }
  const estaciones = [];
  const q = norm(raw);
  if (q.replace(/\d/g, "").trim().length >= 3) {
    const hits = [...gtfs.stations.values()].filter((s) => norm(s.name).includes(q));
    // LD stations first (they have both boards), then by name length
    hits.sort((a, b) => (gtfs.byStation.has(b.code) - gtfs.byStation.has(a.code)) || a.name.length - b.name.length);
    for (const s of hits.slice(0, 8)) {
      const n = [...state.trains.values()].filter((t) => t.ori === s.code || t.des === s.code || t.sig === s.code).length;
      estaciones.push({ code: s.code, n: s.name, reg: s.regionName, lat: s.lat, lon: s.lon, ahora: n });
    }
  }
  res.json({ trenes, estaciones, lugares: digits.length >= 2 && digits.length === raw.replace(/\s/g, "").length ? [] : searchMunicipalities(raw) });
});

app.get("/api/stats", (req, res) => {
  const w = WINDOWS[req.query.w] !== undefined ? req.query.w : "1D";
  const types = String(req.query.tipos || "").split(",").filter((t) => TYPES.some((x) => x.id === t && !x.noData));
  const region = REGIONS.some((r) => r.id === req.query.region) ? req.query.region : null;
  try { res.json(computeStats({ w, types, region })); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get("/api/export/info", (req, res) => res.json(exportInfo()));
app.get("/api/export", streamExport);

app.get("/api/fuentes", (req, res) => res.json({ fuentes: state.sources, gtfs: { cargado: gtfs.loadedAt, estaciones: gtfs.stations.size, viajes: gtfs.trips.size } }));

app.use(express.static(path.join(ROOT, "public"), { extensions: ["html"] }));
app.use("/vendor/leaflet", express.static(path.join(ROOT, "node_modules/leaflet/dist")));
app.use("/vendor/chart.js", express.static(path.join(ROOT, "node_modules/chart.js/dist")));
app.use("/vendor/maplibre-gl", express.static(path.join(ROOT, "node_modules/maplibre-gl/dist")));
app.use("/vendor/maplibre-gl-leaflet", express.static(path.join(ROOT, "node_modules/@maplibre/maplibre-gl-leaflet")));

app.listen(PORT, () => console.log(`trenestado → http://localhost:${PORT} (datos cada ${EVERY.live / 1000} s)`));
startCollector().catch((e) => console.error("collector failed to start:", e));
