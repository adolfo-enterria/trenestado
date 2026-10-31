export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const store = {
  get(k, d) { try { const v = localStorage.getItem("trenestado." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("trenestado." + k, JSON.stringify(v)); } catch {} },
};

export async function api(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

// ---------- theme (auto / claro / oscuro) + theme-aware colours ----------
// Canvas layers (Leaflet, Chart.js) can't use CSS variables, so the palette is read from the CSS tokens
// into COL and every map/chart re-styles itself through onTema() when the theme changes.
export const COL = {};
const TOKENS = ["ok", "leve", "grave", "info", "prox", "suelo", "tierra", "vecinos", "frontera", "limite", "via", "via-cer", "ciudad", "texto", "texto2", "panel", "halo", "acento", "rejilla"];
const temaFns = new Set();
export const onTema = (f) => (temaFns.add(f), () => temaFns.delete(f));
export const TEMAS = { auto: "automático", claro: "claro", oscuro: "oscuro" };
export const temaElegido = () => store.get("tema", "auto");
function leerColores() {
  const css = getComputedStyle(document.documentElement);
  for (const k of TOKENS) COL[k.replace("-", "_")] = css.getPropertyValue("--" + k).trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", COL.panel);
}
export function aplicarTema(t) {
  store.set("tema", t);
  if (t === "claro" || t === "oscuro") document.documentElement.dataset.theme = t === "claro" ? "light" : "dark";
  else delete document.documentElement.dataset.theme;
  leerColores();
  temaFns.forEach((f) => f());
}
leerColores();
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => { if (temaElegido() === "auto") { leerColores(); temaFns.forEach((f) => f()); } });

export const nivel = (r) => (r >= 15 ? "grave" : r >= 5 ? "leve" : "ok");
export const durTxt = (m) => (m == null ? "–" : m <= 0 ? (m < 0 ? `${-m} min adelantado` : "En hora") : m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);
export const addMin = (hhmm, m) => {
  if (!hhmm) return "–";
  const [h, mi] = hhmm.split(":").map(Number);
  const t = (((h * 60 + mi + m) % 1440) + 1440) % 1440;
  return String(Math.floor(t / 60)).padStart(2, "0") + ":" + String(t % 60).padStart(2, "0");
};
export const horaLocal = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" }); };
export const fechaHora = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" }); };
export const nowMadridMin = () => { const [h, m] = new Date().toLocaleTimeString("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).split(":").map(Number); return h * 60 + m; };
export const toMin = (hhmm) => { if (!hhmm) return null; const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
/** Distance in km between two lat/lon points (haversine). */
export const distKm = (a1, o1, a2, o2) => {
  const r = Math.PI / 180, dA = (a2 - a1) * r, dO = (o2 - o1) * r;
  const h = Math.sin(dA / 2) ** 2 + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(dO / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
};
export const fmt = (x, suf = "") => (x == null || Number.isNaN(x) ? "–" : x.toLocaleString("es-ES") + suf);

export const TYPE_NAME = { ave: "AVE", avlo: "Avlo", avant: "Avant", alvia: "Alvia", ld: "Euromed/Intercity", md: "Media distancia", cer: "Cercanías" };

/** "Llega tarde el 40 % de los días (12 días)" from /api/puntualidad. */
export function puntTexto(p) {
  if (!p || !p.dias) return "sin historial todavía";
  if (!p.recorridos) return p.cancelados ? `cancelado ${p.cancelados} de ${p.dias} días` : "sin historial todavía";
  return `tarde el ${p.tarde5} % de los días (${p.recorridos} ${p.recorridos === 1 ? "día" : "días"}${p.cancelados ? `, ${p.cancelados} cancelado${p.cancelados > 1 ? "s" : ""}` : ""})`;
}

// ---------- notifications ----------
export function toast(title, body = "", level = "info", onClick = null) {
  const el = document.createElement("div");
  el.className = "toast " + level;
  el.innerHTML = `<b>${esc(title)}</b>${esc(body)}`;
  el.onclick = () => { onClick?.(); el.remove(); };
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), 12_000);
}

let audio = null;
export function beep(level = "info") {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    const notes = level === "grave" || level === "prox" ? [880, 660, 880] : [740, 990];
    notes.forEach((f, i) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = f; o.type = "sine";
      g.gain.setValueAtTime(0.0001, audio.currentTime + i * 0.18);
      g.gain.exponentialRampToValueAtTime(0.15, audio.currentTime + i * 0.18 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + i * 0.18 + 0.16);
      o.connect(g).connect(audio.destination);
      o.start(audio.currentTime + i * 0.18); o.stop(audio.currentTime + i * 0.18 + 0.17);
    });
  } catch {}
}

export function notify(title, body, { level = "info", url = null, tag } = {}) {
  const go = () => { if (url) location.hash = url; window.focus(); };
  toast(title, body, level, go);
  beep(level);
  if ("Notification" in window && Notification.permission === "granted") {
    try { const n = new Notification(title, { body, tag, icon: document.querySelector("link[rel=icon]").href }); n.onclick = () => { go(); n.close(); }; } catch {}
  }
}

export async function askNotificationPermission() {
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission === "default") { try { return await Notification.requestPermission(); } catch { return Notification.permission; } }
  return Notification.permission;
}

// Self-hosted land polygons (/api/tierra): offline fallback of the vector basemap (see basemap.js).
let tierra = null;
export async function baseLand(map) {
  // own pane below everything else, so it never paints over trains even though it loads last
  if (!map.getPane("tierra")) map.createPane("tierra").style.zIndex = 250;
  const renderer = L.canvas({ pane: "tierra" });
  tierra ??= api("/api/tierra");
  const t = await tierra;
  if (!map.getPane("tierra")) return; // map was removed while loading
  const vec = L.geoJSON(t.neighbours, { renderer, interactive: false }).addTo(map);
  const esp = L.geoJSON(t.spain, { renderer, interactive: false }).addTo(map);
  const lim = L.geoJSON(t.borders, { renderer, interactive: false }).addTo(map);
  const estilo = () => {
    vec.setStyle({ color: COL.frontera, weight: 1, fillColor: COL.vecinos, fillOpacity: 1 });
    esp.setStyle({ color: COL.frontera, weight: 1.2, fillColor: COL.tierra, fillOpacity: 1 });
    lim.setStyle({ color: COL.limite, weight: 0.8, dashArray: "3 4" });
  };
  estilo();
  const off = onTema(estilo);
  map.on("unload", off);
}

// Rail network segments, fetched once and shared by the main map and the incidents map.
let redP = null;
export const redFerroviaria = () => (redP ??= api("/api/red").catch((e) => { redP = null; throw e; }));

// Diamond marker used for incidents (map + lists). Level is also spelled out in text wherever it matters.
export const rombo = (level, size = 14) => L.divIcon({ className: "rombo-mapa " + level, html: "<i></i>", iconSize: [size, size] });

export const NIVEL_INC = { grave: "Grave", leve: "Afecta", info: "Aviso" };
export const NIVEL_RET = { ok: "En hora o menos de 5 min", leve: "De 5 a 14 min", grave: "15 min o más" };
/** Delay badge: colour + shape glyph + number, so it reads without colour. */
export const retBadge = (m, txt) => `<span class="ret ${nivel(m ?? 0)}" title="${NIVEL_RET[nivel(m ?? 0)]}">${txt ?? durTxt(m)}</span>`;
