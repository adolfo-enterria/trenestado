// App shell: hash router, polling of /api/estado (every pollSeconds), header status, theme toggle.
import { $, api, horaLocal, aplicarTema, temaElegido, TEMAS } from "./util.js";
import { initMap, update as updateMap, invalidate, seleccionar, mostrarEstacion, mostrarLugar } from "./map.js";
import { showTrain, hideTrain } from "./train.js";
import { showStation, hideStation } from "./station.js";
import { showStats } from "./stats.js";
import { showMisTrenes, showFuentes } from "./pages.js";
import { showDatos } from "./datos.js";
import { initMenu } from "./menu.js";
import { showIncidencias, updateIncidencias, hideIncidencias } from "./incidents.js";
import { initSearch } from "./search.js";
import { check as checkAlarms, getTracked, onChange } from "./alarms.js";

let D = null, BASE = null, pendingSelect = null;
const VIEWS = ["mapa", "incidencias", "tren", "estacion", "stats", "mis-trenes", "datos", "fuentes"];
const TITLES = { mapa: "Trenestado", incidencias: "Incidencias en la red · Trenestado", estacion: "Estación · Trenestado", stats: "Estadísticas · Trenestado", "mis-trenes": "Mis trenes · Trenestado", datos: "Descargar datos · Trenestado", fuentes: "Fuentes · Trenestado" };
let lastView = null;

function route() {
  const [path, query] = location.hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query || "");
  const parts = path.split("/").filter(Boolean);
  let view = "mapa";
  if (parts[0] === "tren" && parts[1]) view = "tren";
  else if (parts[0] === "estacion" && parts[1]) view = "estacion";
  else if (["stats", "mis-trenes", "datos", "fuentes", "incidencias"].includes(parts[0])) view = parts[0];
  for (const v of VIEWS) $("v-" + v).hidden = v !== view;
  document.querySelectorAll(".tabs a").forEach((a) => {
    const on = a.dataset.tab === view;
    a.classList.toggle("on", on);
    if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  if (view !== "tren") hideTrain();
  if (view !== "estacion") hideStation();
  if (view !== "incidencias") hideIncidencias();
  if (view === "mapa") {
    invalidate();
    const n = params.get("tren");
    if (n) { if (D?.trenes.some((t) => t.id === n)) seleccionar(n, true); else pendingSelect = n; }
  } else if (view === "tren") showTrain(decodeURIComponent(parts[1]), { openAlarm: params.get("alarma") === "1" });
  else if (view === "estacion") showStation(decodeURIComponent(parts[1]), { tipo: params.get("tipo"), verEnMapa: verEstacionEnMapa });
  else if (view === "stats") BASE && showStats(BASE);
  else if (view === "mis-trenes") showMisTrenes(D, BASE);
  else if (view === "datos") showDatos(BASE);
  else if (view === "fuentes") showFuentes();
  else if (view === "incidencias") showIncidencias(D, { id: params.get("id") });
  document.title = view === "tren" ? `Tren ${(parts[1] || "").replace(/^c/, "")} · Trenestado` : TITLES[view];
  // move focus to the new view for keyboard / screen-reader users (not on first load)
  if (lastView && lastView !== view && view !== "mapa") $("contenido").focus({ preventScroll: true });
  if (view !== "mapa") $("v-" + view).scrollTop = 0;
  lastView = view;
}

function verEstacionEnMapa(st) { location.hash = "#/"; setTimeout(() => mostrarEstacion(st), 50); }
function verLugar(p) {
  if (!$("v-mapa").hidden && !location.hash.replace(/^#\/?/, "")) return mostrarLugar(p);
  location.hash = "#/";
  setTimeout(() => mostrarLugar(p), 60);
}

function cabecera() {
  const f = D.fuentes.renfe || {};
  const hora = D.flotaHora ? D.flotaHora.slice(11, 16) : "";
  const edad = f.at ? (Date.now() - Date.parse(f.at)) / 60000 : 99;
  const viejo = !f.ok || edad > 3;
  $("vivo").className = "vivo " + (viejo ? "viejo" : "ok");
  // .vl parts are hidden on narrow screens; the time always stays visible
  $("hora").innerHTML = viejo ? `<span class="vl">Renfe no responde. </span>Datos de las ${hora || "–"}`
    : `<span class="vl">En vivo, datos de </span>Renfe<span class="vl"> de las</span> ${hora}<span class="vl">${D.sinPosicion ? `, ${D.sinPosicion} sin posición` : ""}</span>`;
  $("vivo").title = $("hora").textContent;
  const inc = D.incidencias || [];
  $("nInc").hidden = !inc.length;
  $("nInc").textContent = inc.length;
  $("nInc").className = inc.some((i) => i.level === "grave") ? "grave" : "";
  $("nInc").setAttribute("aria-label", `${inc.length} activas`);
  menuAviso();
}

// dot on the ☰ button: there are incidents (red square if any is grave); the counts live in the drawer
function menuAviso() {
  const inc = D?.incidencias || [], graves = inc.filter((i) => i.level === "grave").length;
  $("menuPunto").hidden = !inc.length;
  $("menuPunto").className = "menu-punto" + (graves ? " grave" : "");
  $("menuBtn").setAttribute("aria-label", "Abrir el menú" + (inc.length ? ` (${inc.length} ${inc.length === 1 ? "incidencia" : "incidencias"}${graves ? `, ${graves} ${graves === 1 ? "grave" : "graves"}` : ""})` : ""));
}

function badge() {
  const n = getTracked().length;
  $("nMis").hidden = !n;
  $("nMis").textContent = n;
  $("nMis").setAttribute("aria-label", `${n} con alarma`);
}

// theme: segmented control in the drawer (Automático / Claro / Oscuro)
function botonTema() {
  const t = temaElegido();
  for (const b of $("tema").querySelectorAll("button")) { const on = b.dataset.t === t; b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); }
  $("tema").onclick = (e) => { const b = e.target.closest("button[data-t]"); if (!b || !TEMAS[b.dataset.t]) return; aplicarTema(b.dataset.t); botonTema(); };
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
    if (!$("v-incidencias").hidden) updateIncidencias(D);
  } catch (e) {
    $("aviso").hidden = false;
    $("aviso").textContent = `No hay conexión con el servidor. Se reintenta cada ${BASE?.pollSeconds || 60} segundos.`;
    $("vivo").className = "vivo viejo";
    $("hora").textContent = D ? `Sin conexión desde las ${horaLocal(new Date())}` : "Sin conexión con el servidor";
  }
}

(async () => {
  botonTema();
  onChange(badge);
  badge();
  initMenu();
  initSearch({ onLugar: verLugar });
  await initMap();
  try { BASE = await api("/api/base"); } catch {}
  addEventListener("hashchange", route);
  route();
  await actualizar();
  setInterval(actualizar, (BASE?.pollSeconds || 60) * 1000); // matches the collector; see docs/free-tier.md
  document.addEventListener("visibilitychange", () => { if (!document.hidden) actualizar(); });
})();
