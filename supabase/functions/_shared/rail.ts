// Track routing for incident sections (port of server/rail.js routePoints). The graph (~6 MB, OpenStreetMap)
// is published to R2 by the daily job and loaded only when a new Adif notice needs a path; results are stored
// in incidents.path, so this runs rarely.
import { haversineKm, r2GetJson, sql, norm, type Station } from "./core.ts";

type Graph = { v: [number, number][]; e: [number, number, number, number[]?][] };
let G: { V: [number, number][]; E: Graph["e"]; adj: [number, number, number][][]; grid: Map<string, number[]> } | null = null;

async function graph() {
  if (G) return G;
  const d = await r2GetJson<Graph>("static/rail-graph.json");
  if (!d) return null;
  const adj: [number, number, number][][] = Array.from({ length: d.v.length }, () => []);
  d.e.forEach(([a, b, km], i) => { adj[a].push([b, km, i]); adj[b].push([a, km, i]); });
  const grid = new Map<string, number[]>();
  d.v.forEach(([lat, lon], i) => { const k = `${Math.floor(lat / 0.05)}:${Math.floor(lon / 0.05)}`; if (!grid.has(k)) grid.set(k, []); grid.get(k)!.push(i); });
  G = { V: d.v, E: d.e, adj, grid };
  return G;
}

function nearVertices(g: NonNullable<typeof G>, lat: number, lon: number, maxKm: number, limit: number) {
  const out: [number, number][] = [];
  const ci = Math.floor(lat / 0.05), cj = Math.floor(lon / 0.05), K = Math.ceil(maxKm / 111 / 0.05) + 1;
  for (let i = ci - K; i <= ci + K; i++) for (let j = cj - K; j <= cj + K; j++)
    for (const v of g.grid.get(`${i}:${j}`) || []) { const d = haversineKm(lat, lon, g.V[v][0], g.V[v][1]); if (d <= maxKm) out.push([d, v]); }
  out.sort((a, b) => a[0] - b[0]);
  const chosen: [number, number][] = [];
  for (const [d, v] of out) {
    if (chosen.some(([, w]) => haversineKm(g.V[v][0], g.V[v][1], g.V[w][0], g.V[w][1]) < 0.8)) continue;
    chosen.push([d, v]);
    if (chosen.length >= limit) break;
  }
  return chosen;
}

function dijkstra(g: NonNullable<typeof G>, src: number, maxKm: number) {
  const dist = new Map<number, number>([[src, 0]]), prev = new Map<number, [number, number]>();
  const hk = [0], hv = [src];
  const push = (k: number, v: number) => { let i = hk.length; hk.push(k); hv.push(v); while (i) { const p = (i - 1) >> 1; if (hk[p] <= k) break; hk[i] = hk[p]; hv[i] = hv[p]; i = p; } hk[i] = k; hv[i] = v; };
  const pop = (): [number, number] => { const tk = hk[0], tv = hv[0], lk = hk.pop()!, lv = hv.pop()!; if (hk.length) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= hk.length) break; if (c + 1 < hk.length && hk[c + 1] < hk[c]) c++; if (hk[c] >= lk) break; hk[i] = hk[c]; hv[i] = hv[c]; i = c; } hk[i] = lk; hv[i] = lv; } return [tk, tv]; };
  while (hk.length) {
    const [d, v] = pop();
    if (d > dist.get(v)! || d > maxKm) continue;
    for (const [w, km, ei] of g.adj[v]) { const nd = d + km; if (nd < (dist.get(w) ?? Infinity)) { dist.set(w, nd); prev.set(w, [v, ei]); push(nd, w); } }
  }
  return { dist, prev };
}

/** Route along the track between two points; straight line if no plausible route. */
export async function routePoints(a: [number, number], b: [number, number]): Promise<[number, number][]> {
  const g = await graph().catch(() => null);
  if (!g) return [a, b];
  const direct = haversineKm(a[0], a[1], b[0], b[1]);
  const A = nearVertices(g, a[0], a[1], 15, 14), B = nearVertices(g, b[0], b[1], 15, 14);
  let best: { score: number; vb: number; prev: Map<number, [number, number]> } | null = null;
  for (const [da, va] of A) {
    const { dist, prev } = dijkstra(g, va, Math.max(direct * 3, direct + 30));
    for (const [db, vb] of B) {
      if (vb === va || !dist.has(vb)) continue;
      const crow = haversineKm(g.V[va][0], g.V[va][1], g.V[vb][0], g.V[vb][1]);
      const score = da + db + Math.max(0, dist.get(vb)! - 1.5 * crow - 2);
      if (!best || score < best.score) best = { score, vb, prev };
    }
  }
  if (!best || best.score > direct + 25) return [a, b];
  const pts: [number, number][] = [];
  for (let v = best.vb; best.prev.has(v); ) {
    const [p, ei] = best.prev.get(v)!;
    const e = g.E[ei];
    const inner: [number, number][] = [];
    for (let i = 0; e[3] && i < e[3].length; i += 2) inner.push([e[3][i], e[3][i + 1]]);
    let geom = [g.V[e[0]], ...inner, g.V[e[1]]];
    if (e[0] !== p) geom = geom.reverse();
    pts.unshift(...(pts.length ? geom.slice(0, -1) : geom));
    v = p;
  }
  return pts.length >= 2 ? pts : [a, b];
}

/** A place named in a notice: a station by name, else a municipality (places table); shorter prefixes too. */
async function findPlace(st: Map<string, Station>, name: string): Promise<[number, number] | null> {
  const words = name.trim().split(/\s+/);
  for (let k = words.length; k >= 1; k--) {
    const q = norm(words.slice(0, k).join(" "));
    if (q.length < 3) continue;
    for (const s of st.values()) if (norm(s.name) === q) return [s.lat, s.lon];
    const [p] = await sql<{ lat: number; lon: number }[]>`select lat, lon from public.places where name_norm = ${q} limit 1`;
    if (p) return [p.lat, p.lon];
  }
  return null;
}

/** Section of an Adif notice ("… entre Valdemoro y Villarrubia de Santiago …") routed on the track. */
export async function adifPath(st: Map<string, Station>, i: { title: string; text: string[] }) {
  for (const txt of [i.title, i.text.join(" ")]) {
    const m = txt.match(/entre (?:las estaciones de )?([A-ZÁÉÍÓÚÑ][\wáéíóúñü.' -]+?) y ([A-ZÁÉÍÓÚÑ][\wáéíóúñü.' -]+?)(?=[,.;:]| por | debido| a causa| en el | registran|$)/);
    if (!m) continue;
    const a = await findPlace(st, m[1]), b = await findPlace(st, m[2]);
    if (a && b && haversineKm(a[0], a[1], b[0], b[1]) < 150) return routePoints(a, b);
  }
  return null;
}
