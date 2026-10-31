// Tracked trains + alarms. Runs in the page (also while the tab is in the background).
// Stored in localStorage: no accounts, nothing personal on the server.
import { store, api, notify, nowMadridMin, toMin, horaLocal } from "./util.js";

export const DEFAULT_TRIGGERS = { delayMin: 15, delayStep: 5, cancel: true, stopped: true, depart: true, arrive: true, beforeArrMin: 15, incident: true, prox: true };

let tracked = store.get("tracked", []); // [{ n, nom, ruta, linea, triggers, st, log, added }]
let globalCfg = store.get("alarmasGlobales", { major: false, majorRegion: "", prox: false });
let seenGlobal = new Set(store.get("vistosGlobales", []));
const detail = new Map(); // n → { at, data } cache of /api/tren
const listeners = new Set();

const save = () => { store.set("tracked", tracked); listeners.forEach((f) => f()); };
export const onChange = (f) => listeners.add(f);
export const getTracked = () => tracked;
export const isTracked = (n) => tracked.some((t) => t.n === n);
export const getGlobal = () => globalCfg;
export function setGlobal(cfg, D) {
  const wasMajor = globalCfg.major;
  globalCfg = { ...globalCfg, ...cfg };
  store.set("alarmasGlobales", globalCfg);
  if (!wasMajor && globalCfg.major && D) {
    // don't fire for what is already active; just summarise it once
    const act = (D.incidencias || []).filter((i) => i.major && matchesRegion(i));
    act.forEach((i) => seenGlobal.add(i.id));
    store.set("vistosGlobales", [...seenGlobal]);
    if (act.length) notify("Incidencias graves activas", `${act.length} ahora mismo: ${act.map((i) => i.title).join(" · ")}`, { level: "grave", url: "#/" });
  }
  listeners.forEach((f) => f());
}

function log(t, txt) { t.log.unshift({ at: new Date().toISOString(), txt }); t.log = t.log.slice(0, 40); }

export function track(n, info = {}, triggers = {}) {
  let t = tracked.find((x) => x.n === n);
  if (!t) {
    t = { n, nom: info.nom || "Tren", ruta: info.ruta || "", linea: info.linea || "", triggers: { ...DEFAULT_TRIGGERS, ...triggers }, st: {}, log: [], added: new Date().toISOString() };
    log(t, "Alarma creada");
    tracked.push(t);
  } else {
    Object.assign(t, { nom: info.nom || t.nom, ruta: info.ruta || t.ruta, linea: info.linea || t.linea });
    t.triggers = { ...t.triggers, ...triggers };
  }
  t.st.baseline = false; // next check sets the baseline (no instant "departed" etc.)
  save();
  return t;
}
export function untrack(n) { tracked = tracked.filter((t) => t.n !== n); save(); }

// ---------- evaluation ----------
async function trainDetail(n, maxAgeMs) {
  const c = detail.get(n);
  if (c && Date.now() - c.at < maxAgeMs) return c.data;
  try { const data = await api("/api/tren/" + n); detail.set(n, { at: Date.now(), data }); return data; } catch { return c?.data || null; }
}

const near = (a, b, km) => { const dx = (a[1] - b[1]) * Math.cos((a[0] * Math.PI) / 180) * 111, dy = (a[0] - b[0]) * 111; return Math.hypot(dx, dy) < km; };
const matchesRegion = (i) => !globalCfg.majorRegion || (i.scope || "").toLowerCase().includes(globalCfg.majorRegion.toLowerCase()) || (i.title || "").toLowerCase().includes(globalCfg.majorRegion.toLowerCase());

export async function check(D) {
  // global alarms
  if (globalCfg.major) for (const i of D.incidencias || []) {
    if (!i.major || seenGlobal.has(i.id) || !matchesRegion(i)) continue;
    seenGlobal.add(i.id);
    notify("Incidencia grave", i.title, { level: "grave", url: "#/", tag: i.id });
  }
  if (globalCfg.prox) for (const p of D.proximidad || []) {
    if (seenGlobal.has(p.id)) continue;
    seenGlobal.add(p.id);
    notify("Anomalía de proximidad (experimental)", `${p.follower} a ${(p.distM / 1000).toFixed(1)} km de ${p.leader}; frenado estimado ${(p.requiredM / 1000).toFixed(1)} km. Puede ser un error de GPS.`, { level: "prox", url: "#/tren/" + p.follower, tag: p.id });
  }
  store.set("vistosGlobales", [...seenGlobal].slice(-500));

  // tracked trains
  let changed = false;
  for (const t of tracked) {
    const live = D.trenes.find((x) => x.id === t.n); // t.n holds the train id ("03303", "c23065")
    const tr = t.triggers, st = t.st;
    const det = await trainDetail(t.n, live ? 120_000 : 60_000);
    if (det) { t.linea = det.linea || t.linea; t.ruta = det.origen ? `${det.origen} → ${det.destino}` : t.ruta; t.nom = det.nom || t.nom; }
    const status = live ? "circulando" : det?.status;
    // departure/arrival/stopped stay quiet on the first check (baseline); delay, cancellation, incidents always notify
    const fire = (txt, level = "info", quietOnBaseline = false) => { log(t, txt); changed = true; if (st.baseline || !quietOnBaseline) notify(`${t.nom} ${t.n.replace(/^c/, "")}`, txt, { level, url: "#/tren/" + t.n, tag: t.n + txt }); };

    // cancellation
    if (tr.cancel && status === "cancelado" && !st.cancel) { st.cancel = true; fire("Renfe ha cancelado este tren hoy.", "grave"); }
    // departure / arrival
    if (live && !st.departed) { st.departed = true; if (st.seenScheduled && tr.depart) fire("Ha salido y ya circula.", "ok", true); }
    if (!live && status === "programado") st.seenScheduled = true;
    if (live && (live.sig === live.des || live.ant === live.des)) st.nearDest = true;
    if (tr.arrive && !st.arrived && st.departed && ((status === "finalizado") || (!live && st.nearDest))) { st.arrived = true; fire("Ha llegado a su destino.", "ok", true); }
    // N min before arrival
    if (live && tr.beforeArrMin && live.lleg && !st.beforeArr) {
      let left = toMin(live.lleg) + Math.max(0, live.ret) - nowMadridMin();
      if (left < -600) left += 1440;
      if (left >= 0 && left <= tr.beforeArrMin) { st.beforeArr = true; fire(`Llegará en unos ${left} min (≈ ${live.lleg} ${live.ret > 0 ? "+" + live.ret : ""}).`, "ok"); }
    }
    // delay
    if (live && tr.delayMin != null) {
      const d = live.ret;
      if (st.notifiedDelay == null && d >= tr.delayMin) { st.notifiedDelay = d; fire(`Retraso de ${d} min.`, d >= 15 ? "grave" : "leve"); }
      else if (st.notifiedDelay != null && Math.abs(d - st.notifiedDelay) >= (tr.delayStep || 5)) {
        fire(d > st.notifiedDelay ? `El retraso sube a ${d} min.` : `El retraso baja a ${Math.max(0, d)} min.`, d >= 15 ? "grave" : d >= 5 ? "leve" : "ok");
        st.notifiedDelay = d < tr.delayMin ? null : d;
      }
    }
    // stopped between stations
    if (live && tr.stopped) {
      if (live.parado >= 5 && live.entre && !st.stopped) { st.stopped = true; fire(`Parado ${live.parado} min fuera de estación.`, "leve", true); }
      if (live.kmh >= 10 && st.stopped) { st.stopped = false; fire("Vuelve a circular.", "ok", true); }
    }
    // incidents affecting its route
    if (tr.incident) {
      st.incidents ||= [];
      const stops = (det?.stops || []).filter((s) => s.lat).map((s) => [s.lat, s.lon]);
      for (const i of D.incidencias || []) {
        if (st.incidents.includes(i.id)) continue;
        const hit = i.trains?.includes(t.n) || (t.linea && i.scope === t.linea) || (i.path && stops.some((s) => i.path.some((p) => near(s, p, 20))));
        if (!hit || i.level === "info") continue;
        st.incidents.push(i.id);
        fire(`Incidencia en su recorrido: ${i.title}`, i.level);
      }
    }
    // proximity
    if (tr.prox) {
      st.prox ||= [];
      for (const p of D.proximidad || []) if ((p.follower === t.n || p.leader === t.n) && !st.prox.includes(p.id)) {
        st.prox.push(p.id);
        fire(`Anomalía de proximidad con el tren ${p.follower === t.n ? p.leader : p.follower} (${(p.distM / 1000).toFixed(1)} km). Experimental, puede ser un error de GPS.`, "prox");
      }
    }
    if (!st.baseline) { st.baseline = true; changed = true; log(t, `Estado inicial: ${status || "desconocido"}${live ? `, retraso ${live.ret} min` : ""} (${horaLocal(new Date())})`); }
  }
  if (changed) save();
}
