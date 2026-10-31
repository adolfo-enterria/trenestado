// Copies the browser libraries from node_modules into public/vendor/ for static hosting (Cloudflare Pages).
// Locally, server/index.js serves the same paths straight from node_modules.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COPY = {
  leaflet: "node_modules/leaflet/dist",
  "chart.js": "node_modules/chart.js/dist",
  "maplibre-gl": "node_modules/maplibre-gl/dist",
  "maplibre-gl-leaflet": "node_modules/@maplibre/maplibre-gl-leaflet",
};
for (const [name, from] of Object.entries(COPY)) {
  const dst = path.join(ROOT, "public", "vendor", name);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(path.join(ROOT, from), dst, { recursive: true, filter: (p) => !/(\.map|\.d\.ts|\.d\.mts|README\.md|CHANGELOG\.md|[\/]examples?|[\/]debug|[\/]src)$/.test(p) });
  console.log(`public/vendor/${name}`);
}
