import { createRequire } from "node:module";
import * as topojson from "topojson-client";

const require = createRequire(import.meta.url);

const R = 6371; // km
const rad = (d) => (d * Math.PI) / 180;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function bearingDeg(lat1, lon1, lat2, lon2) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export const headingDiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

// ---------- Regions (autonomous communities) and provinces ----------
const REGION_SHORT = {
  "01": "Andalucía", "02": "Aragón", "03": "Asturias", "04": "Baleares", "05": "Canarias", "06": "Cantabria",
  "07": "Castilla y León", "08": "Castilla-La Mancha", "09": "Cataluña", "10": "C. Valenciana", "11": "Extremadura",
  "12": "Galicia", "13": "Madrid", "14": "Murcia", "15": "Navarra", "16": "País Vasco", "17": "La Rioja",
};
export const REGIONS = Object.entries(REGION_SHORT).filter(([id]) => !["04", "05"].includes(id)).map(([id, name]) => ({ id, name }));

function loadFeatures(file, obj) {
  const topo = require(`es-atlas/es/${file}.json`);
  return topojson.feature(topo, topo.objects[obj]).features.map((f) => ({
    id: f.id, name: f.properties.name,
    polys: f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates,
    bbox: bboxOf(f.geometry),
  }));
}
function bboxOf(g) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (c) => (typeof c[0] === "number" ? (b = [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[0]), Math.max(b[3], c[1])]) : c.forEach(walk));
  walk(g.coordinates);
  return b;
}
function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function locate(features, lon, lat) {
  for (const f of features) {
    const [x0, y0, x1, y1] = f.bbox;
    if (lon < x0 || lon > x1 || lat < y0 || lat > y1) continue;
    for (const poly of f.polys) if (inRing(lon, lat, poly[0]) && !poly.slice(1).some((h) => inRing(lon, lat, h))) return f;
  }
  return null;
}

let REG = null, PROV = null, MUNI = null;
const normName = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
/** Approximate centre (bbox centre) of a municipality by name, e.g. "Villarrubia de Santiago". */
let MUNI_LIST = null;
function muniList() {
  if (!MUNI_LIST) MUNI_LIST = loadFeatures("municipalities", "municipalities").map((f) => ({ n: f.name, key: normName(f.name), lat: (f.bbox[1] + f.bbox[3]) / 2, lon: (f.bbox[0] + f.bbox[2]) / 2 }));
  return MUNI_LIST;
}
export function municipality(name) {
  if (!MUNI) MUNI = new Map(muniList().map((m) => [m.key, [m.lat, m.lon]]));
  return MUNI.get(normName(name)) || null;
}

/** Every municipality with its province (for the places table of the Supabase deployment). */
export const allMunicipalities = () => muniList().map((m) => ({ n: m.n, key: m.key, lat: m.lat, lon: m.lon, prov: placeOf(m.lat, m.lon).province }));

/** Municipalities whose name contains the query (accent-insensitive); prefix matches first. */
export function searchMunicipalities(q, limit = 6) {
  const k = normName(q);
  if (k.length < 3) return [];
  const hits = muniList().filter((m) => m.key.includes(k));
  hits.sort((a, b) => (b.key.startsWith(k) - a.key.startsWith(k)) || a.key.length - b.key.length);
  return hits.slice(0, limit).map((m) => ({ n: m.n, lat: Math.round(m.lat * 1e5) / 1e5, lon: Math.round(m.lon * 1e5) / 1e5, prov: placeOf(m.lat, m.lon).province }));
}
function ensure() { if (!REG) { REG = loadFeatures("autonomous_regions", "autonomous_regions"); PROV = loadFeatures("provinces", "provinces"); } }

/** @returns {{region: string|null, regionName: string|null, province: string|null}} */
export function placeOf(lat, lon) {
  ensure();
  const r = locate(REG, lon, lat);
  const p = locate(PROV, lon, lat);
  if (!r) {
    // Near-coast/border points may fall just outside simplified polygons: nearest region by bbox centre within ~15 km.
    let best = null, bd = 0.15;
    for (const f of REG) {
      const cx = Math.max(f.bbox[0], Math.min(lon, f.bbox[2])), cy = Math.max(f.bbox[1], Math.min(lat, f.bbox[3]));
      const d = Math.hypot(cx - lon, cy - lat);
      if (d < bd) { bd = d; best = f; }
    }
    if (!best) return { region: null, regionName: lon > 2.5 || lat > 43.4 ? "Francia" : null, province: null };
    return { region: best.id, regionName: REGION_SHORT[best.id] || best.name, province: p?.name ?? null };
  }
  return { region: r.id, regionName: REGION_SHORT[r.id] || r.name, province: p?.name ?? null };
}

// Vía libre's arrival zones, expressed as region ids (+ a few northern Castilla y León provinces).
export const ZONES = [
  { id: "todo", name: "Toda España" },
  { id: "mad", name: "Madrid", regions: ["13"] },
  { id: "cat", name: "Cataluña", regions: ["09"] },
  { id: "val", name: "C. Valenciana", regions: ["10"] },
  { id: "and", name: "Andalucía", regions: ["01"] },
  { id: "gal", name: "Galicia", regions: ["12"] },
  { id: "nor", name: "Norte", regions: ["03", "06", "16", "15", "17"], provinces: ["León", "Burgos", "Palencia"] },
];
