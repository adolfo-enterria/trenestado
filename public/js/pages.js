// "Mis trenes" (tracked trains + global alarms) and "Fuentes" (data sources & status).
import { $, esc, api, horaLocal, fechaHora, retBadge, askNotificationPermission, notify } from "./util.js";
import { getTracked, untrack, getGlobal, setGlobal } from "./alarms.js";

export function showMisTrenes(D, base) {
  const list = getTracked();
  const g = getGlobal();
  const perm = "Notification" in window ? Notification.permission : "unsupported";
  const permTxt = { granted: "Activadas", denied: "Bloqueadas en el navegador (verás avisos en la página y un pitido)", default: "Sin permiso todavía", unsupported: "Este navegador no las admite" }[perm];
  const regionOpts = `<option value="">toda España</option>` + (base?.regions || []).map((r) => `<option ${g.majorRegion === r.name ? "selected" : ""}>${esc(r.name)}</option>`).join("");
  $("v-mis-trenes").innerHTML = `
    <div class="cab-pagina"><h1>Mis trenes</h1><p class="sub">Los trenes que sigues y tus alarmas se guardan solo en este navegador. Los avisos llegan mientras Trenestado esté abierto en alguna pestaña.</p></div>
    <div class="card bloque-g">
      <h2>Avisos generales</h2>
      <div class="alarma-form">
        <label><input type="checkbox" id="gMajor" ${g.major ? "checked" : ""}> Avisarme de incidencias graves en <select id="gRegion" aria-label="Región de las incidencias graves">${regionOpts}</select></label>
        <label><input type="checkbox" id="gProx" ${g.prox ? "checked" : ""}> Avisarme de anomalías de proximidad entre trenes <span class="exp">experimental</span></label>
      </div>
      <div class="aviso-exp"><b>Sobre la proximidad:</b> compara posiciones GPS públicas de Renfe, con error y hasta un minuto de retraso, sin saber por qué vía va cada tren. No es un sistema de seguridad: la separación real entre trenes la garantiza la señalización. Tampoco ve trenes de Iryo ni Ouigo.</div>
      <p class="nota">Notificaciones del navegador: <b>${permTxt}</b> ${perm === "default" ? '<button class="btn" id="pedirPermiso">Permitir</button>' : ""} <button class="btn" id="probar">Probar aviso</button></p>
    </div>
    ${list.length ? `<div class="mis">${list.map((t) => {
      const live = D?.trenes.find((x) => x.id === t.n);
      return `<div class="card">
        <h3><a href="#/tren/${t.n}">${esc(t.nom)} ${t.n.replace(/^c/, "")}</a>${live ? retBadge(live.ret) : `<span class="sub" style="font-size:13px;font-stretch:100%;font-weight:450">sin posición ahora</span>`}</h3>
        <p class="sub">${esc(t.ruta || "")}</p>
        <p class="nota">${describe(t.triggers)}</p>
        <ul class="log" style="margin-top:8px">${t.log.slice(0, 8).map((l) => `<li><time>${horaLocal(l.at)}</time>${esc(l.txt)}</li>`).join("")}</ul>
        <div class="fila-btn"><a class="btn" href="#/tren/${t.n}?alarma=1">Editar alarma</a><button class="btn" data-quitar="${t.n}">Quitar alarma</button></div>
      </div>`;
    }).join("")}</div>` : `<div class="card"><p class="sub">Aún no sigues ningún tren. Busca uno con el buscador (por ejemplo <a href="#/tren/03303">AVE 03303</a>) y pulsa «Crear alarma».</p></div>`}`;

  $("gMajor").onchange = async () => { if ($("gMajor").checked) await askNotificationPermission(); setGlobal({ major: $("gMajor").checked, majorRegion: $("gRegion").value }, D); };
  $("gRegion").onchange = () => setGlobal({ majorRegion: $("gRegion").value });
  $("gProx").onchange = async () => { if ($("gProx").checked) await askNotificationPermission(); setGlobal({ prox: $("gProx").checked }); };
  $("probar").onclick = () => notify("Aviso de prueba", "Así te llegarán las alarmas de Trenestado.", { level: "ok" });
  const p = $("pedirPermiso"); if (p) p.onclick = async () => { await askNotificationPermission(); showMisTrenes(D, base); };
  $("v-mis-trenes").querySelectorAll("[data-quitar]").forEach((b) => (b.onclick = () => { untrack(b.dataset.quitar); showMisTrenes(D, base); }));
}

function describe(tr) {
  const p = [];
  if (tr.delayMin != null) p.push(`retraso ≥ ${tr.delayMin} min (cambios de ${tr.delayStep} min)`);
  if (tr.cancel) p.push("cancelación");
  if (tr.depart) p.push("salida");
  if (tr.beforeArrMin) p.push(`${tr.beforeArrMin} min antes de llegar`);
  if (tr.arrive) p.push("llegada");
  if (tr.stopped) p.push("parado fuera de estación");
  if (tr.incident) p.push("incidencias en su recorrido");
  if (tr.prox) p.push("proximidad (exp.)");
  return "Avisa de: " + (p.join(", ") || "nada");
}

const FUENTES = [
  { k: "renfe", nom: "Renfe · posiciones en tiempo real (larga y media distancia)", url: "https://tiempo-real.renfe.com/renfe-visor/flotaLD.json", txt: "Posición GPS, retraso, estación anterior y siguiente, origen y destino de cada tren. Se consulta cada minuto. No es una API documentada: la usa el mapa de Renfe y puede cambiar sin aviso." },
  { k: "cercanias", nom: "Renfe · posiciones en tiempo real (Cercanías y Rodalies)", url: "https://tiempo-real.renfe.com/renfe-visor/flota.json", txt: "Posición, línea, retraso, estación actual y siguiente y vía de cada tren de Cercanías. Sin hora de la posición: se usa la de la consulta. Mismo origen no documentado que el anterior." },
  { k: "gtfsRt", nom: "Renfe · GTFS-RT (datos abiertos oficiales)", url: "https://gtfsrt.renfe.com/trip_updates_LD.json", txt: "Retrasos por viaje y trenes cancelados o añadidos. Cada minuto." },
  { k: "gtfs", nom: "Renfe · GTFS horarios (datos abiertos oficiales)", url: "https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip", txt: "Estaciones, horarios e itinerarios completos de cada tren. Una vez al día." },
  { k: "adif", nom: "Adif · Estado de la red", url: "https://www.adif.es/viajeros/estado-de-la-red", txt: "Avisos de incidencias escritos por Adif. Es una página web, no una API, y a menudo bloquea las consultas desde servidores. Se intenta una vez por minuto, sin saltarse ese bloqueo." },
  { k: "renfeAlerts", nom: "Renfe · avisos de estaciones y líneas", url: "https://tiempo-real.renfe.com/renfe-visor/alerts.json", txt: "Avisos de servicio (ascensores, obras, cambios), sobre todo de Cercanías. Cada 5 minutos." },
];

export async function showFuentes() {
  let d = null;
  try { d = await api("/api/fuentes"); } catch {}
  const s = d?.fuentes || {};
  $("v-fuentes").innerHTML = `
    <div class="cab-pagina"><h1>Fuentes de datos</h1><p class="sub">Todo lo que ves sale de datos públicos de Renfe y Adif. Trenestado no está vinculado a ninguna de las dos.</p></div>
    <div class="card fuentes">${FUENTES.map((f) => {
      const x = s[f.k] || {};
      return `<div class="fuente-row"><span class="dot ${x.ok ? "ok" : ""}" role="img" aria-label="${x.ok ? "Funciona" : "Con fallos"}"></span>
        <div><b>${f.nom}</b><p>${f.txt}</p><code>${esc(f.url)}</code>${!x.ok && x.error ? `<p class="err">Último error: ${esc(x.error)}</p>` : ""}</div>
        <div class="t">${x.ok ? "OK · " + horaLocal(x.at) : x.triedAt ? "Fallo · " + horaLocal(x.triedAt) : "–"}${x.count != null ? `<br>${x.count} ${f.k === "cercanias" ? "trenes" : "avisos"}` : ""}${x.cancelled != null ? `<br>${x.cancelled} cancelaciones` : ""}</div></div>`;
    }).join("")}</div>
    <div class="card" style="margin-top:14px">
      <h2>Lo que no se puede saber</h2>
      <ul class="lista-txt">
        <li><b>Iryo y Ouigo</b> no publican la posición ni los retrasos de sus trenes.</li>
        <li>El recorrido de <b>Cercanías</b> sale de su horario; si un viaje no aparece en él, solo vemos su posición, retraso y siguiente estación. Las cancelaciones solo se conocen para larga y media distancia.</li>
        <li>Los <b>paneles de salidas</b> de larga y media distancia salen del horario + retrasos en directo (Renfe no publica la vía); los de Cercanías, del panel oficial de Renfe.</li>
        <li>El <b>estado real de las vías</b> (qué tramos están abiertos) no se publica de forma estructurada: la «disponibilidad del servicio» se calcula con los trenes cancelados.</li>
        <li>La <b>velocidad</b> se estima a partir de dos posiciones GPS consecutivas; puede fallar con cobertura mala.</li>
      </ul>
      <p class="nota">Mapa base: <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © OpenMapTiles, datos de © OpenStreetMap contributors. Si no carga, se usa un mapa propio (es-atlas, Natural Earth). El histórico se puede <a href="#/datos">descargar</a>.</p>
      <p class="nota">Horarios cargados: ${d?.gtfs?.cargado ? fechaHora(d.gtfs.cargado) : "–"} · ${d?.gtfs?.estaciones ?? "–"} estaciones · ${d?.gtfs?.viajes ?? "–"} viajes.</p>
    </div>`;
}
