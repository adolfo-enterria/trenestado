// Real track geometry (OpenStreetMap, built by scripts/build-rail.mjs into assets/rail.json).
// Falls back to straight lines between GTFS stops when the file isn't there.
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";
import { haversineKm } from "./geo.js";
import { gtfs } from "./sources/gtfs-static.js";

const FILE = path.join(ROOT, "assets", "rail.json");
let R = null; // { lines, V, E, adj, pairs, grid }

function load() {
  if (R !== null) return R;
  if (!fs.existsSync(FILE)) { console.warn("[rail] assets/rail.json missing: straight lines between stations (run scripts/build-rail.mjs)"); return (R = false); }
  const d = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const V = d.graph.v, E = d.graph.e;
  const adj = Array.from({ length: V.length }, () => []);
  E.forEach(([a, b, km], i) => { adj[a].push([b, km, i]); adj[b].push([a, km, i]); });
  const grid = new Map();
  V.forEach(([lat, lon], i) => { const k = `${Math.floor(lat / 0.05)}:${Math.floor(lon / 0.05)}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
  R = { lines: d.lines, V, E, adj, pairs: d.pairs, grid, attribution: d.attribution };
  console.log(`[rail] ${V.length} vertices, ${E.length} edges, ${Object.keys(d.pairs).length} routed stop pairs`);
  return R;
}

const unflat = (a) => { const out = []; for (let i = 0; i < a.length; i += 2) out.push([a[i], a[i + 1]]); return out; };

/** Map network as [lat1, lon1, lat2, lon2] segments (format of /api/red). */
export function networkSegments() {
  const r = load();
  if (!r) return gtfs.segments;
  const segs = [];
  for (const l of r.lines) for (let i = 2; i < l.length; i += 2) segs.push([l[i - 2], l[i - 1], l[i], l[i + 1]]);
  return segs;
}

/** Path along the track through a list of station codes (straight where no route is known). */
export function pathForStops(codes) {
  const r = load();
  const out = [];
  for (let i = 0; i < codes.length; i++) {
    const s = gtfs.stations.get(codes[i]);
    if (!s) continue;
    if (i > 0 && r) {
      const a = codes[i - 1], b = codes[i];
      const p = r.pairs[a < b ? `${a}-${b}` : `${b}-${a}`];
      if (p) {
        let pts = unflat(p);
        const sa = gtfs.stations.get(a);
        if (sa && haversineKm(pts[0][0], pts[0][1], sa.lat, sa.lon) > haversineKm(pts.at(-1)[0], pts.at(-1)[1], sa.lat, sa.lon)) pts = pts.reverse();
        out.push(...pts.slice(1, -1));
      }
    }
    out.push([s.lat, s.lon]);
  }
  return out;
}

/** Vertices within maxKm of a point, nearest first (at most `limit`). */
function nearVertices(lat, lon, maxKm, limit = 25) {
  const r = load();
  const out = [];
  const ci = Math.floor(lat / 0.05), cj = Math.floor(lon / 0.05), K = Math.ceil(maxKm / 111 / 0.05) + 1;
  for (let i = ci - K; i <= ci + K; i++) for (let j = cj - K; j <= cj + K; j++)
    for (const v of r.grid.get(`${i}:${j}`) || []) { const d = haversineKm(lat, lon, r.V[v][0], r.V[v][1]); if (d <= maxKm) out.push([d, v]); }
  out.sort((a, b) => a[0] - b[0]);
  // spread candidates over different tracks: skip vertices within 300 m of an already chosen one
  const chosen = [];
  for (const [d, v] of out) {
    if (chosen.some(([, w]) => haversineKm(r.V[v][0], r.V[v][1], r.V[w][0], r.V[w][1]) < 0.8)) continue;
    chosen.push([d, v]);
    if (chosen.length >= limit) break;
  }
  return chosen;
}

/**
 * Route along the track between two points (e.g. two places named in an Adif notice). Places are often town
 * centres several km from the line, and the nearest track may be another line, so several candidate tracks
 * near each place are tried. Score = distance from each place to its snap point + any detour beyond 1.5× the
 * straight distance between the snap points (short sections are not penalised). Straight line if none fits.
 */
export function routePoints(a, b) {
  const r = load();
  if (!r) return [a, b];
  const direct = haversineKm(a[0], a[1], b[0], b[1]);
  const A = nearVertices(a[0], a[1], 15, 14), B = nearVertices(b[0], b[1], 15, 14);
  if (!A.length || !B.length) return [a, b];
  const limit = Math.max(direct * 3, direct + 30);
  let best = null;
  for (const [da, va] of A) {
    const dist = dijkstra(va, limit);
    for (const [db, vb] of B) {
      if (vb === va || !dist.g.has(vb)) continue;
      const track = dist.g.get(vb);
      const crow = haversineKm(r.V[va][0], r.V[va][1], r.V[vb][0], r.V[vb][1]);
      const score = da + db + Math.max(0, track - 1.5 * crow - 2);
      if (!best || score < best.score) best = { score, vb, prev: dist.prev };
    }
  }
  if (!best || best.score > direct + 25) return [a, b];
  const pts = [];
  for (let v = best.vb; best.prev.has(v); ) {
    const [p, ei] = best.prev.get(v);
    const e = r.E[ei];
    let geom = [r.V[e[0]], ...(e[3] ? unflat(e[3]) : []), r.V[e[1]]]; // inner points stored only for bends
    if (e[0] !== p) geom = geom.reverse();
    pts.unshift(...(pts.length ? geom.slice(0, -1) : geom));
    v = p;
  }
  return pts.length >= 2 ? pts : [a, b];
}

/** Track distances from one vertex, up to maxKm (binary-heap Dijkstra). */
function dijkstra(src, maxKm) {
  const r = load();
  const g = new Map([[src, 0]]), prev = new Map();
  const hk = [0], hv = [src];
  const push = (k, v) => { let i = hk.length; hk.push(k); hv.push(v); while (i) { const p = (i - 1) >> 1; if (hk[p] <= k) break; hk[i] = hk[p]; hv[i] = hv[p]; i = p; } hk[i] = k; hv[i] = v; };
  const pop = () => { const top = hv[0], tk = hk[0], lk = hk.pop(), lv = hv.pop(); if (hk.length) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= hk.length) break; if (c + 1 < hk.length && hk[c + 1] < hk[c]) c++; if (hk[c] >= lk) break; hk[i] = hk[c]; hv[i] = hv[c]; i = c; } hk[i] = lk; hv[i] = lv; } return [tk, top]; };
  while (hk.length) {
    const [d, v] = pop();
    if (d > g.get(v) || d > maxKm) continue;
    for (const [w, km, ei] of r.adj[v]) { const nd = d + km; if (nd < (g.get(w) ?? Infinity)) { g.set(w, nd); prev.set(w, [v, ei]); push(nd, w); } }
  }
  return { g, prev };
}

export const railAttribution = () => (load() ? R.attribution : null);
