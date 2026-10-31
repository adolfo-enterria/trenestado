// Station board (#/estacion/17000): departures/arrivals, LD/MD from the timetable + live delays, Cercanías from Renfe's board.
import { $, esc, api, retBadge } from "./util.js";

let current = null, kind = "salidas", timer = null, onMap = null;

const ESTADO = { salido: "Ha salido", llegado: "Ha llegado", cancelado: "Cancelado", circulando: "En camino", programado: "" };

export function showStation(code, { tipo, verEnMapa }) {
  current = code;
  kind = tipo === "llegadas" ? "llegadas" : "salidas";
  onMap = verEnMapa;
  clearInterval(timer);
  $("v-estacion").innerHTML = `<p class="sub">Cargando panel…</p>`;
  load();
  timer = setInterval(() => { if (!$("v-estacion").hidden) load(); }, 30_000);
}
export function hideStation() { clearInterval(timer); current = null; }

async function load() {
  const code = current;
  let d;
  try { d = await api(`/api/estacion/${encodeURIComponent(code)}?tipo=${kind}`); }
  catch (e) { $("v-estacion").innerHTML = `<p class="sub">No se pudo cargar la estación: ${esc(e.message)}</p>`; return; }
  if (code !== current) return;
  render(d);
}

function render(d) {
  const salidas = d.tipo === "salidas";
  const cerNote = salidas
    ? { ok: "Cercanías: panel oficial de Renfe.", "sin-datos": "Esta estación no tiene panel de Cercanías.", error: "El panel de Cercanías de Renfe no responde ahora." }[d.cercanias]
    : "Las llegadas solo incluyen larga y media distancia (Renfe no publica llegadas de Cercanías).";
  $("v-estacion").innerHTML = `
    <div class="tren-cab">
      <div><h1>${esc(d.nombre)}</h1><p class="sub">${esc(d.region || "")}</p></div>
      <div class="acciones-cab">
        <div class="filtros seg" role="group" aria-label="Panel">
          <button data-k="salidas" class="${salidas ? "on" : ""}" aria-pressed="${salidas}">Salidas</button>
          <button data-k="llegadas" class="${salidas ? "" : "on"}" aria-pressed="${!salidas}">Llegadas</button>
        </div>
        <button class="btn" id="estMapa">Ver en el mapa</button>
      </div>
    </div>
    <div class="card panel-est">
      ${d.filas.length ? `<div class="tabla-scroll"><table class="tabla tablero-est">
        <caption class="vh">${salidas ? "Salidas" : "Llegadas"} de ${esc(d.nombre)} en las próximas 3 horas</caption>
        <thead><tr><th scope="col">Hora</th><th scope="col">Tren</th><th scope="col">${salidas ? "Destino" : "Origen"}</th><th scope="col" class="n col-via">Vía</th><th scope="col">Estado</th></tr></thead>
        <tbody>${d.filas.map((f) => {
          const late = f.retraso != null && f.retraso >= 1;
          const estado = f.estado === "cancelado" ? `<span class="ret grave">Cancelado</span>`
            : late ? `${retBadge(f.retraso, "+" + f.retraso + " min")}${ESTADO[f.estado] ? ` ${ESTADO[f.estado]}` : ""}`
            : f.retraso != null && f.retraso <= 0 && f.estado !== "programado" ? `${retBadge(0)}${ESTADO[f.estado] ? ` ${ESTADO[f.estado]}` : ""}`
            : ESTADO[f.estado] || "";
          return `<tr class="${f.estado}">
            <td class="hora">${late ? `<del>${f.hora}</del><ins>${f.est}</ins>` : f.hora}</td>
            <td><a href="#/tren/${f.id}">${f.red === "cer" ? `<span class="linea">${esc(f.linea || "")}</span>` : esc(f.nom)} ${f.n}</a></td>
            <td>${esc(f.otro)}</td><td class="n col-via">${esc(f.via || "–")}</td><td>${estado}</td></tr>`;
        }).join("")}</tbody></table></div>`
      : `<p class="vacio-card">No hay ${salidas ? "salidas" : "llegadas"} en las próximas 3 horas.</p>`}
      <p class="nota">Próximas 3 horas. Larga y media distancia: horario de Renfe + retraso en directo${salidas ? "" : ""} (Renfe no publica la vía). ${cerNote}</p>
    </div>`;
  $("v-estacion").querySelector(".filtros").onclick = (e) => {
    const b = e.target.closest("[data-k]"); if (!b || b.dataset.k === kind) return;
    kind = b.dataset.k;
    history.replaceState(null, "", `#/estacion/${d.code}${kind === "llegadas" ? "?tipo=llegadas" : ""}`);
    load();
  };
  $("estMapa").onclick = () => onMap?.({ n: d.nombre, reg: d.region, lat: d.lat, lon: d.lon, code: d.code });
}
