// Home view: live map, board (summary, incidents indicator, delayed arrivals), train card, proximity anomalies.
import { $, esc, store, api, COL, nivel, durTxt, addMin, onTema, retBadge, rombo, NIVEL_INC } from "./util.js";
import { puntTexto, redFerroviaria, distKm } from "./util.js";
import { fondo } from "./basemap.js";
import { isTracked } from "./alarms.js";

let BASE = null, D = { trenes: [], est: {}, incidencias: [], fuentes: {}, proximidad: [] };
let map, renderer, layers = {}, desfase = 0, redLinea = null;
const nodos = new Map(); // n → { m: circleMarker, t, x, y, bx, by, b0, lbl }
let seleccion = null, siguiendo = false, expandida = false, vectorial = false;
const activos = new Set(store.get("tipos", ["ave", "avlo", "avant", "alvia", "ld", "md", "cer"]));
let zona = store.get("zona", "todo");

const quieto = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const esMovil = () => innerWidth <= 860;
// what the map shows: active train types AND the zone chosen on the board (by destination, same rule as the list)
const visibles = () => D.trenes.filter((t) => activos.has(t.tipo) && enZona(t));
const corto = (c) => D.est[c]?.c || "estación " + c;
const tramo = (t) => (t.ant === t.sig ? "En " + corto(t.ant) : "Entre " + corto(t.ant) + " y " + corto(t.sig));
const SPAIN = [[35.9, -9.6], [43.9, 3.4]];
// Fixed view per zone (the trains bound for a zone can be anywhere in Spain, so their bounds aren't a good view).
const ZONA_BBOX = {
  mad: [[39.95, -4.45], [41.1, -3.1]], cat: [[40.55, 0.2], [42.75, 3.3]], val: [[37.85, -1.5], [40.75, 0.6]],
  and: [[36.0, -7.5], [38.7, -1.65]], gal: [[41.85, -9.25], [43.75, -6.75]], nor: [[41.6, -7.1], [43.65, -1.0]],
};

export async function initMap() {
  map = L.map("mapa", { zoomControl: false, preferCanvas: true, minZoom: 5, maxZoom: 15, zoomSnap: 0.25, wheelPxPerZoomLevel: 90, attributionControl: true });
  map.attributionControl.setPrefix(false);
  map.fitBounds(SPAIN, { padding: [10, 10] });
  L.control.zoom({ position: "topright", zoomInTitle: "Acercar", zoomOutTitle: "Alejar" }).addTo(map);
  const Todo = L.Control.extend({ onAdd() { const b = L.DomUtil.create("div", "leaflet-bar"); b.innerHTML = '<a href="#" role="button" title="Ver toda España" aria-label="Ver toda España">⤢</a>'; b.firstChild.onclick = (e) => { e.preventDefault(); siguiendo = false; map.flyToBounds(SPAIN, { duration: 0.5 }); }; return b; } });
  new Todo({ position: "topright" }).addTo(map);
  renderer = L.canvas({ padding: 0.3 });
  fondo(map, { onModo: (m) => { vectorial = m === "vector"; ciudades(); } });
  for (const k of ["red", "redCer", "inc", "prox", "trenes"]) layers[k] = L.layerGroup().addTo(map);
  layers.ciudades = L.layerGroup().addTo(map);
  layers.etq = L.layerGroup().addTo(map);

  map.on("zoomend moveend", () => { etiquetar(); ciudades(); lineasCercanias(); });
  onTema(() => { redLinea?.setStyle({ color: COL.via }); pintarTrenes(); pintarIncidencias(); pintarProximidad(); ciudades(); layers.redCer.clearLayers(); lineasCercanias(); });
  if (!esMovil() && innerHeight > 760) $("leyenda").open = true;
  map.on("dragstart", () => (siguiendo = false));
  map.on("click", () => seleccionar(null));
  addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select") || $("v-mapa").hidden) return;
    if (e.key === "+" || e.key === "=") map.zoomIn();
    else if (e.key === "-" || e.key === "_") map.zoomOut();
    else if (e.key === "0") map.flyToBounds(SPAIN);
    else if (e.key === "Escape") seleccionar(null);
  });

  $("tipos").addEventListener("click", (e) => {
    if (e.target.closest("[data-quitar-zona]")) return elegirZona("todo");
    const b = e.target.closest("button[data-id]"); if (!b) return;
    activos.has(b.dataset.id) ? activos.delete(b.dataset.id) : activos.add(b.dataset.id);
    store.set("tipos", [...activos]);
    if (seleccion && !visibles().some((t) => t.id === seleccion)) seleccion = null;
    pintarTipos(); pintarTrenes(); pintarLista(); pintarFicha(); lineasCercanias();
  });
  $("zonas").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-z]"); if (!b) return;
    elegirZona(b.dataset.z);
  });
  $("mas").onclick = () => { expandida = true; pintarLista(); };
  const elegir = (li) => { if (!li) return; hoja(false); seleccionar(li.dataset.n, true); };
  $("lista").addEventListener("click", (e) => elegir(e.target.closest("li[data-n]")));
  $("lista").addEventListener("keydown", (e) => { if (e.key === "Enter") elegir(e.target.closest("li[data-n]")); });
  $("asa").onclick = () => hoja(!$("tablero").classList.contains("abierta"));

  try {
    BASE = await api("/api/base");
    pintarZonas();
    if (zona !== "todo") verZona(false);
    const red = await redFerroviaria();
    redLinea = L.polyline(red.map((s) => [[s[0], s[1]], [s[2], s[3]]]), { renderer, color: COL.via, weight: 1.5, opacity: 0.9, interactive: false }).addTo(layers.red);
    ciudades();
  } catch (e) { console.warn("base", e); }
  arrancarMovimiento();
}

export function invalidate() { map?.invalidateSize(); }

// Mobile bottom sheet (on desktop the board is a fixed column and this has no visible effect).
function hoja(abrir) {
  $("tablero").classList.toggle("abierta", abrir);
  $("asa").setAttribute("aria-expanded", abrir);
}

export function update(data) {
  D = data;
  if (D.generado) desfase = Date.parse(D.generado) - Date.now();
  pintarTipos(); pintarIncidencias(); pintarIndicador(); pintarProximidad(); pintarTrenes(); pintarLista(); pintarFicha();
}

// ---------- header chips ----------
function pintarTipos() {
  if (!BASE) return;
  const cuenta = (id) => D.trenes.filter((x) => x.tipo === id && enZona(x)).length;
  const z = BASE.zones.find((x) => x.id === zona);
  const chip = z?.regions ? `<button class="zona-chip" data-quitar-zona title="Quitar el filtro de zona" aria-label="Solo trenes con destino ${esc(z.name)}. Quitar el filtro de zona">Destino ${esc(z.name)}<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg></button>` : "";
  $("tipos").innerHTML = chip + BASE.types.map((t) => t.noData
    ? `<button disabled title="Ni Iryo ni Ouigo publican la posición de sus trenes">${t.name} <b>sin datos</b></button>`
    : `<button class="${activos.has(t.id) ? "on" : ""}" data-id="${t.id}" aria-pressed="${activos.has(t.id)}">${t.name} <b>${cuenta(t.id)}</b></button>`).join("");
}
function pintarZonas() {
  if (!BASE) return;
  $("zonas").innerHTML = BASE.zones.map((z) => `<button class="${z.id === zona ? "on" : ""}" data-z="${z.id}" aria-pressed="${z.id === zona}">${z.name}</button>`).join("");
}
const enZona = (t) => {
  const z = BASE?.zones.find((x) => x.id === zona);
  if (!z || !z.regions) return true;
  return z.regions.includes(t.dreg) || (z.provinces || []).includes(t.dprov);
};

// Zone filter: board list + map dots + summary numbers, and the map flies to the zone.
function elegirZona(id) {
  zona = BASE?.zones.some((z) => z.id === id) ? id : "todo";
  store.set("zona", zona);
  expandida = false;
  if (seleccion && !visibles().some((t) => t.id === seleccion)) seleccion = null;
  pintarZonas(); pintarTipos(); pintarTrenes(); pintarLista(); pintarFicha();
  verZona(true);
}
function verZona(animar) {
  if (!map) return;
  siguiendo = false;
  let b = zona === "todo" ? SPAIN : ZONA_BBOX[zona];
  if (!b) { // a zone without a fixed view: frame its visible trains
    const pts = visibles().map((t) => [t.lat, t.lon]);
    b = pts.length ? L.latLngBounds(pts) : SPAIN;
  }
  const opts = { padding: [20, 20], maxZoom: 10, duration: quieto() || !animar ? 0 : 0.7 };
  // on phones the bottom sheet covers the lower part of the map
  if (esMovil()) Object.assign(opts, { paddingTopLeft: [10, ($("tipos").offsetHeight || 40) + 20], paddingBottomRight: [10, 160], padding: undefined });
  if (animar && !quieto()) map.flyToBounds(b, opts); else map.fitBounds(b, opts);
}

// ---------- incidents (drawn on the map; the full list lives in #/incidencias) ----------
function pintarIncidencias() {
  layers.inc.clearLayers();
  for (const i of D.incidencias || []) {
    if (!i.path || i.path.length < 2) continue;
    const c = COL[i.level] || COL.info;
    L.polyline(i.path, { renderer, color: c, weight: 10, opacity: 0.22, lineCap: "round", interactive: false }).addTo(layers.inc);
    L.polyline(i.path, { renderer, color: c, weight: 3, dashArray: "6 5", interactive: false }).addTo(layers.inc);
    const p = i.path.length === 2 ? [(i.path[0][0] + i.path[1][0]) / 2, (i.path[0][1] + i.path[1][1]) / 2] : i.path[Math.floor(i.path.length / 2)];
    L.marker(p, { icon: rombo(i.level), keyboard: false, title: (NIVEL_INC[i.level] || "") + ": " + i.title })
      .bindPopup(`<small>${NIVEL_INC[i.level] || ""}, ${i.source === "adif" ? "aviso de Adif" : "detectada en datos de Renfe"}</small><br><b>${esc(i.title)}</b><br><a href="#/incidencias?id=${encodeURIComponent(i.id)}">Ver detalles de la incidencia</a>`, { maxWidth: 300 })
      .addTo(layers.inc);
  }
}

// Compact indicator on the board: "4 incidencias, 1 grave" linking to #/incidencias
function pintarIndicador() {
  const el = $("indInc"), lista = D.incidencias || [], ad = D.fuentes.adif || {}, prox = (D.proximidad || []).length;
  const graves = lista.filter((i) => i.level === "grave").length, leves = lista.filter((i) => i.level === "leve").length;
  let txt;
  if (!lista.length && !ad.ok && !ad.triedAt) txt = "Consultando incidencias…";
  else if (!lista.length) txt = ad.ok ? "Sin incidencias en la red" : "Sin incidencias detectadas (Adif no responde)";
  else txt = `${lista.length} ${lista.length === 1 ? "incidencia" : "incidencias"}${graves ? `, ${graves} ${graves === 1 ? "grave" : "graves"}` : ""}`;
  if (prox) txt += `, ${prox} ${prox === 1 ? "anomalía" : "anomalías"} de proximidad`;
  el.className = "indicador " + (graves ? "grave" : leves ? "leve" : lista.length ? "" : "ninguna");
  el.innerHTML = `<i class="rombo"></i><span>${txt}</span>`;
  el.setAttribute("aria-label", txt + ". Ver incidencias en la red");
}

function pintarProximidad() {
  layers.prox.clearLayers();
  for (const p of D.proximidad || []) {
    L.circle([p.lat, p.lon], { radius: Math.max(400, p.distM), color: COL.prox, weight: 2, dashArray: "2 5", fill: false, interactive: false }).addTo(layers.prox);
  }
}

// ---------- trains ----------
function pintarTrenes() {
  const vis = visibles(), vivos = new Set(vis.map((t) => t.id));
  for (const [n, o] of nodos) if (!vivos.has(n)) { o.m.remove(); nodos.delete(n); }
  const z = map.getZoom();
  for (const t of vis) {
    let o = nodos.get(t.id);
    const md = t.tipo === "md" || t.red === "cer";
    if (!o) {
      const m = L.circleMarker([t.lat, t.lon], { renderer, radius: 5, weight: 1.3, fillOpacity: 1 });
      m.on("click", (e) => { L.DomEvent.stopPropagation(e); seleccionar(t.id); });
      m.addTo(layers.trenes);
      o = { m, x: t.lat, y: t.lon };
      nodos.set(t.id, o);
    }
    o.t = t;
    // >= 15 min: bigger dot with a ring in the text colour, so it stands out without relying on hue
    const g = nivel(t.ret) === "grave";
    o.m.setStyle({ fillColor: COL[nivel(t.ret)], color: g ? COL.texto : COL.halo, weight: g ? 1.8 : 1.2, fillOpacity: t.red === "cer" ? 0.6 : md ? 0.75 : 1,
      radius: ((t.red === "cer" ? 2.8 : md ? 3.6 : 5) + (g ? 1.6 : 0)) * (z >= 9 ? 1.3 : 1) });
  }
  // AV over regionals, most delayed on top
  const capa = (t) => (t.red === "cer" ? 2 : t.tipo === "md" ? 1 : 0);
  [...nodos.values()].sort((a, b) => capa(b.t) - capa(a.t) || a.t.ret - b.t.ret).forEach((o) => o.m.bringToFront());
  const ahora = performance.now();
  for (const o of nodos.values()) { o.bx = o.x; o.by = o.y; o.b0 = ahora; }
  const vis5 = vis.filter((t) => t.ret >= 5).length;
  const orden = vis.map((t) => Math.max(0, t.ret)).sort((a, b) => a - b);
  $("nTotal").textContent = vis.length;
  $("nRet").textContent = vis5;
  $("medio").textContent = (orden.length ? orden[Math.floor(orden.length / 2)] : 0) + " min";
  etiquetar();
}

// Estimated position each frame: last GPS fix + velocity × elapsed (max 120 s), eased over 1.5 s after each update.
function objetivo(t, ahoraSrv) {
  if (quieto() || (!t.vlat && !t.vlon)) return [t.lat, t.lon];
  const dt = Math.min(120, Math.max(0, (ahoraSrv - t.ts) / 1000));
  return [t.lat + t.vlat * dt, t.lon + t.vlon * dt];
}
let ultimoEtq = 0, ultimoSeguir = 0;
function arrancarMovimiento() {
  const paso = (now) => {
    if (!document.hidden && !$("v-mapa").hidden) {
      const ahoraSrv = Date.now() + desfase;
      for (const o of nodos.values()) {
        const [x, y] = objetivo(o.t, ahoraSrv);
        const a = quieto() ? 1 : Math.min(1, (now - (o.b0 || 0)) / 1500), e = 1 - Math.pow(1 - a, 3);
        o.x = o.bx + (x - o.bx) * e; o.y = o.by + (y - o.by) * e;
        if (a >= 1) { o.bx = x; o.by = y; }
        o.m.setLatLng([o.x, o.y]);
        o.lbl?.setLatLng([o.x, o.y]);
      }
      if (seleccion && siguiendo && now - ultimoSeguir > 1000) {
        ultimoSeguir = now;
        const o = nodos.get(seleccion);
        if (o && fueraDeVista(o)) map.panTo(centro([o.x, o.y]), { animate: !quieto(), duration: 0.8 });
      }
      if (now - ultimoEtq > 3000) { ultimoEtq = now; etiquetar(); }
      if (anillo && seleccion) { const o = nodos.get(seleccion); if (o) anillo.setLatLng([o.x, o.y]); }
    }
    requestAnimationFrame(paso);
  };
  requestAnimationFrame(paso);
}

// ---------- labels (collision-avoided, zoom dependent) ----------
let anillo = null;
function etiquetar() {
  if (!map) return;
  layers.etq.clearLayers();
  for (const o of nodos.values()) o.lbl = null;
  anillo = null;
  const z = map.getZoom(), movil = esMovil(), size = map.getSize();
  const cajas = [[0, 0, size.x, ($("tipos").offsetHeight || 40) + 16], [size.x - 56, 0, size.x, 170]];
  if (movil) cajas.push([0, size.y - 170, size.x, size.y], [0, 50, 120, 90]); // bottom sheet peek, legend toggle
  const libre = (b) => !cajas.some((c) => !(b[2] < c[0] || b[0] > c[2] || b[3] < c[1] || b[1] > c[3]));
  const bounds = map.getBounds().pad(0.05);
  for (const o of nodos.values()) if (bounds.contains([o.x, o.y])) { const p = map.latLngToContainerPoint([o.x, o.y]); cajas.push([p.x - 4, p.y - 4, p.x + 4, p.y + 4]); }
  const quien = (t) => {
    const md = t.tipo === "md";
    if (t.id === seleccion) return true;
    if (t.red === "cer") return z >= (movil ? 11 : 10.5);
    if (movil) return z >= 7.5 && (t.ret >= 5 || z >= 9) && (!md || z >= 9);
    if (z >= 8) return true;
    if (z >= 7) return !md;
    return !md && t.ret >= 5;
  };
  const cand = [...nodos.values()].filter((o) => bounds.contains([o.x, o.y]) && quien(o.t))
    .sort((a, b) => (b.t.id === seleccion) - (a.t.id === seleccion) || b.t.ret - a.t.ret);
  for (const o of cand) {
    const t = o.t, tag = t.red === "cer" ? t.linea + " " : "", txt = tag + t.n + (t.ret >= 1 ? " +" + t.ret : "");
    const w = txt.length * 7.4 + 12, h = 19, p = map.latLngToContainerPoint([o.x, o.y]);
    const ops = [[8, -h - 6], [8, 6], [-w - 8, -h - 6], [-w - 8, 6]];
    let pos = null;
    for (const [dx, dy] of ops) { const b = [p.x + dx, p.y + dy, p.x + dx + w, p.y + dy + h]; if (libre(b)) { pos = [dx, dy]; cajas.push(b); break; } }
    if (!pos) { if (t.id !== seleccion) continue; pos = ops[0]; }
    const html = `<div class="etq ${nivel(t.ret)}${t.id === seleccion ? " sel" : ""}" style="left:${pos[0]}px;top:${pos[1]}px">${tag ? `<small>${esc(tag.trim())}</small>` : ""}${t.n}${t.ret >= 1 ? `<b> +${t.ret}</b>` : ""}</div>`;
    o.lbl = L.marker([o.x, o.y], { icon: L.divIcon({ className: "", html, iconSize: [0, 0] }), interactive: true, keyboard: false })
      .on("click", (e) => { L.DomEvent.stopPropagation(e); seleccionar(t.id); }).addTo(layers.etq);
  }
  const sel = seleccion && nodos.get(seleccion);
  if (sel) anillo = L.circleMarker([sel.x, sel.y], { renderer, radius: 13, color: COL.acento, weight: 2.5, fill: false, interactive: false }).addTo(layers.etq);
}

// Our own city labels: only with the fallback land map (the vector basemap already has place names).
function ciudades() {
  if (!BASE || !map) return;
  layers.ciudades.clearLayers();
  if (vectorial) return;
  const z = map.getZoom();
  const n = z < 6 ? 14 : z < 7 ? 26 : z < 8 ? 40 : 60;
  const cajas = [], bounds = map.getBounds();
  for (const c of BASE.principales.slice(0, n)) {
    if (!bounds.contains([c.lat, c.lon])) continue;
    const p = map.latLngToContainerPoint([c.lat, c.lon]);
    const b = [p.x + 6, p.y - 8, p.x + 6 + c.n.length * 7, p.y + 8];
    if (cajas.some((k) => !(b[2] < k[0] || b[0] > k[2] || b[3] < k[1] || b[1] > k[3]))) continue;
    cajas.push(b);
    L.circleMarker([c.lat, c.lon], { renderer, radius: 2.5, color: COL.ciudad, weight: 0, fillColor: COL.ciudad, fillOpacity: 1, interactive: false }).addTo(layers.ciudades);
    L.marker([c.lat, c.lon], { icon: L.divIcon({ className: "", html: `<a class="ciudad-lbl" href="#/estacion/${c.code}" title="Salidas y llegadas de ${esc(c.n)}" style="left:6px;top:-9px">${esc(c.n)}</a>`, iconSize: [0, 0] }), keyboard: false }).addTo(layers.ciudades);
  }
}

// Cercanías lines (Renfe's lineas.geojson), only when zoomed in and Cercanías is shown
let redCer = null, redCerPedida = false;
async function lineasCercanias() {
  const ver = activos.has("cer") && map.getZoom() >= 9;
  if (!ver) { layers.redCer.clearLayers(); return; }
  if (layers.redCer.getLayers().length) return;
  if (!redCer) {
    if (redCerPedida) return;
    redCerPedida = true;
    try { redCer = await api("/api/red-cercanias"); } catch { redCerPedida = false; return; }
  }
  for (const l of redCer) L.polyline(l.g, { renderer, color: l.c || COL.via_cer, weight: 2.2, opacity: 0.6, interactive: false }).addTo(layers.redCer);
}

// ---------- selection & card ----------
function fueraDeVista(o) {
  if (!esMovil()) return !map.getBounds().pad(-0.3).contains([o.x, o.y]);
  const p = map.latLngToContainerPoint([o.x, o.y]), z = map.getSize();
  return p.y < z.y * 0.08 || p.y > z.y * 0.38 || p.x < z.x * 0.15 || p.x > z.x * 0.85;
}
// On mobile the card covers the lower part of the map: aim the train at the visible upper area.
function centro(ll, z = map.getZoom()) {
  if (!esMovil() || $("ficha").hidden && !seleccion) return ll;
  const p = map.project(ll, z).add([0, map.getSize().y * 0.28]);
  return map.unproject(p, z);
}

export function seleccionar(n, centrar = false) {
  const t = n && D.trenes.find((x) => x.id === n);
  if (t && !nodos.has(n)) { // hidden by the type or zone filter: show it
    if (!activos.has(t.tipo)) { activos.add(t.tipo); store.set("tipos", [...activos]); }
    if (!enZona(t)) { zona = "todo"; store.set("zona", zona); pintarZonas(); }
    pintarTipos(); pintarTrenes(); pintarLista(); lineasCercanias();
  }
  seleccion = n;
  siguiendo = !!n;
  pintarFicha(); pintarLista(); etiquetar();
  if (n && centrar) { const o = nodos.get(n), z = Math.max(map.getZoom(), 9); if (o) map.flyTo(centro([o.x, o.y], z), z, { duration: quieto() ? 0 : 0.6 }); }
}

function pintarFicha() {
  const f = $("ficha");
  const t = seleccion && D.trenes.find((x) => x.id === seleccion);
  if (!t) { f.hidden = true; $("v-mapa").classList.remove("con-ficha"); if (seleccion && D.trenes.length) seleccion = null; return; }
  f.className = "ficha " + nivel(t.ret);
  f.hidden = false;
  $("v-mapa").classList.add("con-ficha");
  f.style.top = esMovil() ? "" : $("tipos").offsetHeight + 22 + "px";
  f.setAttribute("aria-label", `Ficha del tren ${t.nom} ${t.n}`);
  f.innerHTML = `<button class="cerrar" aria-label="Cerrar ficha"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
    <h3>${esc(t.nom)} ${esc(t.n)}</h3><div class="ruta">${t.red === "cer" ? esc(t.nucleo) + ", " : ""}${esc(corto(t.ori))} → ${esc(corto(t.des))}</div><dl>
    <dt>Retraso</dt><dd>${retBadge(t.ret)}</dd>
    ${t.lleg ? `<dt>Llegada prevista</dt><dd>${t.lleg}</dd><dt>Llegada estimada</dt><dd>${addMin(t.lleg, Math.max(0, t.ret))}</dd>` : ""}
    <dt>Velocidad</dt><dd>${t.kmh == null ? "calculando…" : t.kmh < 4 ? (t.parado >= 2 ? `Parado ${t.parado} min` : "Parado") : "≈ " + t.kmh + " km/h"}</dd>
    <dt>Dónde</dt><dd>${esc(tramo(t))}</dd>
    ${t.hs && t.ant !== t.sig ? `<dt>Llega a ${esc(corto(t.sig))}</dt><dd>${t.hs}</dd>` : ""}
    ${t.via ? `<dt>Vía</dt><dd>${esc(t.via)}</dd>` : ""}
    ${t.acc ? `<dt>Accesible</dt><dd>Sí</dd>` : ""}
    <dt>Últimos 30 días</dt><dd id="fichaPunt">…</dd></dl>
    <div class="acciones"><a class="btn prim" href="#/tren/${t.id}">Ver recorrido</a><a class="btn ${isTracked(t.id) ? "on" : ""}" href="#/tren/${t.id}?alarma=1">${isTracked(t.id) ? "Alarma activa" : "Crear alarma"}</a></div>`;
  puntualidadFicha(t.id);
  f.querySelector(".cerrar").onclick = () => seleccionar(null);
}

const puntCache = new Map();
async function puntualidadFicha(id) {
  let p = puntCache.get(id);
  if (!p || Date.now() - p.at > 600_000) {
    try { p = { at: Date.now(), d: await api("/api/puntualidad/" + id) }; puntCache.set(id, p); } catch { return; }
  }
  const el = $("fichaPunt");
  if (el && seleccion === id) el.textContent = puntTexto(p.d);
}

// ---------- delayed arrivals ----------
function pintarLista() {
  const vis = visibles();
  const ret = vis.filter((t) => t.ret >= 5 && enZona(t)).sort((a, b) => b.ret - a.ret);
  const z = BASE?.zones.find((x) => x.id === zona);
  $("sub").textContent = ret.length ? `${ret.length} ${ret.length === 1 ? "tren llegará" : "trenes llegarán"} ${z?.regions ? "a " + z.name + " " : ""}5 min tarde o más` : "";
  const N = expandida ? ret.length : esMovil() ? 6 : 12;
  $("lista").innerHTML = ret.length ? ret.slice(0, N).map((t) => `<li class="${nivel(t.ret)}${t.id === seleccion ? " sel" : ""}" data-n="${t.id}" tabindex="0">
      <span class="min" aria-label="${t.ret} minutos de retraso"><b>+${t.ret}</b><small>min</small></span>
      <div><div class="tren">${esc(t.nom)} ${esc(corto(t.ori))} → ${esc(corto(t.des))}<small>${t.n}</small></div>
      <div class="donde">${esc(tramo(t))}</div></div>
      <div class="horas">${t.lleg ? `<del>${t.lleg}</del>${addMin(t.lleg, t.ret)}` : ""}</div></li>`).join("")
    : `<li class="vacio">${D.trenes.length ? `Ningún tren de los tipos elegidos llega${z?.regions ? " a " + esc(z.name) : ""} con 5 minutos o más de retraso.` : "Esperando datos de Renfe…"}</li>`;
  $("mas").hidden = ret.length <= N;
  $("mas").textContent = `Ver ${ret.length - N} más`;
}

// ---------- stations (from search) ----------
export function mostrarEstacion(st) {
  siguiendo = false;
  map.flyTo([st.lat, st.lon], 11, { duration: 0.6 });
  L.popup({ maxWidth: 320 }).setLatLng([st.lat, st.lon]).setContent(`<b>${esc(st.n)}</b><br><small>${esc(st.reg || "")}</small><br><br><a href="#/estacion/${st.code}">Ver salidas y llegadas</a>`).openOn(map);
}

// ---------- places (municipalities from search) ----------
// Fly there and list the live trains within RADIO km plus the nearest stations we know of.
const RADIO = 10;
let lugarCirculo = null;
export function mostrarLugar(p) {
  siguiendo = false;
  seleccionar(null);
  const z = 12;
  map.flyTo(centro([p.lat, p.lon], z), z, { duration: quieto() ? 0 : 0.8 });
  lugarCirculo?.remove();
  lugarCirculo = L.circle([p.lat, p.lon], { renderer, radius: RADIO * 1000, color: COL.acento, weight: 1.5, dashArray: "4 6", fill: false, interactive: false }).addTo(map);
  const circ = lugarCirculo;
  const trenes = D.trenes.map((t) => ({ t, d: distKm(p.lat, p.lon, t.lat, t.lon) })).filter((x) => x.d <= RADIO).sort((a, b) => a.d - b.d);
  const vistas = new Map();
  for (const [code, e] of Object.entries(D.est || {})) if (e?.lat) vistas.set(code, { code, n: e.n || e.c, lat: e.lat, lon: e.lon });
  for (const c of BASE?.principales || []) if (!vistas.has(c.code)) vistas.set(c.code, c);
  const estaciones = [...vistas.values()].map((e) => ({ e, d: distKm(p.lat, p.lon, e.lat, e.lon) })).filter((x) => x.d <= RADIO * 1.5).sort((a, b) => a.d - b.d).slice(0, 4);
  const km = (d) => (d < 1 ? "< 1 km" : d.toFixed(d < 10 ? 1 : 0).replace(".", ",") + " km");
  const html = `<div class="lugar-pop">
    <h3>${esc(p.n)}</h3><small>${esc(p.prov || "")}</small>
    <h4>Trenes a menos de ${RADIO} km <span>${trenes.length}</span></h4>
    ${trenes.length ? `<ul>${trenes.slice(0, 8).map(({ t, d }) => `<li><a href="#/tren/${t.id}"><b>${t.red === "cer" ? esc(t.linea || "") + " " : ""}${esc(t.n)}</b> <span>${esc(t.nom)}</span></a>${retBadge(t.ret, t.ret >= 1 ? "+" + t.ret + " min" : "En hora")}<small>${km(d)}</small></li>`).join("")}</ul>${trenes.length > 8 ? `<p class="mas-l">y ${trenes.length - 8} más en el mapa</p>` : ""}`
      : `<p>Ahora no hay ningún tren con posición cerca de aquí.</p>`}
    ${estaciones.length ? `<h4>Estaciones cercanas</h4><ul>${estaciones.map(({ e, d }) => `<li><a href="#/estacion/${e.code}">${esc(e.n)}</a><small>${km(d)}</small></li>`).join("")}</ul>` : ""}
  </div>`;
  L.popup({ maxWidth: 320, minWidth: 250, autoPanPaddingTopLeft: [10, esMovil() ? 70 : 140], autoPanPaddingBottomRight: [70, esMovil() ? 170 : 40] })
    .setLatLng([p.lat, p.lon]).setContent(html).on("remove", () => { circ.remove(); if (lugarCirculo === circ) lugarCirculo = null; }).openOn(map);
}

