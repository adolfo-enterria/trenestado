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

export const COL = { ok: "#4CC38A", leve: "#F0B429", grave: "#F4603F", info: "#7FA7D6", prox: "#C38CFF" };
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

// Self-hosted base map (land polygons from /api/tierra, no tile provider), shared by the main and mini maps.
let tierra = null;
export async function baseLand(map) {
  // own pane below everything else, so it never paints over trains even though it loads last
  if (!map.getPane("tierra")) map.createPane("tierra").style.zIndex = 250;
  const renderer = L.canvas({ pane: "tierra" });
  tierra ??= api("/api/tierra");
  const t = await tierra;
  const css = getComputedStyle(document.documentElement);
  const v = (n) => css.getPropertyValue(n).trim();
  L.geoJSON(t.neighbours, { renderer, interactive: false, style: { color: v("--frontera"), weight: 1, fillColor: "#1A2631", fillOpacity: 1 } }).addTo(map);
  L.geoJSON(t.spain, { renderer, interactive: false, style: { color: v("--frontera"), weight: 1.2, fillColor: v("--tierra"), fillOpacity: 1 } }).addTo(map);
  L.geoJSON(t.borders, { renderer, interactive: false, style: { color: "#2F4050", weight: 0.8, dashArray: "3 4" } }).addTo(map);
  map.attributionControl?.addAttribution("Mapa: es-atlas, Natural Earth · Datos: Renfe, Adif");
}
