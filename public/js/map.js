// Home view: live map, train card, delayed arrivals, incidents (Vía libre parity) + proximity anomalies.
import { $, esc, store, api, COL, nivel, durTxt, addMin, horaLocal } from "./util.js";
import { baseLand, puntTexto } from "./util.js";
import { isTracked } from "./alarms.js";

let BASE = null, D = { trenes: [], est: {}, incidencias: [], fuentes: {}, proximidad: [] };
let map, renderer, layers = {}, desfase = 0;
const nodos = new Map(); // n → { m: circleMarker, t, x, y, bx, by, b0, lbl }
let seleccion = null, siguiendo = false, expandida = false;
const activos = new Set(store.get("tipos", ["ave", "avlo", "avant", "alvia", "ld", "md", "cer"]));
let zona = store.get("zona", "todo");

const quieto = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const esMovil = () => innerWidth <= 860;
const visibles = () => D.trenes.filter((t) => activos.has(t.tipo));
const corto = (c) => D.est[c]?.c || "estación " + c;
const tramo = (t) => (t.ant === t.sig ? "En " + corto(t.ant) : "Entre " + corto(t.ant) + " y " + corto(t.sig));
const SPAIN = [[35.9, -9.6], [43.9, 3.4]];

export async function initMap() {
  map = L.map("mapa", { zoomControl: false, preferCanvas: true, minZoom: 5, maxZoom: 15, zoomSnap: 0.25, wheelPxPerZoomLevel: 90, attributionControl: true });
  map.attributionControl.setPrefix(false);
  map.fitBounds(SPAIN, { padding: [10, 10] });
  L.control.zoom({ position: "topright", zoomInTitle: "Acercar", zoomOutTitle: "Alejar" }).addTo(map);
  const Todo = L.Control.extend({ onAdd() { const b = L.DomUtil.create("div", "leaflet-bar"); b.innerHTML = '<a href="#" role="button" title="Ver toda España" aria-label="Ver toda España">⤢</a>'; b.firstChild.onclick = (e) => { e.preventDefault(); siguiendo = false; map.flyToBounds(SPAIN, { duration: 0.5 }); }; return b; } });
  new Todo({ position: "topright" }).addTo(map);
  renderer = L.canvas({ padding: 0.3 });
  baseLand(map).catch((e) => console.warn("tierra", e));
  for (const k of ["red", "redCer", "inc", "prox", "trenes"]) layers[k] = L.layerGroup().addTo(map);
  layers.ciudades = L.layerGroup().addTo(map);
  layers.etq = L.layerGroup().addTo(map);

  map.on("zoomend moveend", () => { etiquetar(); ciudades(); lineasCercanias(); });
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
    const b = e.target.closest("button[data-id]"); if (!b) return;
    activos.has(b.dataset.id) ? activos.delete(b.dataset.id) : activos.add(b.dataset.id);
    store.set("tipos", [...activos]);
    if (seleccion && !visibles().some((t) => t.id === seleccion)) seleccion = null;
    pintarTipos(); pintarTrenes(); pintarLista(); pintarFicha(); lineasCercanias();
  });
  $("zonas").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-z]"); if (!b) return;
    zona = b.dataset.z; store.set("zona", zona); expandida = false; pintarZonas(); pintarLista();
  });
  $("mas").onclick = () => { expandida = true; pintarLista(); };
  const elegir = (li) => { if (!li) return; seleccionar(li.dataset.n, true); if (esMovil()) $("mapaBox").scrollIntoView({ behavior: "smooth" }); };
  $("lista").addEventListener("click", (e) => elegir(e.target.closest("li[data-n]")));
  $("lista").addEventListener("keydown", (e) => { if (e.key === "Enter") elegir(e.target.closest("li[data-n]")); });
  $("inc").addEventListener("click", (e) => irIncidencia(e.target.closest("[data-id]")));
  $("inc").addEventListener("keydown", (e) => { if (e.key === "Enter") irIncidencia(e.target.closest("[data-id]")); });
  $("proxLista").addEventListener("click", (e) => { const b = e.target.closest("button[data-n]"); if (b) seleccionar(b.dataset.n, true); });

  try {
    BASE = await api("/api/base");
    pintarZonas();
    const red = await api("/api/red");
    L.polyline(red.map((s) => [[s[0], s[1]], [s[2], s[3]]]), { renderer, color: "#4E6274", weight: 1.6, opacity: 0.9, interactive: false }).addTo(layers.red);
    ciudades();
  } catch (e) { console.warn("base", e); }
  arrancarMovimiento();
}

export function invalidate() { map?.invalidateSize(); }

export function update(data) {
  D = data;
  if (D.generado) desfase = Date.parse(D.generado) - Date.now();
  pintarTipos(); pintarIncidencias(); pintarProximidad(); pintarTrenes(); pintarLista(); pintarFicha();
}

// ---------- header chips ----------
function pintarTipos() {
  if (!BASE) return;
  const cuenta = (id) => D.trenes.filter((x) => x.tipo === id).length;
  $("tipos").innerHTML = BASE.types.map((t) => t.noData
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

// ---------- incidents ----------
function pintarIncidencias() {
  layers.inc.clearLayers();
  const lista = D.incidencias || [];
  const ad = D.fuentes.adif || {};
  if (!ad.ok && !ad.triedAt && !lista.length) { $("incFuente").textContent = "Consultando Adif…"; $("inc").innerHTML = '<li class="vacio">Cargando avisos de Adif…</li>'; return; }
  $("incFuente").textContent = ad.ok ? `Fuentes: Adif (leído a las ${horaLocal(D.adifHora)}) y detección propia sobre datos de Renfe`
    : D.adifHora ? `Adif no responde; avisos leídos a las ${horaLocal(D.adifHora)}` : "Adif no responde; solo incidencias detectadas en los datos de Renfe";
  if (!lista.length) {
    $("inc").innerHTML = `<li class="vacio">${ad.ok ? "Ni Adif ni los datos de Renfe muestran incidencias en este momento." : "No se pueden leer los avisos de Adif (se reintenta cada minuto) y no se detectan incidencias en los datos de Renfe."}</li>`;
    return;
  }
  const etiqueta = { grave: "Grave", leve: "Afecta", info: "Aviso" };
  $("inc").innerHTML = lista.map((i) => `<li class="${i.level}" data-id="${esc(i.id)}" tabindex="0" ${i.path ? 'title="Ver en el mapa"' : ""}><span class="rombo"></span>
    <div><div class="tit">${esc(i.title)}<span class="fuente">${i.source === "adif" ? "Adif" : "detectada"}</span></div><div class="txt">${esc((i.text || []).join(" "))}</div><div class="zona">${esc(i.scope || "")}</div></div>
    <div class="desde"><b>${etiqueta[i.level]}</b>${i.seen ? "desde " + horaLocal(i.seen) : ""}</div></li>`).join("");
  for (const i of lista) {
    if (!i.path || i.path.length < 2) continue;
    const c = COL[i.level];
    L.polyline(i.path, { renderer, color: c, weight: 10, opacity: 0.25, lineCap: "round", interactive: false }).addTo(layers.inc);
    L.polyline(i.path, { renderer, color: c, weight: 3, dashArray: "6 5", interactive: false }).addTo(layers.inc);
    const mid = i.path[Math.floor(i.path.length / 2)];
    const p = i.path.length === 2 ? [(i.path[0][0] + i.path[1][0]) / 2, (i.path[0][1] + i.path[1][1]) / 2] : mid;
    L.marker(p, { icon: L.divIcon({ className: "", html: `<div style="width:12px;height:12px;background:${c};border:2px solid #16202A;transform:rotate(45deg)"></div>`, iconSize: [12, 12] }), keyboard: false })
      .on("click", () => irIncidencia(document.querySelector(`#inc [data-id="${CSS.escape(i.id)}"]`))).addTo(layers.inc);
  }
}
function irIncidencia(li) {
  if (!li) return;
  li.classList.toggle("abierta");
  const i = D.incidencias.find((x) => x.id === li.dataset.id);
  if (!i?.path) return;
  siguiendo = false;
  map.flyToBounds(L.latLngBounds(i.path), { padding: [60, 60], maxZoom: 10, duration: 0.6 });
  if (esMovil()) $("mapaBox").scrollIntoView({ behavior: "smooth" });
}

function pintarProximidad() {
  layers.prox.clearLayers();
  const ps = D.proximidad || [];
  for (const p of ps) L.circle([p.lat, p.lon], { radius: Math.max(400, p.distM), color: COL.prox, weight: 2, dashArray: "2 5", fill: false, interactive: false }).addTo(layers.prox);
  $("proxLista").hidden = !ps.length;
  $("proxLista").innerHTML = ps.length ? `<h3>Anomalías de proximidad (experimental)</h3>
    <p>Dos trenes en el mismo tramo y sentido, más cerca que la distancia de frenado estimada. Calculado con GPS impreciso y con retraso: no es un sistema de seguridad.</p>
    ${ps.map((p) => `<button data-n="${p.follower}">${p.follower} → ${p.leader}: ${(p.distM / 1000).toFixed(1)} km (frenado ≈ ${(p.requiredM / 1000).toFixed(1)} km a ${p.kmh[0]} km/h)</button>`).join("")}` : "";
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
      const m = L.circleMarker([t.lat, t.lon], { renderer, radius: 5, weight: 1.3, color: "#16202A", fillOpacity: 1 });
      m.on("click", (e) => { L.DomEvent.stopPropagation(e); seleccionar(t.id); });
      m.addTo(layers.trenes);
      o = { m, x: t.lat, y: t.lon };
      nodos.set(t.id, o);
    }
    o.t = t;
    o.m.setStyle({ fillColor: COL[nivel(t.ret)], fillOpacity: t.red === "cer" ? 0.55 : md ? 0.65 : 1, radius: (t.red === "cer" ? 2.8 : md ? 3.6 : 5) * (z >= 9 ? 1.3 : 1) });
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
        if (o && !map.getBounds().pad(-0.3).contains([o.x, o.y])) map.panTo([o.x, o.y], { animate: true, duration: 0.8 });
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
  const cajas = [[0, 0, Math.min(size.x, 900), 50], [size.x - 60, 0, size.x, 150]];
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
    const c = COL[nivel(t.ret)];
    const html = `<div class="etq" style="border-color:${c};${t.id === seleccion ? "border-width:2.4px" : ""};position:absolute;left:${pos[0]}px;top:${pos[1]}px">${tag ? `<span style="color:var(--texto2)">${esc(tag)}</span>` : ""}${t.n}${t.ret >= 1 ? `<b style="color:${c}"> +${t.ret}</b>` : ""}</div>`;
    o.lbl = L.marker([o.x, o.y], { icon: L.divIcon({ className: "", html, iconSize: [0, 0] }), interactive: true, keyboard: false })
      .on("click", (e) => { L.DomEvent.stopPropagation(e); seleccionar(t.id); }).addTo(layers.etq);
  }
  const sel = seleccion && nodos.get(seleccion);
  if (sel) anillo = L.circleMarker([sel.x, sel.y], { renderer, radius: 12, color: COL[nivel(sel.t.ret)], weight: 2, fill: false, interactive: false }).addTo(layers.etq);
}

function ciudades() {
  if (!BASE || !map) return;
  layers.ciudades.clearLayers();
  const z = map.getZoom();
  const n = z < 6 ? 14 : z < 7 ? 26 : z < 8 ? 40 : 60;
  const cajas = [], bounds = map.getBounds();
  for (const c of BASE.principales.slice(0, n)) {
    if (!bounds.contains([c.lat, c.lon])) continue;
    const p = map.latLngToContainerPoint([c.lat, c.lon]);
    const b = [p.x + 6, p.y - 8, p.x + 6 + c.n.length * 7, p.y + 8];
    if (cajas.some((k) => !(b[2] < k[0] || b[0] > k[2] || b[3] < k[1] || b[1] > k[3]))) continue;
    cajas.push(b);
    L.circleMarker([c.lat, c.lon], { renderer, radius: 2.5, color: "#8DA2B6", weight: 0, fillOpacity: 1, interactive: false }).addTo(layers.ciudades);
    L.marker([c.lat, c.lon], { icon: L.divIcon({ className: "", html: `<a class="ciudad-lbl" href="#/estacion/${c.code}" title="Salidas y llegadas" style="position:absolute;left:6px;top:-8px">${esc(c.n)}</a>`, iconSize: [0, 0] }), keyboard: false }).addTo(layers.ciudades);
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
  for (const l of redCer) L.polyline(l.g, { renderer, color: l.c || "#8DA2B6", weight: 2.2, opacity: 0.55, interactive: false }).addTo(layers.redCer);
}

// ---------- selection & card ----------
export function seleccionar(n, centrar = false) {
  seleccion = n;
  siguiendo = !!n;
  pintarFicha(); pintarLista(); etiquetar();
  if (n && centrar) { const o = nodos.get(n); if (o) map.flyTo([o.x, o.y], Math.max(map.getZoom(), 9), { duration: 0.6 }); }
}

function pintarFicha() {
  const f = $("ficha");
  const t = seleccion && D.trenes.find((x) => x.id === seleccion);
  if (!t) { f.hidden = true; if (seleccion && D.trenes.length) seleccion = null; return; }
  f.className = "ficha " + nivel(t.ret);
  f.hidden = false;
  f.innerHTML = `<button class="cerrar" aria-label="Cerrar ficha">×</button>
    <h3>${esc(t.nom)} ${esc(t.n)}</h3><div class="ruta">${t.red === "cer" ? esc(t.nucleo) + " · " : ""}${esc(corto(t.ori))} → ${esc(corto(t.des))}</div><dl>
    <dt>Retraso</dt><dd class="n">${durTxt(t.ret)}</dd>
    ${t.lleg ? `<dt>Llegada prevista</dt><dd>${t.lleg}</dd><dt>Llegada estimada</dt><dd>${addMin(t.lleg, Math.max(0, t.ret))}</dd>` : ""}
    <dt>Velocidad</dt><dd>${t.kmh == null ? "calculando…" : t.kmh < 4 ? (t.parado >= 2 ? `Parado ${t.parado} min` : "Parado") : "≈ " + t.kmh + " km/h"}</dd>
    <dt>Dónde</dt><dd>${esc(tramo(t))}</dd>
    ${t.hs && t.ant !== t.sig ? `<dt>Llega a ${esc(corto(t.sig))}</dt><dd>${t.hs}</dd>` : ""}
    ${t.via ? `<dt>Vía</dt><dd>${esc(t.via)}</dd>` : ""}
    ${t.acc ? `<dt>Accesible</dt><dd>Sí</dd>` : ""}
    <dt>Últimos 30 días</dt><dd id="fichaPunt">…</dd></dl>
    <div class="acciones"><a class="btn prim" href="#/tren/${t.id}">${t.red === "cer" ? "Ver tren" : "Ver recorrido"}</a><a class="btn ${isTracked(t.id) ? "on" : ""}" href="#/tren/${t.id}?alarma=1">${isTracked(t.id) ? "Alarma activa" : "Crear alarma"}</a></div>`;
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
      <span class="min">+${t.ret}</span>
      <div><div class="tren">${esc(t.nom)} ${esc(corto(t.ori))} → ${esc(corto(t.des))}<small>${t.n}</small></div>
      <div class="donde">${esc(tramo(t))}</div></div>
      <div class="horas">${t.lleg ? `<del>${t.lleg}</del>${addMin(t.lleg, t.ret)}` : ""}</div></li>`).join("")
    : `<li class="vacio">${D.trenes.length ? "Ningún tren de los tipos elegidos llega con 5 minutos o más de retraso." : "Esperando datos de Renfe…"}</li>`;
  $("mas").hidden = ret.length <= N;
  $("mas").innerHTML = `Ver <b>${ret.length - N} más</b>`;
}

// ---------- stations (from search) ----------
export function mostrarEstacion(st) {
  siguiendo = false;
  map.flyTo([st.lat, st.lon], 11, { duration: 0.6 });
  L.popup({ maxWidth: 320 }).setLatLng([st.lat, st.lon]).setContent(`<b>${esc(st.n)}</b><br><small>${esc(st.reg || "")}</small><br><br><a href="#/estacion/${st.code}">Ver salidas y llegadas</a>`).openOn(map);
}
