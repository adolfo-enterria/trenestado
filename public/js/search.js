// Global search: train numbers ("03303", "AVE 3303"), station names and places (municipalities → map).
import { $, esc, api, puntTexto } from "./util.js";

let last = null, deb = null, items = [], idx = -1;

export function initSearch({ onLugar } = {}) {
  const q = $("q"), sug = $("sug");
  const close = () => { sug.hidden = true; idx = -1; };
  const go = (it) => {
    if (!it) return;
    close(); q.blur();
    if (it.kind === "lugar") { q.value = it.n; onLugar?.(it); return; }
    location.hash = it.kind === "tren" ? "#/tren/" + it.id : "#/estacion/" + it.code;
  };
  q.addEventListener("input", () => {
    clearTimeout(deb);
    const v = q.value.trim();
    if (!v) return close();
    deb = setTimeout(async () => {
      last = v;
      let r;
      try { r = await api("/api/buscar?q=" + encodeURIComponent(v)); } catch { return; }
      if (last !== v) return;
      items = [...(r.trenes || []).map((t) => ({ kind: "tren", ...t })), ...(r.estaciones || []).map((e) => ({ kind: "est", ...e })),
        ...(r.lugares || []).filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lon)).map((l) => ({ kind: "lugar", ...l }))];
      idx = items.length ? 0 : -1;
      render(v);
    }, 180);
  });
  q.addEventListener("keydown", (e) => {
    if (sug.hidden) return;
    if (e.key === "ArrowDown") { idx = Math.min(items.length - 1, idx + 1); render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { idx = Math.max(0, idx - 1); render(); e.preventDefault(); }
    else if (e.key === "Escape") close();
  });
  $("buscar").addEventListener("submit", (e) => {
    e.preventDefault();
    if (items[idx]) return go(items[idx]);
    const digits = q.value.replace(/\D/g, "");
    if (digits) { close(); location.hash = "#/tren/" + digits; }
  });
  sug.addEventListener("mousedown", (e) => { const a = e.target.closest("[data-i]"); if (a) { e.preventDefault(); go(items[Number(a.dataset.i)]); } });
  document.addEventListener("click", (e) => { if (!e.target.closest("#buscar")) close(); });

  function render(v) {
    const tr = items.filter((x) => x.kind === "tren"), es = items.filter((x) => x.kind === "est"), lu = items.filter((x) => x.kind === "lugar");
    const row = (it) => { const i = items.indexOf(it); return `<a href="#" role="option" aria-selected="${i === idx}" data-i="${i}" class="${i === idx ? "sel" : ""}">`; };
    sug.innerHTML = items.length ? `
      ${tr.length ? `<h4>Trenes</h4>${tr.map((t) => `${row(t)}<b>${esc(t.nom)} ${t.n}</b><small>${esc(t.ruta || "")}${t.vivo ? ` · circulando${t.ret >= 1 ? " +" + t.ret : ""}` : t.hoy ? (t.sal ? ` · sale ${t.sal}` : "") : " · no circula hoy"}${t.puntualidad?.recorridos ? ` · ${puntTexto(t.puntualidad)}` : ""}</small></a>`).join("")}` : ""}
      ${es.length ? `<h4>Estaciones</h4>${es.map((s) => `${row(s)}<b>${esc(s.n)}</b><small>${esc(s.reg || "")} · panel de salidas${s.ahora ? ` · ${s.ahora} trenes cerca` : ""}</small></a>`).join("")}` : ""}
      ${lu.length ? `<h4>Lugares</h4>${lu.map((l) => `${row(l)}<b>${esc(l.n)}</b><small>${esc(l.prov || "")} · ver en el mapa y trenes cerca</small></a>`).join("")}` : ""}`
      : `<div class="vacio">Nada encontrado para «${esc(v ?? $("q").value)}». Prueba con el número del tren (p. ej. 03303), una estación o un municipio.</div>`;
    sug.hidden = false;
  }
}
