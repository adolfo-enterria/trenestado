// Polling loops: Renfe live fleet → state + persistence; GTFS-RT; notices; Adif; GTFS static.
import { EVERY, URLS, STOPPED, DELAY } from "./config.js";
import { haversineKm, bearingDeg, municipality } from "./geo.js";
import { typeOf, productName } from "./products.js";
import { gtfs, loadGtfs, tripFor, scheduledOn, madridDate, madridMinutes } from "./sources/gtfs-static.js";
import { fetchFleet, fetchCercanias, fetchCercaniasLines, fetchTripUpdatesLD, fetchRenfeAlerts, fetchGtfsRtAlerts } from "./sources/renfe.js";
import { fetchAdif } from "./sources/adif.js";
import { loadCercaniasGtfs } from "./sources/gtfs-cercanias.js";
import { lineKey } from "./lines.js";
import { state, sourceOk, sourceFail } from "./state.js";
import { stmts, tx, cleanup, meta } from "./db.js";
import { nearestStationKm, derivedIncidents, proximityAnomalies } from "./detect.js";
import { routePoints } from "./rail.js";

const hhmm = (min) => (min == null ? null : String(Math.floor(min / 60) % 24).padStart(2, "0") + ":" + String(min % 60).padStart(2, "0"));
const yesterday = () => madridDate(new Date(Date.now() - 86400_000));

function madridHour(ts) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ts));
  const g = (t) => p.find((x) => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}`;
}

/** GTFS trip for a live train: today's, or yesterday's if it started before midnight. */
function tripOf(n) {
  const today = madridDate();
  const t = tripFor(n, today);
  if (t && t.stops[0].dep <= madridMinutes() + 60) return { trip: t, date: today };
  const y = tripFor(n, yesterday());
  if (y && y.stops.at(-1).arr >= 24 * 60) return { trip: y, date: yesterday() };
  return t ? { trip: t, date: today } : { trip: null, date: today };
}

// ---------- Live fleets (LD/MD + Cercanías) ----------
// Speed/heading from consecutive fixes. Returns the track record for this train id.
function updateTrack(id, lat, lon, ts, now, maxKmh = 320) {
  let tr = state.track.get(id);
  if (!tr) { tr = { lat, lon, ts, kmh: null, heading: null, vlat: 0, vlon: 0 }; state.track.set(id, tr); }
  else if (ts > tr.ts) {
    const dt = (ts - tr.ts) / 1000;
    if (dt >= 10 && dt <= 300) {
      const km = haversineKm(tr.lat, tr.lon, lat, lon);
      const kmh = (km / dt) * 3600;
      if (kmh <= maxKmh) { // above the line's top speed (310 km/h HSL, 160 km/h Cercanías) it's GPS/feed jitter
        tr.kmh = tr.kmh == null ? kmh : 0.6 * kmh + 0.4 * tr.kmh;
        if (km > 0.03) tr.heading = bearingDeg(tr.lat, tr.lon, lat, lon);
        const moving = tr.kmh >= STOPPED.kmh;
        tr.vlat = moving ? (lat - tr.lat) / dt : 0;
        tr.vlon = moving ? (lon - tr.lon) / dt : 0;
      }
      tr.lat = lat; tr.lon = lon; tr.ts = ts;
    } else if (dt > 300) { tr.kmh = null; tr.vlat = tr.vlon = 0; tr.lat = lat; tr.lon = lon; tr.ts = ts; }
    // dt < 10 s: keep the older fix as the reference so the next speed uses a longer baseline
  }
  tr.lastSeen = now;
  return tr;
}
const validPos = (r) => isFinite(r.lat) && isFinite(r.lon) && !(r.lat === 0 && r.lon === 0);
const stoppedInfo = (tr, ts, ret) => {
  const stopped = tr.kmh != null && tr.kmh < STOPPED.kmh;
  if (stopped) { tr.stoppedSince ??= ts; tr.delayAtStop ??= ret; } else { tr.stoppedSince = null; tr.delayAtStop = null; }
  return tr.stoppedSince ? Math.round((ts - tr.stoppedSince) / 60000) : 0;
};

function processLD(fleet, now, trains, present) {
  let noPosition = 0;
  for (const r of fleet.trains) {
    if (!validPos(r)) { noPosition++; continue; }
    const id = r.n;
    present.add(id);
    const tr = updateTrack(id, r.lat, r.lon, r.ts, now);
    tr.network = "ld";
    const stoppedMin = stoppedInfo(tr, r.ts, r.ret);
    const { trip, date } = tr.trip && tr.runDate ? { trip: tr.trip, date: tr.runDate } : tripOf(r.n);
    tr.trip = trip; tr.runDate = date;
    const destStop = trip?.stops.find((s) => s.code === r.des) || trip?.stops.at(-1);
    const dest = gtfs.stations.get(r.des);
    const nearStation = nearestStationKm(r.lat, r.lon) < 1.5;
    if (r.sig === r.des || r.ant === r.des) tr.nearDest = true;
    trains.set(id, {
      id, n: r.n, network: "ld", p: r.p, type: typeOf(r.p).id, nom: productName(r.p),
      lat: r.lat, lon: r.lon, ts: r.ts,
      kmh: tr.kmh == null ? null : Math.round(tr.kmh), heading: tr.heading == null ? null : Math.round(tr.heading),
      vlat: tr.vlat, vlon: tr.vlon,
      ret: r.ret, ant: r.ant, sig: r.sig, ori: r.ori, des: r.des,
      hs: r.nextAt ? r.nextAt.slice(11, 16) : null,
      lleg: hhmm(destStop?.arr ?? null), sal: hhmm(trip?.stops[0]?.dep ?? null),
      acc: r.acc, mat: r.mat,
      destRegion: dest?.region ?? null, destProvince: dest?.province ?? null,
      nearStation, between: r.ant !== r.sig && !nearStation, stoppedMin,
      lineKey: lineKey(r.ori, r.des),
    });
  }
  return noPosition;
}

// Cercanías positions have no per-train timestamp: the fetch time stands in for it.
function processCer(fleet, now, trains, present) {
  for (const r of fleet.trains) {
    if (!validPos(r)) continue;
    // Some regional services (Rodalies R14/R16/R2S, Cantabria/Bilbao) appear in both feeds, sometimes with
    // positions 20 km apart. Same number + same origin or destination = same train: keep the LD copy (it has the timetable).
    const twin = trains.get(r.n);
    if (twin && (twin.ori === r.ori || twin.des === r.des || haversineKm(twin.lat, twin.lon, r.lat, r.lon) < 3)) continue;
    const id = "c" + r.n;
    present.add(id);
    const tr = updateTrack(id, r.lat, r.lon, now, now, 160); // fetch time stands in for the fix time: positions can jump
    tr.network = "cer";
    tr.runDate ??= madridDate();
    const stoppedMin = stoppedInfo(tr, now, r.ret);
    const dest = gtfs.stations.get(r.des);
    const nearStation = nearestStationKm(r.lat, r.lon) < 0.6;
    if (r.sig === r.des || r.act === r.des) tr.nearDest = true;
    const nucleoName = state.nucleos.get(r.nucleo) || "Cercanías";
    trains.set(id, {
      id, n: r.n, network: "cer", p: null, type: "cer", nom: `Cercanías ${r.line}`.trim(), line: r.line, nucleo: r.nucleo, nucleoName, tripId: r.tripId,
      lat: r.lat, lon: r.lon, ts: now,
      kmh: tr.kmh == null ? null : Math.round(tr.kmh), heading: tr.heading == null ? null : Math.round(tr.heading),
      vlat: tr.vlat, vlon: tr.vlon,
      ret: r.ret, ant: r.act, sig: r.sig, ori: r.ori, des: r.des,
      hs: r.nextAt ? String(r.nextAt).slice(11, 16) : null, lleg: null, sal: null,
      acc: r.acc, via: r.via, nextVia: r.nextVia,
      destRegion: dest?.region ?? null, destProvince: dest?.province ?? null,
      nearStation, between: r.act !== r.sig && !nearStation, stoppedMin,
      lineKey: `${nucleoName} ${r.line}`.trim(),
    });
  }
}

async function liveCycle() {
  const [ld, cer] = await Promise.allSettled([fetchFleet(), fetchCercanias()]);
  const now = Date.now();
  if (ld.status === "fulfilled") sourceOk("renfe", { fleetUpdated: ld.value.updated }); else sourceFail("renfe", ld.reason);
  if (cer.status === "fulfilled") sourceOk("cercanias", { count: cer.value.trains.length }); else sourceFail("cercanias", cer.reason);
  if (ld.status === "rejected" && cer.status === "rejected") return;
  if (!meta.get("collecting_since")) meta.set("collecting_since", now);

  const trains = new Map(), present = new Set();
  // a network whose feed failed keeps its last known trains (and they don't count as "gone")
  const keep = (net) => { for (const [id, t] of state.trains) if (t.network === net) { trains.set(id, t); present.add(id); } };
  if (ld.status === "fulfilled") { state.fleetUpdated = ld.value.updated; state.noPosition = processLD(ld.value, now, trains, present); } else keep("ld");
  if (cer.status === "fulfilled") processCer(cer.value, now, trains, present); else keep("cer");

  // Renfe's feeds sometimes return a partial snapshot (seen: 146 Cercanías trains, then 215 a minute later).
  // A train missing for less than ~2.5 min stays at its last known position and isn't treated as gone.
  for (const [id, t] of state.trains) {
    if (present.has(id)) continue;
    const tr = state.track.get(id);
    if (tr && now - (tr.lastSeen || 0) < 150_000) { trains.set(id, { ...t, stale: true }); present.add(id); }
  }

  // trains that left the feed: finished if they had reached their destination
  const gone = [];
  for (const [id, tr] of state.track) {
    if (present.has(id)) continue;
    const prev = state.trains.get(id);
    if (prev && tr.nearDest) gone.push([tr.runDate, prev.network, prev.n]);
    if (now - (tr.lastSeen || 0) > 2 * 3600_000) state.track.delete(id);
    else if (prev) tr.nearDest = false;
  }
  state.trains = trains;

  // persistence
  const hour = madridHour(now);
  const byType = new Map();
  try {
    tx(() => {
      for (const t of trains.values()) {
        if (t.stale) continue; // not in this snapshot: nothing new to record
        const tr = state.track.get(t.id);
        stmts.upsertRun.run({
          service_date: tr.runDate, network: t.network, train: t.n, product: t.p, type: t.type, origin: t.ori, dest: t.des,
          dest_region: t.destRegion, line_key: t.lineKey,
          sched_dep: tr.trip?.stops[0]?.dep ?? null, sched_arr: tr.trip?.stops.at(-1)?.arr ?? null,
          ts: now, delay: t.ret, kmh: t.kmh,
        });
        const h = byType.get(t.type) || { obs: 0, delay_sum: 0, d5: 0, d15: 0 };
        h.obs++; h.delay_sum += Math.max(0, t.ret); if (t.ret >= DELAY.leve) h.d5++; if (t.ret >= DELAY.grave) h.d15++;
        byType.set(t.type, h);
      }
      for (const [d, net, n] of gone) stmts.finishRun.run(d, net, n);
      for (const [type, h] of byType) stmts.addHourly.run({ hour, type, ...h });
    });
  } catch (e) { console.error("[db] live persist:", e.message); }

  // detections
  state.proximity = proximityAnomalies(now);
  for (const a of state.proximity) if (a.firstFired) {
    try { stmts.addProximity.run(now, a.follower, a.leader, a.distM, a.requiredM, a.kmh[0], a.kmh[1], a.lat, a.lon); } catch {}
  }
  refreshDerived(now);
}

function refreshDerived(now = Date.now()) {
  state.incidents.derived = derivedIncidents(now);
  persistIncidents(state.incidents.derived, now);
}

function persistIncidents(list, now) {
  try {
    tx(() => {
      for (const i of list) stmts.upsertIncident.run({ id: i.id, source: i.source, level: i.level, major: i.major ? 1 : 0, title: i.title, body: i.text.join("\n"), scope: i.scope || "", ts: now });
    });
    for (const i of list) i.seen = Number(stmts.incidentFirstSeen.get(i.id)?.first_seen || now);
  } catch (e) { console.error("[db] incidents:", e.message); }
}

// ---------- GTFS-RT ----------
async function gtfsRtCycle() {
  try {
    const tu = await fetchTripUpdatesLD();
    state.rtDelays = tu.delays;
    state.cancelled = new Map(tu.cancelled.map((c) => { c.date ||= madridDate(); return [c.train + "|" + c.date, c]; }));
    sourceOk("gtfsRt", { cancelled: tu.cancelled.length, added: tu.added.length });
    const now = Date.now();
    tx(() => {
      for (const c of tu.cancelled) {
        const date = c.date || madridDate();
        const trip = tripFor(c.train, date);
        const o = trip?.stops[0], d = trip?.stops.at(-1);
        const dest = d && gtfs.stations.get(d.code);
        stmts.cancelRun.run({
          service_date: date, train: c.train, product: trip?.product ?? null, type: trip?.product != null ? typeOf(trip.product).id : null,
          origin: o?.code ?? null, dest: d?.code ?? null, dest_region: dest?.region ?? null,
          line_key: o && d ? lineKey(o.code, d.code) : null, sched_dep: o?.dep ?? null, sched_arr: d?.arr ?? null, ts: now,
        });
      }
    });
    refreshDerived(now);
  } catch (e) { sourceFail("gtfsRt", e); }
}

// ---------- Notices ----------
async function renfeAlertsCycle() {
  try {
    const [visor, rt] = await Promise.allSettled([fetchRenfeAlerts(), fetchGtfsRtAlerts()]);
    const list = [];
    if (visor.status === "fulfilled") list.push(...visor.value.map((a) => ({ id: a.id, text: a.text, scope: a.kind === "linea" ? `Línea ${a.line}` : "Estación", kind: a.kind })));
    if (rt.status === "fulfilled") list.push(...rt.value.map((a) => ({ id: a.id, text: a.text, scope: "Cercanías", kind: "servicio", start: a.start })));
    if (visor.status === "rejected" && rt.status === "rejected") throw visor.reason;
    state.incidents.renfe = list;
    sourceOk("renfeAlerts", { count: list.length });
  } catch (e) { sourceFail("renfeAlerts", e); }
}

const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
function findStation(name, { prefix = false } = {}) {
  const q = norm(name);
  if (q.length < 3) return null;
  for (const s of gtfs.stations.values()) {
    const n = norm(s.name);
    if (n === q || n.split(" ")[0] === q && n.split(" ").length === 1) return s;
    if (prefix && n.startsWith(q + " ")) return s;
  }
  return null;
}
// A place named in a notice: a station, else a municipality; tries shorter word prefixes ("Orgaz y Urda" → "Orgaz").
function findPlace(name) {
  const words = name.trim().split(/\s+/);
  // exact station or municipality, longest phrase first; prefix station matches only as a last resort
  for (let k = words.length; k >= 1; k--) {
    const q = words.slice(0, k).join(" ");
    const s = findStation(q);
    if (s) return [s.lat, s.lon];
    const m = municipality(q);
    if (m) return m;
  }
  const s = findStation(name, { prefix: true });
  return s ? [s.lat, s.lon] : null;
}
function adifPath(i) {
  for (const txt of [i.title, i.text.join(" ")]) {
    const m = txt.match(/entre (?:las estaciones de )?([A-ZÁÉÍÓÚÑ][\wáéíóúñü.' -]+?) y ([A-ZÁÉÍÓÚÑ][\wáéíóúñü.' -]+?)(?=[,.;:]| por | debido| a causa| en el | registran|$)/);
    if (!m) continue;
    const a = findPlace(m[1]), b = findPlace(m[2]);
    if (a && b && haversineKm(a[0], a[1], b[0], b[1]) < 150) return routePoints(a, b);
  }
  return null;
}

async function adifCycle() {
  try {
    const list = await fetchAdif();
    for (const i of list) i.path = adifPath(i);
    state.incidents.adif = list;
    state.incidents.adifReadAt = new Date().toISOString();
    sourceOk("adif", { count: list.length });
    persistIncidents(list, Date.now());
  } catch (e) { sourceFail("adif", e); }
}

// ---------- GTFS static & schedule ----------
async function gtfsCycle() {
  try {
    await loadGtfs();
    sourceOk("gtfs", { stations: gtfs.stations.size, trips: gtfs.trips.size });
    try { const l = await fetchCercaniasLines(); state.nucleos = l.nucleos; state.cercaniasLines = l.geo; } catch (e) { console.warn("[cercanías] lines:", e.message); }
    try { await loadCercaniasGtfs(); sourceOk("gtfsCercanias"); } catch (e) { sourceFail("gtfsCercanias", e); }
    recordScheduled();
  } catch (e) { sourceFail("gtfs", e); }
}
function recordScheduled() {
  const date = madridDate();
  const counts = new Map();
  for (const s of scheduledOn(date)) {
    const type = s.product != null ? typeOf(s.product).id : "md";
    const reg = gtfs.stations.get(s.dest)?.region || "";
    const k = type + "|" + reg;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  tx(() => { for (const [k, n] of counts) { const [type, reg] = k.split("|"); stmts.upsertScheduled.run(date, type, reg, n); } });
}

// ---------- Snapshots ----------
function snapshot() {
  const now = Date.now();
  const ts = Math.floor(now / EVERY.snapshot) * EVERY.snapshot;
  const g = new Map();
  for (const t of state.trains.values()) {
    const k = t.type + "|" + (t.destRegion || "");
    const s = g.get(k) || { trains: 0, d5: 0, d15: 0, sum: 0 };
    s.trains++; if (t.ret >= DELAY.leve) s.d5++; if (t.ret >= DELAY.grave) s.d15++; s.sum += Math.max(0, t.ret);
    g.set(k, s);
  }
  try { tx(() => { for (const [k, s] of g) { const [type, reg] = k.split("|"); stmts.addSnapshot.run(ts, type, reg, s.trains, s.d5, s.d15, s.sum); } }); }
  catch (e) { console.error("[db] snapshot:", e.message); }
}

function every(ms, fn) {
  let running = false;
  const run = async () => { if (running) return; running = true; try { await fn(); } catch (e) { console.error(e); } finally { running = false; } };
  setInterval(run, ms);
  return run;
}

export async function startCollector() {
  await gtfsCycle();
  every(EVERY.gtfsStatic, gtfsCycle);
  let lastDate = madridDate();
  every(60_000, () => { const d = madridDate(); if (d !== lastDate) { lastDate = d; recordScheduled(); } });
  await every(EVERY.gtfsRt, gtfsRtCycle)();
  // seed positions from Renfe's previous snapshot so speeds are available on the first cycle
  try {
    const prev = await fetchFleet(URLS.flotaLDAnterior);
    for (const r of prev.trains) if (isFinite(r.lat) && r.lat) state.track.set(r.n, { lat: r.lat, lon: r.lon, ts: r.ts, kmh: null, heading: null, vlat: 0, vlon: 0, lastSeen: Date.now() });
  } catch {}
  await every(EVERY.live, liveCycle)();
  every(EVERY.renfeAlerts, renfeAlertsCycle)();
  every(EVERY.adif, adifCycle)();
  every(EVERY.snapshot, snapshot);
  setTimeout(snapshot, 20_000);
  every(EVERY.cleanup, () => cleanup(Date.now(), madridDate()))();
}
