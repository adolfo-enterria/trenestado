// One-time download of Spain's main/branch rail lines from OpenStreetMap (Overpass API).
// Output: data/osm-rail.json (git-ignored; input for scripts/build-rail.mjs).
// Splits Spain into tiles and retries with backoff across public Overpass servers (fair use).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "data", "osm-rail.json");
const SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const UA = "trenestado/0.1 (one-time build of the rail network; github.com/adolfo-enterria/trenestado)";

// mainland Spain + a margin for border connections (south, west, north, east)
const TILES = [[35.9, -9.5, 40.2, -3.6], [35.9, -3.6, 40.2, 3.4], [40.2, -9.5, 43.9, -3.6], [40.2, -3.6, 43.9, 3.4]];
const query = ([s, w, n, e]) => `[out:json][timeout:240];
// Main and branch lines only (no service tracks). Gaps this leaves at stations and between the two tracks
// of double-track lines are closed in scripts/build-rail.mjs (node merging + gap bridging).
(
  way["railway"~"^(rail|narrow_gauge)$"]["usage"~"^(main|branch)$"][!"service"](${s},${w},${n},${e});
  way["railway"="rail"]["highspeed"="yes"][!"service"](${s},${w},${n},${e});
);
out body geom qt;`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchTile(tile) {
  let wait = 20_000;
  for (let attempt = 0; attempt < 8; attempt++) {
    const url = SERVERS[attempt % SERVERS.length];
    try {
      const r = await fetch(url, { method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(query(tile)), signal: AbortSignal.timeout(300_000) });
      const text = await r.text();
      if (r.ok && text.startsWith("{")) return JSON.parse(text).elements;
      console.warn(`  ${url} → ${r.status}; retrying in ${wait / 1000}s`);
    } catch (e) { console.warn(`  ${url} → ${e.message}; retrying in ${wait / 1000}s`); }
    await sleep(wait);
    wait = Math.min(wait * 2, 240_000);
  }
  throw new Error("Overpass unavailable for tile " + tile.join(","));
}

const ways = new Map();
for (const [i, tile] of TILES.entries()) {
  console.log(`tile ${i + 1}/${TILES.length} ${tile.join(",")}`);
  for (const el of await fetchTile(tile)) if (el.type === "way") ways.set(el.id, el); // tiles overlap at edges
  await sleep(5_000);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ fetched: new Date().toISOString(), elements: [...ways.values()] }));
console.log(`${ways.size} ways → ${OUT}`);
