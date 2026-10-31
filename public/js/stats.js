// Estadísticas tab: filters → /api/stats → KPIs, charts, rankings.
import { $, esc, api, store, fmt, fechaHora, TYPE_NAME } from "./util.js";

const WIN_LABEL = { now: "Ahora", "1D": "1D", "7D": "7D", "1M": "1M", "3M": "3M", "6M": "6M", "1A": "1A", YTD: "YTD" };
let BASE = null, f = store.get("statsFiltros", { w: "1D", tipos: [], region: "" });
const charts = {};
let inited = false, timer = null;

Chart.defaults.color = "#94A6B6";
Chart.defaults.borderColor = "#2A3946";
Chart.defaults.font.family = "system-ui, -apple-system, Segoe UI, sans-serif";

export async function showStats(base) {
  BASE = base;
  if (!inited) init();
  await load();
  clearInterval(timer);
  timer = setInterval(() => { if (!$("v-stats").hidden) load(); }, f.w === "now" ? 15_000 : 120_000);
}

function init() {
  inited = true;
  $("fVentana").innerHTML = BASE.windows.map((w) => `<button data-w="${w}">${WIN_LABEL[w] || w}</button>`).join("");
  $("fTipos").innerHTML = `<button data-t="">Todos</button>` + BASE.types.filter((t) => !t.noData).map((t) => `<button data-t="${t.id}">${t.name}</button>`).join("");
  $("fRegion").innerHTML = `<option value="">Toda España</option>` + BASE.regions.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
  $("fVentana").onclick = (e) => { const b = e.target.closest("[data-w]"); if (!b) return; f.w = b.dataset.w; changed(); };
  $("fTipos").onclick = (e) => {
    const b = e.target.closest("[data-t]"); if (!b) return;
    const t = b.dataset.t;
    if (!t) f.tipos = [];
    else f.tipos = f.tipos.includes(t) ? f.tipos.filter((x) => x !== t) : [...f.tipos, t];
    changed();
  };
  $("fRegion").onchange = () => { f.region = $("fRegion").value; changed(); };
}
function changed() { store.set("statsFiltros", f); showStats(BASE); }

function pintarFiltros() {
  for (const b of $("fVentana").children) b.classList.toggle("on", b.dataset.w === f.w);
  for (const b of $("fTipos").children) b.classList.toggle("on", b.dataset.t ? f.tipos.includes(b.dataset.t) : !f.tipos.length);
  $("fRegion").value = f.region;
}

async function load() {
  pintarFiltros();
  const qs = new URLSearchParams({ w: f.w, tipos: f.tipos.join(","), region: f.region });
  let s;
  try { s = await api("/api/stats?" + qs); } catch (e) { $("kpis").innerHTML = `<p class="sub">No se pudieron cargar las estadísticas: ${esc(e.message)}</p>`; return; }
  render(s);
}

const kpi = (label, value, cls = "", small = "") => `<div class="kpi ${cls}"><span>${label}</span><b>${value}</b>${small ? `<small>${small}</small>` : ""}</div>`;
const clsPct = (p) => (p == null ? "" : p >= 30 ? "grave" : p >= 15 ? "leve" : "ok");

function render(s) {
  const k = s.kpis, live = s.window === "now";
  $("cobertura").innerHTML = live ? "Trenes en circulación en este momento (datos de Renfe cada 15 s)."
    : s.coverage.since ? `Datos recogidos desde el ${fechaHora(s.coverage.since)} · ${s.coverage.days < 1 ? Math.round(s.coverage.days * 24) + " h" : s.coverage.days + " días"} de datos en este periodo. Los periodos largos se irán llenando mientras el recolector siga funcionando.`
      : "Todavía no hay datos guardados.";
  $("kpis").innerHTML = live ? [
    kpi("Trenes circulando", fmt(k.trains)),
    kpi("Retraso medio", fmt(k.avgDelay, " min"), "", `mediana ${fmt(k.medianDelay, " min")}`),
    kpi("Con retraso ≥ 5 min", fmt(k.pctLate5, "%"), clsPct(k.pctLate5)),
    kpi("Con retraso ≥ 15 min", fmt(k.pctLate15, "%"), clsPct(k.pctLate15 * 2)),
    kpi("Cancelados hoy", fmt(k.cancelled), k.cancelled ? "grave" : ""),
    kpi("Incidencias activas", fmt(k.incidents), k.incidents ? "leve" : ""),
    kpi("Velocidad media", fmt(k.avgKmh, " km/h"), "", `máx. ${fmt(k.maxKmh, " km/h")}`),
    kpi("Anomalías de proximidad", fmt(k.proximity), k.proximity ? "leve" : "", "experimental"),
  ].join("") : [
    k.perDay != null ? kpi("Trenes por día", fmt(k.perDay), "", k.scheduledPerDay ? `programados: ${fmt(k.scheduledPerDay)}/día` : "")
      : kpi("Trenes vistos", fmt(k.runs), "", `aún no hay un día completo de datos${k.scheduledPerDay ? ` · programados: ${fmt(k.scheduledPerDay)}/día` : ""}`),
    kpi("Retraso medio", fmt(k.avgDelay, " min"), "", `mediana ${fmt(k.medianDelay, " min")}`),
    kpi("Llegan con ≥ 5 min", fmt(k.pctLate5, "%"), clsPct(k.pctLate5)),
    kpi("Llegan con ≥ 15 min", fmt(k.pctLate15, "%"), clsPct(k.pctLate15 * 2)),
    kpi("Cancelados", fmt(k.cancelled), k.cancelled ? "grave" : ""),
    kpi("Disponibilidad del servicio", fmt(k.availability, "%"), k.availability != null && k.availability < 97 ? "leve" : "ok", "1 − cancelados / programados"),
    kpi("Incidencias", fmt(k.incidents), k.incidents ? "leve" : "", Object.entries(k.incidentsByLevel || {}).map(([l, n]) => `${n} ${l}`).join(" · ")),
    kpi("Velocidad máxima", fmt(k.maxKmh, " km/h")),
    kpi("Anomalías de proximidad", fmt(k.proximity), "", "experimental"),
  ].join("");

  $("graficos").innerHTML = `
    <div class="card"><h2>${live ? "Retrasos ahora por tipo de tren" : s.series.step === "hour" ? "Evolución por hora" : "Evolución por día"}</h2><div class="chart-box"><canvas id="cSerie"></canvas></div><p class="vacio-card" id="cSerieVacio" hidden>Sin datos suficientes todavía.</p></div>
    <div class="card"><h2>Distribución de retrasos</h2><div class="chart-box"><canvas id="cDist"></canvas></div></div>
    <div class="card"><h2>Por tipo de tren</h2><div class="chart-box"><canvas id="cTipos"></canvas></div></div>
    <div class="card"><h2>Horas con más trenes</h2><div class="chart-box"><canvas id="cHoras"></canvas></div><p class="vacio-card" id="cHorasVacio" hidden>Se calcula a partir del historial (no en «Ahora»).</p></div>`;
  for (const k in charts) { charts[k].destroy(); delete charts[k]; }

  const pts = s.series?.points || [];
  if (live) charts.serie = barTypes("cSerie", s.byType, "avgDelay", "Retraso medio (min)");
  else if (pts.length > 1) {
    const lbl = (t) => new Date(t).toLocaleString("es-ES", s.series.step === "hour" ? { day: "numeric", hour: "2-digit", timeZone: "Europe/Madrid" } : { day: "numeric", month: "short", timeZone: "Europe/Madrid" });
    charts.serie = new Chart($("cSerie"), {
      type: "line",
      data: { labels: pts.map((p) => lbl(p.t)), datasets: [
        { label: "Retraso medio (min)", data: pts.map((p) => p.avgDelay), borderColor: "#F0B429", backgroundColor: "#F0B42933", yAxisID: "y", tension: 0.3, pointRadius: 0, fill: true },
        { label: "% con ≥ 5 min", data: pts.map((p) => p.pctLate), borderColor: "#F4603F", yAxisID: "y1", tension: 0.3, pointRadius: 0 },
        { label: s.series.step === "hour" ? "Trenes circulando" : "Trenes", data: pts.map((p) => p.trains), borderColor: "#7FA7D6", yAxisID: "y2", tension: 0.3, pointRadius: 0, borderDash: [4, 4] },
      ] },
      options: { responsive: true, maintainAspectRatio: false, interaction: { mode: "index", intersect: false },
        scales: { y: { position: "left", title: { display: true, text: "min" }, beginAtZero: true }, y1: { position: "right", min: 0, max: 100, grid: { display: false }, title: { display: true, text: "%" } }, y2: { display: false, beginAtZero: true } } },
    });
  } else $("cSerieVacio").hidden = false;

  charts.dist = new Chart($("cDist"), {
    type: "bar",
    data: { labels: s.distribution.map((b) => b.label + (b.label === "En hora" ? "" : " min")), datasets: [{ data: s.distribution.map((b) => b.n), backgroundColor: ["#4CC38A", "#4CC38A", "#F0B429", "#F4603F", "#F4603F", "#F4603F"] }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
  });
  charts.tipos = barTypes("cTipos", s.byType, "pctLate", "% con ≥ 5 min");
  if (s.busiestHours?.length) {
    charts.horas = new Chart($("cHoras"), {
      type: "bar",
      data: { labels: s.busiestHours.map((x) => x.h + "h"), datasets: [{ label: "Trenes circulando (media)", data: s.busiestHours.map((x) => x.avg), backgroundColor: "#7FA7D6" }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } },
    });
  } else $("cHorasVacio").hidden = false;

  const tabla = (title, rows, cols, note = "") => `<div class="card"><h2>${title}</h2>${rows?.length ? `<table class="tabla"><thead><tr>${cols.map((c) => `<th class="${c.n ? "n" : ""}">${c.h}</th>`).join("")}</tr></thead><tbody>
    ${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.n ? "n" : ""}">${c.f(r)}</td>`).join("")}</tr>`).join("")}</tbody></table>` : `<p class="vacio-card">Sin datos todavía.</p>`}${note ? `<p class="nota">${note}</p>` : ""}</div>`;
  const per = live ? "ahora" : "por día";
  const runsCol = { h: live ? "Trenes" : "Trenes/día", n: 1, f: (r) => fmt(live ? r.runs : r.perDay) };
  const trenLink = (r) => `<a href="#/tren/${r.id || r.train}">${TYPE_NAME[r.type] || ""} ${r.train}</a>`;
  $("rankings").innerHTML = [
    tabla("Líneas con más retraso", s.lines.worstDelay, [{ h: "Línea", f: (r) => esc(r.line) }, { h: "Retraso medio", n: 1, f: (r) => fmt(r.avgDelay, " min") }, { h: "≥ 5 min", n: 1, f: (r) => fmt(r.pctLate, "%") }, runsCol]),
    tabla("Líneas más puntuales", s.lines.mostPunctual, [{ h: "Línea", f: (r) => esc(r.line) }, { h: "≥ 5 min", n: 1, f: (r) => fmt(r.pctLate, "%") }, { h: "Retraso medio", n: 1, f: (r) => fmt(r.avgDelay, " min") }, runsCol]),
    tabla(`Líneas con más trenes (${per})`, s.lines.mostTrains, [{ h: "Línea", f: (r) => esc(r.line) }, runsCol, { h: "Retraso medio", n: 1, f: (r) => fmt(r.avgDelay, " min") }]),
    tabla(`Líneas con menos trenes (${per})`, s.lines.fewestTrains, [{ h: "Línea", f: (r) => esc(r.line) }, runsCol, { h: "Retraso medio", n: 1, f: (r) => fmt(r.avgDelay, " min") }]),
    tabla(live ? "Trenes con más retraso ahora" : "Mayores retrasos del periodo", s.worstTrains, [{ h: "Tren", f: trenLink }, { h: "Línea", f: (r) => esc(r.line || "") }, { h: "Retraso", n: 1, f: (r) => fmt(r.delay, " min") }, ...(live ? [] : [{ h: "Día", n: 1, f: (r) => r.date.slice(5) }])]),
    ...(live ? [] : [tabla("Trenes que más a menudo llegan tarde", s.oftenLate, [{ h: "Tren", f: trenLink }, { h: "Línea", f: (r) => esc(r.line || "") }, { h: "Días tarde", n: 1, f: (r) => `${r.late}/${r.runs}` }, { h: "Medio", n: 1, f: (r) => fmt(r.avgDelay, " min") }], "Solo trenes vistos al menos 2 días.")]),
  ].join("");
}

function barTypes(id, byType, key, label) {
  const rows = [...(byType || [])].sort((a, b) => b.runs - a.runs);
  return new Chart($(id), {
    type: "bar",
    data: { labels: rows.map((r) => TYPE_NAME[r.type] || r.type), datasets: [{ label, data: rows.map((r) => r[key]), backgroundColor: "#7FA7D6" }] },
    options: { responsive: true, maintainAspectRatio: false, indexAxis: "y", plugins: { legend: { display: false }, tooltip: { callbacks: { afterLabel: (c) => `${rows[c.dataIndex].runs} trenes` } } }, scales: { x: { beginAtZero: true, title: { display: true, text: label } } } },
  });
}
