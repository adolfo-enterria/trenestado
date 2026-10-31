// Train page (#/tren/03303): live status, itinerary with ETAs, mini map, history, alarm, share link.
import { $, esc, api, COL, nivel, durTxt, addMin, toast, askNotificationPermission, puntTexto, retBadge, NIVEL_INC } from "./util.js";
import { fondo } from "./basemap.js";
import { isTracked, track, untrack, getTracked, DEFAULT_TRIGGERS } from "./alarms.js";
import { onTema } from "./util.js";

let current = null, timer = null, mini = null, miniLayers = null, ultimo = null, miniDe = null;
onTema(() => { if (mini && ultimo && !$("v-tren").hidden) drawMini(ultimo); });

const STATUS = {
  circulando: "Circulando ahora",
  programado: "Programado para hoy, aún no ha salido",
  finalizado: "Ya ha terminado su recorrido de hoy",
  cancelado: "Cancelado hoy por Renfe",
  "sin-posicion": "Debería estar circulando, pero Renfe no publica su posición",
  "no-circula-hoy": "No circula hoy",
  desconocido: "No encontramos este número de tren",
};

export function showTrain(n, { openAlarm = false } = {}) {
  current = n;
  clearInterval(timer);
  $("v-tren").innerHTML = `<p class="sub">Cargando tren ${esc(n)}…</p>`;
  load(openAlarm);
  timer = setInterval(() => { if (!$("v-tren").hidden) load(false); }, 15_000);
}
export function hideTrain() { clearInterval(timer); current = null; if (mini) { mini.remove(); mini = null; miniDe = null; } }

async function load(openAlarm) {
  const n = current;
  let d;
  try { d = await api("/api/tren/" + encodeURIComponent(n)); } catch (e) { $("v-tren").innerHTML = `<p class="sub">No se pudo cargar el tren: ${esc(e.message)}</p>`; return; }
  if (n !== current) return;
  if (!openAlarm && $("alarmaForm") && !$("alarmaForm").hidden) return; // don't wipe the form while it's being edited
  render(d, openAlarm);
}

function render(d, openAlarm) {
  const L_ = d.live;
  const on = isTracked(d.id);
  const tr = getTracked().find((t) => t.n === d.id)?.triggers || DEFAULT_TRIGGERS;
  const h = d.historial;
  const hist = [...(h.dias_detalle || [])].reverse();
  const nextStop = d.stops.find((s) => s.estado === "siguiente");
  $("v-tren").innerHTML = `
    <div class="tren-cab">
      <div>
        <h1>${esc(d.nom)} ${esc(d.n)} <small>${esc(d.origen || "")}${d.destino ? " → " + esc(d.destino) : ""}</small></h1>
        <div class="chips-estado">
        <span class="estado-tren ${d.status}">${STATUS[d.status] || d.status}</span>
        ${d.status === "circulando" || d.status === "sin-posicion" ? retBadge(d.delay) : ""}
        ${h.recorridos ? `<span class="estado-tren punt ${h.tarde5 >= 30 ? "mal" : h.tarde5 >= 15 ? "regular" : "bien"}" title="Llegada con 5 min o más de retraso, últimos 30 días">Llega ${puntTexto(h)}</span>` : ""}
        </div>
      </div>
      <div class="acciones-cab">
        ${L_ ? `<a class="btn" href="#/?tren=${d.id}">Ver en el mapa</a>` : ""}
        <button class="btn" id="compartir">Copiar enlace para compartir</button>
        <button class="btn ${on ? "on" : "prim"}" id="alarmaBtn" aria-expanded="${openAlarm}" aria-controls="alarmaForm">${on ? "Alarma activa" : "Crear alarma"}</button>
      </div>
    </div>
    <div class="card bloque-g" id="alarmaForm" ${openAlarm ? "" : "hidden"}>
      <h2>Alarma para el ${esc(d.nom)} ${esc(d.n)}</h2>
      <p class="sub">Te avisamos con una notificación del navegador mientras Trenestado esté abierto en alguna pestaña (aunque esté en segundo plano).</p>
      <div class="alarma-form">
        <label><input type="checkbox" data-k="delayOn" ${tr.delayMin != null ? "checked" : ""}> Retraso de <input type="number" min="1" max="180" data-k="delayMin" value="${tr.delayMin ?? 15}"> min o más, y cada vez que cambie <input type="number" min="1" max="60" data-k="delayStep" value="${tr.delayStep ?? 5}"> min</label>
        <label><input type="checkbox" data-k="cancel" ${tr.cancel ? "checked" : ""}> Si se cancela</label>
        <label><input type="checkbox" data-k="depart" ${tr.depart ? "checked" : ""}> Cuando salga</label>
        <label><input type="checkbox" data-k="beforeOn" ${tr.beforeArrMin ? "checked" : ""}> <input type="number" min="1" max="120" data-k="beforeArrMin" value="${tr.beforeArrMin || 15}"> min antes de llegar</label>
        <label><input type="checkbox" data-k="arrive" ${tr.arrive ? "checked" : ""}> Cuando llegue a su destino</label>
        <label><input type="checkbox" data-k="stopped" ${tr.stopped ? "checked" : ""}> Si se queda parado fuera de una estación</label>
        <label><input type="checkbox" data-k="incident" ${tr.incident ? "checked" : ""}> Si hay una incidencia en su recorrido</label>
        <label><input type="checkbox" data-k="prox" ${tr.prox ? "checked" : ""}> Anomalías de proximidad con otro tren <span class="exp">experimental</span></label>
        <div class="fila-btn"><button class="btn prim" id="guardarAlarma">${on ? "Guardar cambios" : "Activar alarma"}</button>${on ? '<button class="btn" id="quitarAlarma">Quitar alarma</button>' : ""}</div>
      </div>
    </div>
    ${d.incidencias?.length ? d.incidencias.map((i) => `<div class="card inc-tren ${i.level}"><span class="nv">${NIVEL_INC[i.level] || ""}</span><b>${esc(i.title)}</b><p class="sub">${esc((i.text || []).join(" "))}</p><p class="nota"><a href="#/incidencias?id=${encodeURIComponent(i.id)}">Ver en Incidencias</a></p></div>`).join("") : ""}
    ${d.proximidad?.length ? `<div class="aviso-exp"><b>Anomalía de proximidad (experimental):</b> ${d.proximidad.map((p) => `a ${(p.distM / 1000).toFixed(1)} km del tren ${p.follower === d.n ? p.leader : p.follower}`).join(", ")}. Calculado con GPS impreciso y con retraso; no es un sistema de seguridad.</div>` : ""}
    <div class="tren-grid">
      <div>
        <div class="datos">
          <div><span>Retraso</span>${retBadge(d.delay)}</div>
          <div><span>Velocidad</span><b>${L_ ? (L_.kmh == null ? "…" : L_.kmh < 4 ? "Parado" : "≈ " + L_.kmh + " km/h") : "–"}</b></div>
          <div><span>Llegada prevista</span><b>${d.stops.at(-1)?.arr || L_?.lleg || "–"}</b></div>
          <div><span>Llegada estimada</span><b>${d.stops.at(-1)?.est || (L_?.lleg ? addMin(L_.lleg, Math.max(0, d.delay)) : "–")}</b></div>
          <div><span>Dónde</span><b class="txt">${L_ ? esc(L_.ant === L_.sig ? "En " + L_.antN : L_.antN + " → " + L_.sigN) : "–"}</b></div>
          <div><span>Próxima parada</span><b class="txt">${nextStop ? esc(nextStop.n) + " " + (L_?.hs || nextStop.est || "") : "–"}</b></div>
          ${L_?.mat ? `<div><span>Material</span><b>${esc(L_.mat)}</b></div>` : ""}
          ${L_ ? `<div><span>Accesible</span><b>${L_.acc ? "Sí" : "No"}</b></div>` : ""}
        </div>
        <div class="mini-mapa" id="miniMapa"></div>
        <div class="card" style="margin-top:14px">
          <h2>Últimos 30 días</h2>
          ${hist.length ? `<p class="sub">${h.recorridos ? `${h.recorridos} ${h.recorridos === 1 ? "día completado" : "días completados"} · llega tarde (≥ 5 min) el ${h.tarde5} % · ≥ 15 min el ${h.tarde15} % · retraso medio ${h.retrasoMedio ?? "–"} min${h.cancelados ? ` · ${h.cancelados} cancelado${h.cancelados > 1 ? "s" : ""}` : ""}` : "Hoy en curso; el porcentaje aparece cuando termine el primer recorrido."}</p>
            <div class="historial" role="img" aria-label="Retraso de cada día, del más antiguo al más reciente">${hist.map((x) => x.cancelled ? `<i class="cancel" style="height:100%" title="${x.service_date}: cancelado"></i>` : `<i class="${nivel(x.delay ?? 0)}" style="height:${Math.min(100, 8 + Math.max(0, x.delay ?? 0) * 2)}%" title="${x.service_date}: ${durTxt(x.delay)}"></i>`).join("")}</div>`
            : `<p class="sub">Aún no hay historial: Trenestado guarda cada recorrido a partir de que empieza a recoger datos.</p>`}
        </div>
      </div>
      <div class="card">
        <h2>Recorrido de hoy${d.red === "cer" && (L_?.line || d.linea) ? ` <span class="linea-chip">${esc(L_?.line || d.linea)}</span>` : ""}</h2>
        ${d.stops.length ? `<ul class="itinerario">${d.stops.map((s, i) => {
          const prog = i === 0 ? s.dep : s.arr;
          const late = d.delay >= 1 && s.estado !== "pasado" && prog && s.est !== prog;
          return `<li class="${s.estado}"><span class="pt"></span><span title="${esc(s.full || "")}">${esc(s.n)}</span>
            <span class="h ${late ? "tarde" : ""}">${late ? `<del>${prog}</del>${s.est}` : prog || "–"}</span><span></span></li>`;
        }).join("")}</ul><p class="nota">Horas estimadas = horario + retraso actual. Horario: GTFS de Renfe.</p>`
          : d.red === "cer" ? `<p class="sub">${L_ ? `Línea <b>${esc(L_.line)}</b> de ${esc(L_.nucleoName)}. Ahora ${L_.ant === L_.sig ? "en " + esc(L_.antN) : "entre " + esc(L_.antN) + " y " + esc(L_.sigN)}${L_.hs ? `, llega a ${esc(L_.sigN)} a las ${L_.hs}` : ""}${L_.via ? ` (vía ${esc(L_.via)})` : ""}.` : "Este tren de Cercanías no circula ahora."}</p>
            <p class="nota">Este viaje no aparece en el horario de Cercanías de hoy, así que no podemos mostrar sus paradas.</p>`
          : `<p class="sub">No hay horario de hoy para este tren en el GTFS de Renfe.</p>`}
      </div>
    </div>`;

  $("compartir").onclick = async () => {
    const url = location.origin + "/#/tren/" + d.id;
    try { await navigator.clipboard.writeText(url); toast("Enlace copiado", url, "ok"); } catch { prompt("Copia este enlace:", url); }
  };
  $("alarmaBtn").onclick = () => { $("alarmaForm").hidden = !$("alarmaForm").hidden; };
  $("guardarAlarma").onclick = async () => {
    const v = (k) => $("alarmaForm").querySelector(`[data-k="${k}"]`);
    const triggers = {
      delayMin: v("delayOn").checked ? Number(v("delayMin").value) || 15 : null, delayStep: Number(v("delayStep").value) || 5,
      cancel: v("cancel").checked, depart: v("depart").checked, arrive: v("arrive").checked,
      beforeArrMin: v("beforeOn").checked ? Number(v("beforeArrMin").value) || 15 : 0,
      stopped: v("stopped").checked, incident: v("incident").checked, prox: v("prox").checked,
    };
    const perm = await askNotificationPermission();
    track(d.id, { nom: d.nom, ruta: d.origen ? `${d.origen} → ${d.destino}` : "", linea: d.linea }, triggers);
    toast("Alarma activada", perm === "granted" ? `Te avisaremos de los cambios del ${d.nom} ${d.n}.` : "Las notificaciones del navegador están bloqueadas: verás los avisos dentro de la página y oirás un pitido.", "ok");
    $("alarmaForm").hidden = true;
    render(d, false);
  };
  const q = $("quitarAlarma");
  if (q) q.onclick = () => { untrack(d.id); toast("Alarma quitada", `${d.nom} ${d.n}`, "info"); render(d, false); };

  drawMini(d);
}

// The mini map is kept across the 15 s refreshes (its DOM node is moved into the re-rendered page), so the
// WebGL basemap isn't rebuilt every time and the user's zoom/pan survives. A new train gets a new map.
function drawMini(d) {
  ultimo = d;
  const el = $("miniMapa");
  if (mini && miniDe === d.id) {
    const box = mini.getContainer();
    if (box !== el) { el.replaceWith(box); mini.invalidateSize(); }
    miniLayers.clearLayers();
    pintarMini(d, false);
    return;
  }
  if (mini) { mini.remove(); mini = null; }
  miniDe = d.id;
  mini = L.map(el, { zoomControl: true, attributionControl: true, scrollWheelZoom: false, preferCanvas: true, maxZoom: 15 });
  mini.attributionControl.setPrefix(false);
  fondo(mini);
  miniLayers = L.layerGroup().addTo(mini);
  pintarMini(d, true);
}

function pintarMini(d, encuadrar) {
  const pts = d.stops.filter((s) => s.lat).map((s) => [s.lat, s.lon]);
  if (pts.length) {
    // real track geometry from the server when available, otherwise straight lines between stops
    const linea = d.ruta?.length >= 2 ? d.ruta : pts;
    L.polyline(linea, { color: COL.texto2, weight: 3.5, opacity: 0.85, interactive: false }).addTo(miniLayers);
    d.stops.filter((s) => s.lat).forEach((s) => L.circleMarker([s.lat, s.lon], { radius: s.estado === "siguiente" ? 5.5 : 4, color: s.estado === "siguiente" ? COL.acento : COL.halo, weight: s.estado === "siguiente" ? 2.5 : 1.2, fillColor: s.estado === "pasado" ? COL.texto2 : COL.panel, fillOpacity: 1 }).bindTooltip(`${s.n} ${s.est || s.arr || ""}`).addTo(miniLayers));
  }
  if (d.live) {
    const g = nivel(d.delay) === "grave";
    L.circleMarker([d.live.lat, d.live.lon], { radius: g ? 9 : 8, color: g ? COL.texto : COL.halo, weight: 2, fillColor: COL[nivel(d.delay)], fillOpacity: 1 }).bindTooltip(`${d.n} ${durTxt(d.delay)}`, { permanent: true, direction: "right" }).addTo(miniLayers);
  }
  if (!encuadrar) return;
  const todo = d.ruta?.length >= 2 ? [...pts, ...d.ruta] : pts;
  if (d.live && !todo.length) mini.setView([d.live.lat, d.live.lon], 9);
  else if (todo.length) mini.fitBounds(L.latLngBounds(d.live ? [...todo, [d.live.lat, d.live.lon]] : todo), { padding: [20, 20] });
  else mini.setView([40.2, -3.7], 5);
}
