// Builds the rail network used by the map and for routing, from data/osm-rail.json (scripts/fetch-osm-rail.mjs).
//   assets/rail.json: { attribution, lines: [[lat, lon, lat, lon, …]] (simplified, for drawing),
//                       graph: { v: [[lat, lon]], e: [[from, to, km, [lat, lon, …]]] } (for routing),
//                       pairs: { "17000-04040": [lat, lon, …] } (real path between consecutive GTFS stops) }
// Data © OpenStreetMap contributors, ODbL 1.0.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadGtfs, gtfs } from "../server/sources/gtfs-static.js";
import { haversineKm } from "../server/geo.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IN = path.join(ROOT, "data", process.env.OSM_FILE || "osm-rail.json");
const OUT = path.join(ROOT, "assets", "rail.json");
const SNAP_KM = 2;          // station → nearest track point
const SIMPLIFY_M = 35;      // Douglas–Peucker tolerance for drawn lines and edge geometry
const MAX_DETOUR = 2.2;     // reject routed paths much longer than the straight line (wrong branch / gap)
const MERGE_M = 12;         // merge track nodes this close (the two tracks of a double-track line are ~4–5 m apart)
const GAP_M = 250;          // join dead-end track to other track this close (OSM breaks at stations)

const r5 = (x) => Math.round(x * 1e5) / 1e5;

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop();
    if (k.length) {
      let i = 0;
      for (;;) { let c = 2 * i + 1; if (c >= k.length) break; if (c + 1 < k.length && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

// ---------- load ----------
const { elements } = JSON.parse(fs.readFileSync(IN, "utf8"));
const ways = elements.filter((w) => w.type === "way" && w.nodes?.length >= 2 && w.geometry?.length === w.nodes.length);
const coord = new Map(); // node id → [lat, lon]
for (const w of ways) w.nodes.forEach((n, i) => coord.set(n, [w.geometry[i].lat, w.geometry[i].lon]));
console.log(`${ways.length} ways, ${coord.size} nodes`);

// Merge nodes closer than MERGE_M: OSM draws each track of a double-track line as its own way, joined only
// at crossovers, so routing between two points on "the same line" could detour 100 km. Merging joins them.
{
  const parent = new Map();
  const find = (x) => { let r = x; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r); parent.set(x, r); return r; };
  const C = 0.0002; // ~20 m cells
  const cells = new Map();
  for (const [n, [lat, lon]] of coord) { const k = `${Math.floor(lat / C)}:${Math.floor(lon / C)}`; if (!cells.has(k)) cells.set(k, []); cells.get(k).push(n); }
  let merged = 0;
  for (const [n, [lat, lon]] of coord) {
    const ci = Math.floor(lat / C), cj = Math.floor(lon / C);
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++)
      for (const m of cells.get(`${i}:${j}`) || []) {
        if (m <= n) continue;
        const [a, b] = coord.get(m);
        if (haversineKm(lat, lon, a, b) * 1000 > MERGE_M) continue;
        const rn = find(n), rm = find(m);
        if (rn !== rm) { parent.set(rm, rn); merged++; }
      }
  }
  for (const w of ways) {
    const nodes = [], geometry = [];
    w.nodes.forEach((n, i) => { const r = find(n); if (nodes.at(-1) !== r) { nodes.push(r); geometry.push(w.geometry[i]); } });
    w.nodes = nodes; w.geometry = geometry;
  }
  console.log(`merged ${merged} nodes within ${MERGE_M} m (parallel tracks)`);
}
const usable = ways.filter((w) => w.nodes.length >= 2);
ways.length = 0; ways.push(...usable);
const uses = new Map(); // node id → number of ways using it (endpoints count twice)
for (const w of ways) w.nodes.forEach((n, i) => uses.set(n, (uses.get(n) || 0) + (i === 0 || i === w.nodes.length - 1 ? 2 : 1)));
for (const n of [...coord.keys()]) if (!uses.has(n)) coord.delete(n);

// ---------- snap stations to the nearest track node (grid index) ----------
await loadGtfs();
const CELL = 0.02;
const grid = new Map();
const key = (lat, lon) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
for (const [n, [lat, lon]] of coord) { const k = key(lat, lon); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(n); }
function nearestNode(lat, lon, maxKm) {
  let best = null, bd = maxKm;
  const ci = Math.floor(lat / CELL), cj = Math.floor(lon / CELL), R = Math.ceil(maxKm / 111 / CELL) + 1;
  for (let i = ci - R; i <= ci + R; i++) for (let j = cj - R; j <= cj + R; j++) {
    for (const n of grid.get(`${i}:${j}`) || []) { const [a, b] = coord.get(n); const d = haversineKm(lat, lon, a, b); if (d < bd) { bd = d; best = n; } }
  }
  return best;
}
const stationNode = new Map(); // station code → node id
for (const s of gtfs.stations.values()) {
  const n = nearestNode(s.lat, s.lon, SNAP_KM);
  if (n != null) { stationNode.set(s.code, n); uses.set(n, Math.max(uses.get(n), 2)); } // force a vertex there
}
console.log(`${stationNode.size}/${gtfs.stations.size} stations snapped to track`);

// ---------- split ways at vertices (junctions, endpoints, station nodes) into edges ----------
const isVertex = (n) => uses.get(n) >= 2;
const vIndex = new Map(), V = [];
const vid = (n) => { if (!vIndex.has(n)) { vIndex.set(n, V.length); V.push(coord.get(n).map(r5)); } return vIndex.get(n); };
const E = []; // [from, to, km, pts]
for (const w of ways) {
  let start = 0;
  for (let i = 1; i < w.nodes.length; i++) {
    if (!isVertex(w.nodes[i]) && i < w.nodes.length - 1) continue;
    const seg = w.nodes.slice(start, i + 1).map((n) => coord.get(n));
    let km = 0;
    for (let k = 1; k < seg.length; k++) km += haversineKm(seg[k - 1][0], seg[k - 1][1], seg[k][0], seg[k][1]);
    E.push([vid(w.nodes[start]), vid(w.nodes[i]), Math.round(km * 1000) / 1000, simplify(seg, SIMPLIFY_M)]);
    start = i;
  }
}
console.log(`graph: ${V.length} vertices, ${E.length} edges`);

// ---------- bridge small gaps: dead ends within GAP_M of other track (station throats, tagging breaks) ----------
{
  const deg = new Array(V.length).fill(0);
  for (const [a, b] of E) { deg[a]++; deg[b]++; }
  const vg = new Map(), C = 0.005;
  V.forEach(([lat, lon], i) => { const k = `${Math.floor(lat / C)}:${Math.floor(lon / C)}`; if (!vg.has(k)) vg.set(k, []); vg.get(k).push(i); });
  const linked = new Set(E.map(([a, b]) => a < b ? `${a}-${b}` : `${b}-${a}`));
  let bridges = 0;
  for (let v = 0; v < V.length; v++) {
    if (deg[v] !== 1) continue;
    const [lat, lon] = V[v], ci = Math.floor(lat / C), cj = Math.floor(lon / C);
    let best = null, bd = GAP_M / 1000;
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++)
      for (const w of vg.get(`${i}:${j}`) || []) {
        if (w === v || linked.has(v < w ? `${v}-${w}` : `${w}-${v}`)) continue;
        const d = haversineKm(lat, lon, V[w][0], V[w][1]);
        if (d < bd) { bd = d; best = w; }
      }
    if (best == null) continue;
    E.push([v, best, Math.round(bd * 1000) / 1000 + 0.2, [V[v], V[best]]]); // small penalty: prefer real track
    linked.add(v < best ? `${v}-${best}` : `${best}-${v}`);
    bridges++;
  }
  console.log(`bridged ${bridges} gaps under ${GAP_M} m`);
}

// ---------- routing (A*) ----------
const adj = Array.from({ length: V.length }, () => []);
E.forEach(([a, b, km], i) => { adj[a].push([b, km, i]); adj[b].push([a, km, i]); });
function route(a, b) {
  const [tl, tn] = V[b];
  const h = (v) => haversineKm(V[v][0], V[v][1], tl, tn);
  const g = new Map([[a, 0]]), prev = new Map(), open = new MinHeap();
  open.push(h(a), a);
  while (open.size) {
    const v = open.pop();
    if (v === b) break;
    const gv = g.get(v);
    for (const [w, km, ei] of adj[v]) {
      const ng = gv + km;
      if (ng < (g.get(w) ?? Infinity)) { g.set(w, ng); prev.set(w, [v, ei]); open.push(ng + h(w), w); }
    }
  }
  if (!g.has(b)) return null;
  const pts = [];
  for (let v = b; v !== a; ) {
    const [p, ei] = prev.get(v);
    const e = E[ei], geom = e[0] === p ? e[3] : [...e[3]].reverse();
    pts.unshift(...(pts.length ? geom.slice(0, -1) : geom));
    v = p;
  }
  return { km: g.get(b), pts };
}

// ---------- real path between consecutive GTFS stops ----------
const pairs = {};
let ok = 0, straight = 0;
const seen = new Set();
for (const t of gtfs.trips.values()) for (let i = 1; i < t.stops.length; i++) {
  const A = t.stops[i - 1].code, B = t.stops[i].code;
  const k = A < B ? `${A}-${B}` : `${B}-${A}`;
  if (seen.has(k)) continue;
  seen.add(k);
  const [x, y] = k.split("-");
  const sx = gtfs.stations.get(x), sy = gtfs.stations.get(y);
  const nx = stationNode.get(x), ny = stationNode.get(y);
  if (!sx || !sy || nx == null || ny == null) { straight++; continue; }
  const direct = haversineKm(sx.lat, sx.lon, sy.lat, sy.lon);
  const r = route(vIndex.get(nx), vIndex.get(ny));
  if (!r || r.km > Math.max(direct * MAX_DETOUR, direct + 5)) { straight++; continue; }
  pairs[k] = simplify(r.pts, SIMPLIFY_M).flat().map(r5);
  ok++;
}
console.log(`stop pairs: ${ok} routed on real track, ${straight} left straight (no track nearby or implausible detour)`);

// ---------- drawn network: the OSM ways themselves, simplified (not graph edges: no double counting) ----------
const lines = ways.map((w) => simplify(w.nodes.map((n) => coord.get(n)), SIMPLIFY_M * 1.5).flat().map(r5)).filter((l) => l.length >= 4);

const out = {
  attribution: "© OpenStreetMap contributors (ODbL 1.0)",
  built: new Date().toISOString(),
  lines,
  // edge geometry only when it bends; straight edges are rebuilt from their two vertices
  graph: { v: V, e: E.map(([a, b, km, pts]) => (pts.length > 2 ? [a, b, km, pts.slice(1, -1).flat().map(r5)] : [a, b, km])) },
  pairs,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out));
console.log(`→ ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB)`);

// ---------- helpers ----------
function simplify(pts, tolM) {
  if (pts.length <= 2) return pts.map(([a, b]) => [r5(a), r5(b)]);
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const k = Math.cos((pts[0][0] * Math.PI) / 180) * 111_320, m = 110_540; // metres per degree lon/lat
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    const [ax, ay] = [pts[s][1] * k, pts[s][0] * m], [bx, by] = [pts[e][1] * k, pts[e][0] * m];
    let best = -1, bd = tolM;
    for (let i = s + 1; i < e; i++) {
      const px = pts[i][1] * k, py = pts[i][0] * m;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2)) : 0;
      const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
      if (d > bd) { bd = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([s, best], [best, e]); }
  }
  return pts.filter((_, i) => keep[i]).map(([a, b]) => [r5(a), r5(b)]);
}
