// Basemap shared by every map: OpenFreeMap vector tiles (place names down to villages) rendered by MapLibre GL
// inside Leaflet through @maplibre/maplibre-gl-leaflet. Our own layers (rail network, trains, incidents) stay on top.
// If the vector style can't load (offline, no WebGL, blocked), it falls back to the self-hosted land polygons.
import { baseLand, onTema } from "./util.js";

const ESTILO = { dark: "https://tiles.openfreemap.org/styles/dark", light: "https://tiles.openfreemap.org/styles/positron" };
const ATRIB_OFM = '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
const ATRIB_NUESTRA = 'Vías © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors · Datos: Renfe, Adif';
// Basemap layers we hide: its own railways (ours are drawn on top), road shields, airports, one-way arrows.
const OCULTAR = /^(railway|highway-shield|road_shield|airport|road_oneway|aeroway)/;

const temaActual = () => document.documentElement.dataset.theme
  || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

let plugin = null;
// The plugin's ESM build imports "leaflet" and "maplibre-gl" (resolved by the import map in index.html).
const cargarPlugin = () => (plugin ??= import("/vendor/maplibre-gl-leaflet/dist/leaflet-maplibre-gl.mjs").catch((e) => { plugin = null; throw e; }));

/**
 * Adds the basemap under everything else. Resolves to "vector" or "tierra" (fallback).
 * onModo(modo) is called once the outcome is known, so callers can e.g. hide their own city labels.
 */
export async function fondo(map, { onModo } = {}) {
  map.attributionControl?.addAttribution(ATRIB_NUESTRA);
  const avisar = (m) => { map._fondo = m; onModo?.(m); return m; };
  try {
    if (!window.WebGLRenderingContext) throw new Error("sin WebGL");
    const { maplibreGL } = await cargarPlugin();
    if (!map._loaded && !map._container) throw new Error("mapa eliminado");
    let tema = temaActual();
    const capa = maplibreGL({ style: ESTILO[tema], interactive: false, attributionControl: { customAttribution: ATRIB_OFM }, padding: 0.15 });
    capa.addTo(map);
    const gl = capa.getMaplibreMap();
    const sobrio = () => {
      for (const l of gl.getStyle()?.layers || []) if (OCULTAR.test(l.id)) gl.setLayoutProperty(l.id, "visibility", "none");
    };
    gl.on("styledata", () => { if (gl.isStyleLoaded()) sobrio(); });
    await new Promise((ok, mal) => {
      const t = setTimeout(() => mal(new Error("el estilo tarda demasiado")), 12_000);
      gl.once("load", () => { clearTimeout(t); ok(); });
      gl.on("error", (e) => { if (!gl.loaded() && !gl.isStyleLoaded()) { clearTimeout(t); mal(e.error || new Error("error del estilo")); } });
    }).catch((e) => { map.removeLayer(capa); throw e; });
    sobrio();
    map.getContainer().classList.add("con-fondo-vector");
    const off = onTema(() => { const t = temaActual(); if (t !== tema) { tema = t; gl.setStyle(ESTILO[t]); } });
    map.on("unload", off);
    return avisar("vector");
  } catch (e) {
    console.info("Mapa base vectorial no disponible, se usa el mapa propio:", e?.message || e);
    if (!map.getContainer()?.isConnected && !map._container) return avisar("tierra");
    map.attributionControl?.addAttribution("Mapa: es-atlas, Natural Earth");
    await baseLand(map).catch(() => {});
    return avisar("tierra");
  }
}
