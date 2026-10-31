// "Descargar datos" (#/datos): pick a dataset, a time window, filters and a format → plain link to /api/export.
// The file is never fetched into the page: the button is a normal link and the server answers with an attachment.
import { $, esc, api, store, fmt, TYPE_NAME } from "./util.js";

// Shown if /api/export/info doesn't answer (same ids as the server contract).
const RESERVA = [
  { id: "recorridos", nombre: "Recorridos", descripcion: "Una fila por tren y día: origen, destino, horas, retraso en llegada y si se canceló." },
  { id: "lineas", nombre: "Líneas por día", descripcion: "Resumen diario de cada línea: trenes, puntualidad y retraso medio." },
  { id: "incidencias", nombre: "Incidencias", descripcion: "Incidencias de la red (avisos de Adif y detectadas en los datos de Renfe), con inicio, fin y tramo." },
  { id: "proximidad", nombre: "Anomalías de proximidad", descripcion: "Pares de trenes demasiado cerca según el GPS público (experimental)." },
  { id: "horas", nombre: "Resumen por horas", descripcion: "Trenes circulando, con retraso y retraso medio en cada hora." },
];
// Which filters make sense for each dataset (the server may also say so with `filtros`).
const FILTROS = { recorridos: ["red", "tipos"], lineas: ["red", "tipos"], horas: ["red", "tipos"] };
const PRESETS = [["hoy", "Hoy"], ["7d", "7 días"], ["30d", "30 días"], ["3m", "3 meses"], ["1a", "1 año"], ["anio", "Este año"], ["todo", "Todo"]];
const FORMATOS = { csv: ["CSV", "Recomendado: se abre en Excel, LibreOffice o Google Sheets."], json: ["JSON", "Para programar o analizar con código."] };

let INFO = null, infoError = false, BASE = null;
const S = Object.assign({ datos: "recorridos", preset: "30d", desde: "", hasta: "", formato: "csv", red: "", tipos: [] }, store.get("descarga", {}));

const hoyISO = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Madrid" });
const iso = (d) => d.toISOString().slice(0, 10);
const masDias = (s, n) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const masMeses = (s, n) => { const d = new Date(s + "T12:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); return iso(d); };
const dias = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5) + 1;
const fechaTxt = (s) => (s ? new Date(s + "T12:00:00Z").toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "–");

const dataset = () => (INFO?.datasets || RESERVA).find((d) => d.id === S.datos) || (INFO?.datasets || RESERVA)[0];
const filtrosDe = (d) => d.filtros || FILTROS[d.id] || [];
const clamp = (s, d) => { if (!s) return s; if (d.desde && s < d.desde) return d.desde; if (d.hasta && s > d.hasta) return d.hasta; return s; };

function rangoPreset(p, d) {
  const h = d.hasta && d.hasta < hoyISO() ? d.hasta : hoyISO();
  const r = { hoy: [h, h], "7d": [masDias(h, -6), h], "30d": [masDias(h, -29), h], "3m": [masDias(masMeses(h, -3), 1), h], "1a": [masDias(masMeses(h, -12), 1), h], anio: [h.slice(0, 4) + "-01-01", h], todo: [d.desde || "", d.hasta || ""] }[p];
  return r ? [clamp(r[0], d), clamp(r[1], d)] : [S.desde, S.hasta];
}

export async function showDatos(base) {
  BASE = base || BASE;
  if (!INFO) {
    $("v-datos").innerHTML = `<div class="cab-pagina"><h1>Descargar datos</h1><p class="sub">Cargando los conjuntos de datos…</p></div>`;
    try { INFO = await api("/api/export/info"); infoError = false; if (!INFO?.datasets?.length) throw new Error("sin datos"); }
    catch { INFO = null; infoError = true; }
  }
  if (S.preset !== "custom") [S.desde, S.hasta] = rangoPreset(S.preset, dataset());
  render(); // if the info failed, INFO stays null and the next visit asks again
}

function url() {
  const d = dataset(), f = filtrosDe(d);
  const q = new URLSearchParams({ datos: d.id });
  if (S.desde) q.set("desde", S.desde);
  if (S.hasta) q.set("hasta", S.hasta);
  q.set("formato", S.formato);
  if (f.includes("red") && S.red) q.set("red", S.red);
  if (f.includes("tipos") && S.red !== "cer" && S.tipos.length) q.set("tipos", S.tipos.join(","));
  return "/api/export?" + q;
}

function render() {
  const sets = INFO?.datasets || RESERVA, d = dataset(), f = filtrosDe(d);
  const formatos = (INFO?.formatos || ["csv", "json"]).filter((x) => FORMATOS[x]);
  if (!formatos.includes(S.formato)) S.formato = formatos[0] || "csv";
  const tipos = (BASE?.types || Object.keys(TYPE_NAME).map((id) => ({ id, name: TYPE_NAME[id] }))).filter((t) => !t.noData && t.id !== "cer");
  const n = S.desde && S.hasta ? dias(S.desde, S.hasta) : null;
  const total = d.desde && d.hasta ? dias(d.desde, d.hasta) : null;
  const filas = d.filasAprox != null && total ? Math.max(0, Math.round(d.filasAprox * Math.min(1, (n ?? total) / total))) : null;
  const errorFechas = S.desde && S.hasta && S.desde > S.hasta;
  const v = $("v-datos");
  v.innerHTML = `
    <div class="cab-pagina"><h1>Descargar datos</h1>
      <p class="sub">El histórico que guarda Trenestado, para que lo uses como quieras: retrasos de cada tren, puntualidad por línea, incidencias y más.</p></div>
    ${infoError ? `<div class="aviso-datos" role="status">El servicio de descargas no responde ahora mismo; puedes preparar la descarga, pero el enlace puede fallar hasta que vuelva.</div>` : ""}
    <div class="datos-grid">
      <section class="datos-paso" aria-labelledby="dP1">
        <h2 id="dP1"><span class="paso">1</span>Qué datos</h2>
        <div class="datasets" role="radiogroup" aria-labelledby="dP1">
          ${sets.map((x) => `<label class="dataset${x.id === d.id ? " on" : ""}">
            <input type="radio" name="dataset" value="${esc(x.id)}" ${x.id === d.id ? "checked" : ""}>
            <span class="ds-cab"><b>${esc(x.nombre || x.id)}</b>${x.filasAprox != null ? `<small>≈ ${fmt(x.filasAprox)} filas</small>` : ""}</span>
            <span class="ds-desc">${esc(x.descripcion || "")}</span>
            ${x.desde || x.hasta ? `<span class="ds-rango">Desde el ${fechaTxt(x.desde)} hasta el ${fechaTxt(x.hasta)}</span>` : ""}
            ${x.columnas?.length ? `<span class="ds-cols" title="Columnas">${x.columnas.map((c) => `<code>${esc(c)}</code>`).join("")}</span>` : ""}
          </label>`).join("")}
        </div>
      </section>
      <div class="datos-lado">
        <section class="datos-paso card" aria-labelledby="dP2">
          <h2 id="dP2"><span class="paso">2</span>Periodo</h2>
          <div class="filtros seg presets" role="group" aria-labelledby="dP2">
            ${PRESETS.map(([k, t]) => `<button type="button" data-p="${k}" class="${S.preset === k ? "on" : ""}" aria-pressed="${S.preset === k}">${t}</button>`).join("")}
          </div>
          <div class="fechas">
            <label>Desde<input type="date" id="dDesde" value="${esc(S.desde)}" ${d.desde ? `min="${d.desde}"` : ""} ${d.hasta ? `max="${d.hasta}"` : ""}></label>
            <label>Hasta<input type="date" id="dHasta" value="${esc(S.hasta)}" ${d.desde ? `min="${d.desde}"` : ""} ${d.hasta ? `max="${d.hasta}"` : ""}></label>
          </div>
          ${errorFechas ? `<p class="err">La fecha de inicio es posterior a la de fin.</p>` : `<p class="nota">${n ? `${n} ${n === 1 ? "día" : "días"}` : "Todo lo disponible"}${filas != null ? ` · ≈ ${fmt(filas)} filas` : ""}${d.desde ? ` · hay datos desde el ${fechaTxt(d.desde)}` : ""}</p>${INFO?.modo === "mensual" ? `<p class="nota">Se descargan meses completos (del primer mes al último del periodo), con datos hasta ayer.</p>` : ""}`}
        </section>
        ${f.length ? `<section class="datos-paso card" aria-labelledby="dP3">
          <h2 id="dP3"><span class="paso">3</span>Filtros</h2>
          ${f.includes("red") ? `<div class="grupo-d"><span id="lRed">Red</span><div class="filtros seg" id="dRed" role="group" aria-labelledby="lRed">
            ${[["", "Todas"], ["ld", "Larga y media distancia"], ["cer", "Cercanías"]].map(([k, t]) => `<button type="button" data-r="${k}" class="${S.red === k ? "on" : ""}" aria-pressed="${S.red === k}">${t}</button>`).join("")}</div></div>` : ""}
          ${f.includes("tipos") ? `<div class="grupo-d"><span id="lTiposD">Tipo de tren${S.red === "cer" ? " <small>(no aplica a Cercanías)</small>" : ""}</span><div class="filtros" id="dTipos" role="group" aria-labelledby="lTiposD">
            <button type="button" data-t="" class="${!S.tipos.length ? "on" : ""}" aria-pressed="${!S.tipos.length}" ${S.red === "cer" ? "disabled" : ""}>Todos</button>
            ${tipos.map((t) => `<button type="button" data-t="${t.id}" class="${S.tipos.includes(t.id) ? "on" : ""}" aria-pressed="${S.tipos.includes(t.id)}" ${S.red === "cer" ? "disabled" : ""}>${esc(t.name)}</button>`).join("")}</div></div>` : ""}
        </section>` : ""}
        <section class="datos-paso card" aria-labelledby="dP4">
          <h2 id="dP4"><span class="paso">${f.length ? 4 : 3}</span>Formato</h2>
          <div class="formatos" role="radiogroup" aria-labelledby="dP4">
            ${formatos.map((k) => `<label class="formato${S.formato === k ? " on" : ""}"><input type="radio" name="formato" value="${k}" ${S.formato === k ? "checked" : ""}><b>${FORMATOS[k][0]}</b><small>${FORMATOS[k][1]}</small></label>`).join("")}
          </div>
          <a class="btn prim descargar${errorFechas ? " off" : ""}" id="dBajar" href="${errorFechas ? "#/datos" : esc(url())}" ${errorFechas ? 'aria-disabled="true"' : "download"}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11 M7.5 10.5L12 15l4.5-4.5 M4 17v3h16v-3"/></svg>Descargar ${esc(d.nombre || d.id)} (${(FORMATOS[S.formato] || [S.formato])[0]})</a>
          <p class="nota enlace">Enlace directo, para scripts: <code id="dUrl">${esc(location.origin + url())}</code></p>
        </section>
      </div>
    </div>
    <p class="nota licencia">Datos abiertos de Renfe y Adif, recopilados y procesados por Trenestado. Puedes reutilizarlos citando «Trenestado, con datos de Renfe y Adif».</p>`;

  v.querySelectorAll('input[name="dataset"]').forEach((r) => (r.onchange = () => { S.datos = r.value; cambio(); }));
  v.querySelectorAll('input[name="formato"]').forEach((r) => (r.onchange = () => { S.formato = r.value; cambio(); }));
  v.querySelector(".presets").onclick = (e) => { const b = e.target.closest("[data-p]"); if (!b) return; S.preset = b.dataset.p; cambio(); };
  const fecha = () => { S.preset = "custom"; S.desde = $("dDesde").value; S.hasta = $("dHasta").value; cambio(true); };
  $("dDesde").onchange = fecha; $("dHasta").onchange = fecha;
  $("dRed") && ($("dRed").onclick = (e) => { const b = e.target.closest("[data-r]"); if (!b) return; S.red = b.dataset.r; cambio(); });
  $("dTipos") && ($("dTipos").onclick = (e) => {
    const b = e.target.closest("[data-t]"); if (!b) return;
    const t = b.dataset.t;
    S.tipos = !t ? [] : S.tipos.includes(t) ? S.tipos.filter((x) => x !== t) : [...S.tipos, t];
    cambio();
  });
  $("dBajar").onclick = (e) => { if (errorFechas) e.preventDefault(); };
}

// re-render keeping keyboard focus on the control that changed
function cambio(fechaManual = false) {
  const a = document.activeElement, sel = a?.id ? "#" + a.id : a?.dataset?.p ? `[data-p="${a.dataset.p}"]` : a?.dataset?.r != null ? `[data-r="${a.dataset.r}"]` : a?.dataset?.t != null ? `#dTipos [data-t="${a.dataset.t}"]` : a?.name ? `input[name="${a.name}"][value="${a.value}"]` : null;
  if (!fechaManual && S.preset !== "custom") [S.desde, S.hasta] = rangoPreset(S.preset, dataset());
  store.set("descarga", { datos: S.datos, preset: S.preset, formato: S.formato, red: S.red, tipos: S.tipos, ...(S.preset === "custom" ? { desde: S.desde, hasta: S.hasta } : {}) });
  render();
  if (sel) $("v-datos").querySelector(sel)?.focus({ preventScroll: true });
}
