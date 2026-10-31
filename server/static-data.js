// Data that changes at most daily: map cities, base config, rail network, land polygons, Cercanías lines.
// Served by the local server (/api/base, /api/red, /api/tierra, /api/red-cercanias) and published to R2 by
// the daily job (scripts/sync-supabase.mjs) for the Cloudflare deployment.
import { createRequire } from "node:module";
import * as topojson from "topojson-client";
import { EVERY, WINDOWS } from "./config.js";
import { TYPES } from "./products.js";
import { REGIONS, ZONES } from "./geo.js";
import { gtfs } from "./sources/gtfs-static.js";
import { cityName } from "./lines.js";
import { networkSegments } from "./rail.js";

const require = createRequire(import.meta.url);

let citiesCache = null;
/** Main cities for map labels: busiest stations by scheduled stops, one per city, in order of importance. */
export function mainCities() {
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

export const baseConfig = (pollSeconds = EVERY.live / 1000) =>
  ({ types: TYPES, zones: ZONES, regions: REGIONS, windows: Object.keys(WINDOWS), principales: mainCities(), pollSeconds });

let landCache = null;
/** Spain's regions + neighbouring countries, self-hosted (fallback basemap). */
export function land() {
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

let redCache = null;
/** Rail network as [lat1, lon1, lat2, lon2] segments. */
export function railSegments() {
  if (!redCache || redCache.v !== gtfs.loadedAt) redCache = { v: gtfs.loadedAt, d: networkSegments().map((s) => s.map((x) => Math.round(x * 1e4) / 1e4)) };
  return redCache.d;
}

let redCerCache = null;
/** Cercanías lines from Renfe's lineas.geojson, as [lat, lon] polylines with colour. */
export function cercaniasLines(geo) {
  if (!geo) return null;
  if (redCerCache?.v !== geo) {
    const r = (c) => (typeof c[0] === "number" ? [Math.round(c[1] * 1e4) / 1e4, Math.round(c[0] * 1e4) / 1e4] : c.map(r)); // → [lat, lon]
    redCerCache = { v: geo, d: geo.features.map((f) => ({ l: f.properties.CODIGO, n: f.properties.NUCLEO, c: f.properties.COLOR, g: r(f.geometry.coordinates), multi: f.geometry.type === "MultiLineString" })) };
  }
  return redCerCache.d;
}
