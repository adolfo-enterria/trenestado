// App shell: hash router, polling of /api/estado (every pollSeconds), header status.
import { $, api, horaLocal } from "./util.js";
import { initMap, update as updateMap, invalidate, seleccionar, mostrarEstacion } from "./map.js";
import { showTrain, hideTrain } from "./train.js";
import { showStation, hideStation } from "./station.js";
import { showStats } from "./stats.js";
import { showMisTrenes, showFuentes } from "./pages.js";
import { initSearch } from "./search.js";
import { check as checkAlarms, getTracked, onChange } from "./alarms.js";

let D = null, BASE = null, pendingSelect = null;
const VIEWS = ["mapa", "tren", "estacion", "stats", "mis-trenes", "fuentes"];

function route() {
  const [path, query] = location.hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query || "");
  const parts = path.split("/").filter(Boolean);
  let view = "mapa";
  if (parts[0] === "tren" && parts[1]) view = "tren";
  else if (parts[0] === "estacion" && parts[1]) view = "estacion";
  else if (parts[0] === "stats") view = "stats";
  else if (parts[0] === "mis-trenes") view = "mis-trenes";
  else if (parts[0] === "fuentes") view = "fuentes";
  for (const v of VIEWS) $("v-" + v).hidden = v !== view;
  document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === view));
  if (view !== "tren") hideTrain();
  if (view !== "estacion") hideStation();
  if (view === "mapa") {
    invalidate();
    const n = params.get("tren");
    if (n) { if (D?.trenes.some((t) => t.id === n)) seleccionar(n, true); else pendingSelect = n; }
  } else if (view === "tren") showTrain(decodeURIComponent(parts[1]), { openAlarm: params.get("alarma") === "1" });
  else if (view === "estacion") showStation(decodeURIComponent(parts[1]), { tipo: params.get("tipo"), verEnMapa: verEstacionEnMapa });
  else if (view === "stats") BASE && showStats(BASE);
  else if (view === "mis-trenes") showMisTrenes(D, BASE);
  else if (view === "fuentes") showFuentes();
  document.title = { mapa: "Trenestado", tren: `Tren ${(parts[1] || "").replace(/^c/, "")} · Trenestado`, estacion: "Estación · Trenestado", stats: "Estadísticas · Trenestado", "mis-trenes": "Mis trenes · Trenestado", fuentes: "Fuentes · Trenestado" }[view];
}

function verEstacionEnMapa(st) { location.hash = "#/"; setTimeout(() => mostrarEstacion(st), 50); }

function cabecera() {
  const f = D.fuentes.renfe || {};
  const hora = D.flotaHora ? D.flotaHora.slice(11, 16) : "";
  const edad = f.at ? (Date.now() - Date.parse(f.at)) / 60000 : 99;
  const viejo = !f.ok || edad > 3;
  $("vivo").className = "vivo " + (viejo ? "viejo" : "ok");
  $("hora").textContent = viejo ? `Renfe no responde. Últimos datos de las ${hora || "–"}` : `En vivo, datos de Renfe de las ${hora}` + (D.sinPosicion ? `, ${D.sinPosicion} sin posición` : "");
}

function badge() {
  const n = getTracked().length;
  $("nMis").hidden = !n;
  $("nMis").textContent = n;
}

async function actualizar() {
  try {
    D = await api("/api/estado");
    $("aviso").hidden = true;
    cabecera();
    updateMap(D);
    if (pendingSelect && D.trenes.some((t) => t.id === pendingSelect)) { seleccionar(pendingSelect, true); pendingSelect = null; }
    checkAlarms(D).catch((e) => console.warn("alarms", e));
    if (!$("v-mis-trenes").hidden && !document.activeElement?.closest("#v-mis-trenes")) showMisTrenes(D, BASE);
  } catch (e) {
    $("aviso").hidden = false;
    $("aviso").textContent = "No hay conexión con el servidor. Reintentando cada minuto.";
    $("vivo").className = "vivo viejo";
    $("hora").textContent = D ? `Sin conexión desde las ${horaLocal(new Date())}` : "Sin conexión con el servidor";
  }
}

(async () => {
  onChange(badge);
  badge();
  initSearch();
  await initMap();
  try { BASE = await api("/api/base"); } catch {}
  addEventListener("hashchange", route);
  route();
  await actualizar();
  setInterval(actualizar, (BASE?.pollSeconds || 60) * 1000); // matches the collector; see docs/free-tier.md
  document.addEventListener("visibilitychange", () => { if (!document.hidden) actualizar(); });
})();
