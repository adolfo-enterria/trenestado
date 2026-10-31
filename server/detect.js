// Derived signals: stopped trains, mass cancellations, proximity anomalies.
import { PROXIMITY, STOPPED } from "./config.js";
import { haversineKm, headingDiff } from "./geo.js";
import { gtfs, tripFor, madridDate } from "./sources/gtfs-static.js";
import { lineKey, shortName } from "./lines.js";
import { state } from "./state.js";

/** Distance (km) to the nearest station, equirectangular approximation (fine at this scale). */
export function nearestStationKm(lat, lon) {
  const k = Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (const s of gtfs.stations.values()) {
    const dx = (s.lon - lon) * k, dy = s.lat - lat;
    const d = dx * dx + dy * dy;
    if (d < best) best = d;
  }
  return Math.sqrt(best) * 111.2;
}

const pathOf = (codes) => codes.map((c) => gtfs.stations.get(c)).filter(Boolean).map((s) => [s.lat, s.lon]);

/** Incidents we can infer from the feeds themselves. */
export function derivedIncidents(now = Date.now()) {
  const out = [];
  // 1) Several cancellations on the same corridor today (GTFS-RT CANCELED).
  const today = madridDate();
  const byLine = new Map();
  for (const c of new Map([...state.cancelled.values()].filter((x) => x.date === today).map((x) => [x.train, x])).values()) {
    const trip = tripFor(c.train, c.date || today);
    if (!trip || !trip.stops.length) continue;
    const key = lineKey(trip.stops[0].code, trip.stops.at(-1).code);
    if (!byLine.has(key)) byLine.set(key, { trains: [], trip });
    byLine.get(key).trains.push(c.train);
  }
  for (const [key, { trains, trip }] of byLine) {
    if (trains.length < 3) continue;
    out.push({
      id: "der-cancel-" + today + "-" + key,
      source: "derivado", level: "grave", major: true,
      title: `${trains.length} trenes cancelados hoy en ${key}`,
      text: [`Renfe marca como cancelados los trenes ${trains.slice(0, 12).join(", ")}${trains.length > 12 ? "…" : ""}.`],
      scope: key, path: pathOf(trip.stops.map((s) => s.code)),
    });
  }
  // 2) Trains stopped between stations for a long time.
  for (const t of state.trains.values()) {
    if (t.network !== "ld" || !t.stoppedMin || t.stoppedMin < STOPPED.majorMinutes || !t.between) continue;
    const rise = t.ret - (state.track.get(t.id)?.delayAtStop ?? t.ret);
    const major = rise >= STOPPED.majorDelayRise;
    out.push({
      id: "der-stop-" + t.n + "-" + (state.track.get(t.id)?.stoppedSince || 0),
      source: "derivado", level: major ? "grave" : "leve", major,
      title: `Tren ${t.n} detenido ${t.stoppedMin} min entre ${shortName(t.ant)} y ${shortName(t.sig)}`,
      text: [`Lleva ${t.stoppedMin} minutos parado fuera de estación; su retraso ha subido ${Math.max(0, rise)} min desde que se detuvo.`],
      scope: shortName(t.ori) + " → " + shortName(t.des),
      path: pathOf([t.ant, t.sig]), trains: [t.n],
    });
  }
  return out;
}

/** Pairs of trains closer than the follower's braking distance. Experimental — see requirements §2.5. */
export function proximityAnomalies(now = Date.now()) {
  const P = PROXIMITY;
  // LD only: Cercanías positions have no fix timestamp and run on dense multi-track urban lines
  const cand = [...state.trains.values()].filter((t) => t.network === "ld" &&
    t.kmh != null && t.kmh >= P.minKmh && t.heading != null && now - t.ts < P.maxFixAgeS * 1000 + 15_000 && !t.nearStation);
  const seen = new Set(), out = [];
  for (let i = 0; i < cand.length; i++) for (let j = i + 1; j < cand.length; j++) {
    const a = cand[i], b = cand[j];
    const sameSection = (a.ant === b.ant && a.sig === b.sig) || a.sig === b.ant || b.sig === a.ant;
    if (!sameSection || headingDiff(a.heading, b.heading) > P.maxHeadingDiff) continue;
    // project both to the same instant
    const t0 = Math.max(a.ts, b.ts);
    const pa = [a.lat + a.vlat * (t0 - a.ts) / 1000, a.lon + a.vlon * (t0 - a.ts) / 1000];
    const pb = [b.lat + b.vlat * (t0 - b.ts) / 1000, b.lon + b.vlon * (t0 - b.ts) / 1000];
    const dist = haversineKm(pa[0], pa[1], pb[0], pb[1]) * 1000;
    // follower = the one whose heading points at the other
    const toB = Math.atan2(pb[1] - pa[1], pb[0] - pa[0]) * 180 / Math.PI;
    const aFollows = headingDiff((toB + 360) % 360, a.heading) < 90;
    const follower = aFollows ? a : b, leader = aFollows ? b : a;
    const v = follower.kmh / 3.6;
    const required = (v * v) / (2 * P.decel) + P.marginM;
    const key = [a.n, b.n].sort().join("|");
    if (dist >= required) continue;
    // < 100 m at the same speed = two train numbers running coupled as one consist, not two trains
    if (dist < 100 && Math.abs(a.kmh - b.kmh) < 10) continue;
    seen.add(key);
    const streak = (state.proximityStreak.get(key) || 0) + 1;
    state.proximityStreak.set(key, streak);
    if (streak < P.persistCycles) continue;
    out.push({
      id: "prox-" + key, follower: follower.n, leader: leader.n, distM: Math.round(dist), requiredM: Math.round(required),
      kmh: [follower.kmh, leader.kmh], lat: (pa[0] + pb[0]) / 2, lon: (pa[1] + pb[1]) / 2, firstFired: streak === P.persistCycles,
    });
  }
  for (const k of state.proximityStreak.keys()) if (!seen.has(k)) state.proximityStreak.delete(k);
  return out;
}
