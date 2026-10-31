// Incidencias tab (#/incidencias): network incidents (Adif + detected), their sections on a map,
// proximity anomalies (experimental) and Renfe's station/line notices.
import { $, esc, api, COL, horaLocal, fechaHora, redFerroviaria, rombo, onTema, NIVEL_INC } from "./util.js";
import { fondo } from "./basemap.js";

let D = null, mapa = null, capas = null, redLinea = null, foco = null, avisos = null, avisosAt = 0, filtro = "", timer = null;
const SPAIN = [[35.9, -9.6], [43.9, 3.4]];
const marcadores = new Map(); // incident id -> marker
const abiertas = new Set(); // incidents whose full text is expanded (kept across re-renders)
let activa = null;

export function showIncidencias(data, { id } = {}) {
  foco = id || null;
  if (!$("v-incidencias").dataset.listo) esqueleto();
  if (data) D = data;
  pintar();
  cargarAvisos();
  clearInterval(timer);
  timer = setInterval(() => { if (!$("v-incidencias").hidden) cargarAvisos(); }, 120_000);
}
export function updateIncidencias(data) { D = data; pintar(); }
export function hideIncidencias() { clearInterval(timer); }

function esqueleto() {
  const v = $("v-incidencias");
  v.dataset.listo = "1";
  v.innerHTML = `
    <div class="cab-pagina">
      <h1>Incidencias en la red</h1>
      <p class="sub" id="incFuente">Consultando Adif…</p>
    </div>
    <div class="inc-grid">
      <div>
        <div class="inc-resumen" id="incResumen" aria-live="polite"></div>
        <ul class="inc-lista" id="incLista"></ul>
      </div>
      <div class="inc-mapa-box">
        <div class="inc-mapa" id="incMapa" role="region" aria-label="Mapa de los tramos afectados"></div>
        <p class="nota">Tramos afectados en línea discontinua; el rombo marca cada incidencia. Pulsa uno para ver su aviso.</p>
      </div>
    </div>
    <section class="bloque" aria-labelledby="tProx">
      <h2 id="tProx">Anomalías de proximidad <span class="exp">experimental</span></h2>
      <p class="sub">Dos trenes en el mismo tramo y sentido, más cerca que la distancia de frenado estimada. Se calcula con posiciones GPS públicas, imprecisas y con hasta un minuto de retraso: <b>no es un sistema de seguridad</b>. La separación real entre trenes la garantiza la señalización, y no vemos los trenes de Iryo ni de Ouigo.</p>
      <div id="proxBox"></div>
    </section>
    <section class="bloque" aria-labelledby="tAvisos">
      <h2 id="tAvisos">Avisos de Renfe en estaciones y líneas</h2>
      <p class="sub" id="avisosSub">Cargando avisos de Renfe…</p>
      <div class="avisos-filtro"><label class="vh" for="avisosQ">Filtrar avisos</label><input id="avisosQ" type="search" placeholder="Filtrar por estación, línea o texto"></div>
      <div id="avisosBox"></div>
    </section>`;
  $("incLista").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]"); if (!b) return;
    const li = b.closest("[data-id]");
    if (b.dataset.act === "mapa") enfocar(li.dataset.id, true);
    else if (b.dataset.act === "mas") { const t = li.querySelector(".txt"); const corta = t.classList.toggle("corta"); corta ? abiertas.delete(li.dataset.id) : abiertas.add(li.dataset.id); b.textContent = corta ? "Leer el aviso completo" : "Mostrar menos"; b.setAttribute("aria-expanded", !corta); }
  });
  $("avisosQ").addEventListener("input", (e) => { filtro = e.target.value.trim().toLowerCase(); pintarAvisos(); });
}

function crearMapa() {
  if (mapa) { mapa.invalidateSize(); return; }
  mapa = L.map("incMapa", { zoomControl: true, attributionControl: true, scrollWheelZoom: false, preferCanvas: true, minZoom: 5, maxZoom: 14, zoomSnap: 0.25 });
  mapa.attributionControl.setPrefix(false);
  mapa.fitBounds(SPAIN);
  fondo(mapa);
  const renderer = L.canvas({ padding: 0.3 });
  capas = { red: L.layerGroup().addTo(mapa), inc: L.layerGroup().addTo(mapa), prox: L.layerGroup().addTo(mapa), renderer };
  redFerroviaria().then((red) => {
    if (!mapa) return;
    redLinea = L.polyline(red.map((s) => [[s[0], s[1]], [s[2], s[3]]]), { renderer, color: COL.via, weight: 1.2, opacity: 0.8, interactive: false }).addTo(capas.red);
  }).catch(() => {});
  onTema(() => { redLinea?.setStyle({ color: COL.via }); pintarMapa(); });
}

const lista = () => {
  const orden = { grave: 0, leve: 1, info: 2 };
  return [...(D?.incidencias || [])].sort((a, b) => (orden[a.level] ?? 3) - (orden[b.level] ?? 3) || (b.seen || 0) - (a.seen || 0));
};

function desde(ms) {
  if (!ms) return "";
  const min = Math.round((Date.now() - ms) / 60000);
  const hoy = new Date(ms).toDateString() === new Date().toDateString();
  const rel = min < 1 ? "hace menos de un minuto" : min < 60 ? `hace ${min} min` : min < 1440 ? `hace ${Math.floor(min / 60)} h ${min % 60} min` : `hace ${Math.floor(min / 1440)} d`;
  return `${hoy ? "las " + horaLocal(ms) : fechaHora(ms)} (${rel})`;
}

function pintar() {
  if (!$("v-incidencias").dataset.listo || $("v-incidencias").hidden) return;
  crearMapa();
  if (!D) { $("incLista").innerHTML = `<li class="card inc-vacio">Cargando incidencias…</li>`; return; }
  const ad = D.fuentes?.adif || {};
  $("incFuente").textContent = ad.ok ? `Avisos de Adif leídos a las ${horaLocal(D.adifHora)} y detección propia sobre los datos de Renfe. Se actualiza cada minuto.`
    : D.adifHora ? `Adif no responde ahora; sus avisos son de las ${horaLocal(D.adifHora)}. La detección propia sobre los datos de Renfe sigue activa.`
      : "Adif no responde; solo se muestran las incidencias detectadas en los datos de Renfe. Se reintenta cada minuto.";
  const l = lista(), n = (lv) => l.filter((i) => i.level === lv).length;
  $("incResumen").innerHTML = l.length ? [["grave", "grave", "graves"], ["leve", "afecta al servicio", "afectan al servicio"], ["info", "aviso", "avisos"]].filter(([lv]) => n(lv)).map(([lv, uno, varios]) => `<span><b>${n(lv)}</b>${n(lv) === 1 ? uno : varios}</span>`).join("") : "";
  $("incLista").innerHTML = l.length ? l.map((i) => {
    const txt = i.text || [];
    return `<li class="inc-item ${i.level}${(foco || activa) === i.id ? " activa" : ""}" data-id="${esc(i.id)}" id="inc-${esc(i.id)}">
      <div class="nv"><i class="rombo ${i.level}" aria-hidden="true"></i><span>${NIVEL_INC[i.level] || i.level}</span><span class="fuente">${i.source === "adif" ? "Aviso de Adif" : "Detectada en datos de Renfe"}</span></div>
      <h3>${esc(i.title)}</h3>
      <div class="txt${txt.length > 1 && !abiertas.has(i.id) ? " corta" : ""}">${txt.map((p) => `<p>${esc(p)}</p>`).join("")}</div>
      <dl class="meta">
        ${i.seen ? `<div><dt>Desde</dt><dd>${desde(i.seen)}</dd></div>` : ""}
        ${i.scope ? `<div><dt>Ámbito</dt><dd>${esc(i.scope)}</dd></div>` : ""}
        ${i.trains?.length ? `<div class="trenes"><dt>Trenes</dt><dd>${i.trains.map((t) => `<a href="#/tren/${esc(t)}">${esc(t.replace(/^c/, ""))}</a>`).join("")}</dd></div>` : ""}
      </dl>
      <div class="acc">
        ${i.path?.length >= 2 ? `<button class="btn peq" data-act="mapa">Ver el tramo en el mapa</button>` : ""}
        ${txt.length > 1 ? `<button class="btn peq" data-act="mas" aria-expanded="${abiertas.has(i.id)}">${abiertas.has(i.id) ? "Mostrar menos" : "Leer el aviso completo"}</button>` : ""}
      </div></li>`;
  }).join("")
    : `<li class="card inc-vacio"><b>Sin incidencias activas</b>${ad.ok ? "Ni Adif ni los datos de Renfe muestran incidencias en este momento." : "No se pueden leer los avisos de Adif (se reintenta cada minuto) y no se detectan incidencias en los datos de Renfe."}</li>`;
  pintarMapa();
  pintarProx();
  if (foco) { const id = foco; foco = null; setTimeout(() => enfocar(id, true, true), 60); }
}

function pintarMapa() {
  if (!mapa || !D) return;
  capas.inc.clearLayers(); capas.prox.clearLayers(); marcadores.clear();
  const bounds = [];
  for (const i of lista()) {
    if (!i.path || i.path.length < 2) continue;
    const c = COL[i.level] || COL.info;
    L.polyline(i.path, { renderer: capas.renderer, color: c, weight: 11, opacity: 0.22, lineCap: "round", interactive: false }).addTo(capas.inc);
    L.polyline(i.path, { renderer: capas.renderer, color: c, weight: 3.5, dashArray: "6 5", interactive: false }).addTo(capas.inc);
    const p = i.path.length === 2 ? [(i.path[0][0] + i.path[1][0]) / 2, (i.path[0][1] + i.path[1][1]) / 2] : i.path[Math.floor(i.path.length / 2)];
    const m = L.marker(p, { icon: rombo(i.level, 16), title: `${NIVEL_INC[i.level] || ""}: ${i.title}`, alt: i.title })
      .on("click", () => enfocar(i.id, false)).addTo(capas.inc);
    if (activa === i.id) m.getElement()?.classList.add("activa");
    marcadores.set(i.id, m);
    bounds.push(...i.path);
  }
  for (const p of D.proximidad || []) {
    L.circle([p.lat, p.lon], { radius: Math.max(400, p.distM), color: COL.prox, weight: 2, dashArray: "2 5", fill: false, interactive: false }).addTo(capas.prox);
    bounds.push([p.lat, p.lon]);
  }
  if (!mapa._ajustado && bounds.length) { mapa._ajustado = true; mapa.fitBounds(L.latLngBounds(bounds), { padding: [30, 30], maxZoom: 8 }); }
}

// Highlight one incident in the list and on the map; fly the map when asked.
function enfocar(id, volar, desplazar = !volar) {
  activa = id;
  const i = D?.incidencias?.find((x) => x.id === id);
  document.querySelectorAll("#incLista .inc-item").forEach((li) => li.classList.toggle("activa", li.dataset.id === id));
  marcadores.forEach((m, k) => m.getElement()?.classList.toggle("activa", k === id));
  const li = document.getElementById("inc-" + id);
  if (li && desplazar) li.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
  if (i?.path && volar && mapa) {
    if (innerWidth <= 860) $("incMapa").scrollIntoView({ block: "nearest" });
    mapa.flyToBounds(L.latLngBounds(i.path), { padding: [50, 50], maxZoom: 10, duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 0.6 });
  }
}

function pintarProx() {
  const ps = D?.proximidad || [];
  $("proxBox").innerHTML = ps.length ? `<ul class="prox-items">${ps.map((p) => `<li>
      <span><b>${esc(p.follower)}</b> detrás de <b>${esc(p.leader)}</b> a ${(p.distM / 1000).toFixed(1)} km</span>
      <span class="sub" style="margin:0">frenado estimado ≈ ${(p.requiredM / 1000).toFixed(1)} km a ${p.kmh?.[0] ?? "–"} km/h</span>
      <a class="btn peq" href="#/?tren=${encodeURIComponent(p.follower)}">Ver en el mapa</a></li>`).join("")}</ul>`
    : `<p class="nota">Ninguna en este momento.</p>`;
}

// ---------- Renfe notices (many: grouped, collapsed, filterable) ----------
async function cargarAvisos() {
  if (avisos && Date.now() - avisosAt < 110_000) return pintarAvisos();
  try { const r = await api("/api/incidencias"); avisos = r.avisosRenfe || []; avisosAt = Date.now(); }
  catch { if (!avisos) { $("avisosSub").textContent = "No se pudieron cargar los avisos de Renfe. Se reintenta en dos minutos."; return; } }
  pintarAvisos();
}

const GRUPOS = [["estacion", "Estaciones"], ["linea", "Líneas"], ["servicio", "Servicio de Cercanías"]];
function pintarAvisos() {
  if (!avisos || !$("avisosBox")) return;
  const abiertos = new Set([...document.querySelectorAll("#avisosBox details[open]")].map((d) => d.dataset.k));
  const coincide = (a) => !filtro || (a.text + " " + (a.scope || "")).toLowerCase().includes(filtro);
  const vis = avisos.filter(coincide);
  $("avisosSub").textContent = avisos.length
    ? `${avisos.length} avisos publicados por Renfe, sobre todo de Cercanías: ascensores, obras y cambios de servicio. Se actualizan cada 5 minutos.`
    : "Renfe no publica ningún aviso ahora mismo.";
  const kinds = new Set(GRUPOS.map((g) => g[0]));
  const grupos = [...GRUPOS, ["otro", "Otros"]].map(([k, nom]) => [k, nom, vis.filter((a) => (kinds.has(a.kind) ? a.kind : "otro") === k)]).filter((g) => g[2].length);
  $("avisosBox").innerHTML = grupos.length ? grupos.map(([k, nom, xs]) => `<details class="grupo-avisos" data-k="${k}" ${filtro || abiertos.has(k) ? "open" : ""}>
      <summary>${nom} <span>${xs.length}</span></summary>
      <ul>${xs.map((a) => `<li>${a.scope && a.kind === "linea" ? `<small>${esc(a.scope)}</small>` : ""}${esc(a.text)}</li>`).join("")}</ul></details>`).join("")
    : filtro ? `<p class="nota">Ningún aviso contiene «${esc(filtro)}».</p>` : "";
}
