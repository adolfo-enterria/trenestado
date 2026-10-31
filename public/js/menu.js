// Left slide-in navigation drawer (☰): overlay, focus trap, Esc to close, closes on navigation.
import { $ } from "./util.js";

let abierto = false, volverA = null, cerrando = null;
const FOCO = 'a[href], button:not([disabled]), input, select, [tabindex]:not([tabindex="-1"])';
const fondo = () => [document.querySelector(".barra"), $("contenido"), $("aviso"), $("toasts")].filter(Boolean);
const quieto = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export function initMenu() {
  $("menuBtn").addEventListener("click", () => (abierto ? cerrar() : abrir()));
  $("menuCerrar").addEventListener("click", () => cerrar());
  $("velo").addEventListener("click", () => cerrar());
  $("menu").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); cerrar(); return; }
    if (e.key !== "Tab") return;
    const els = [...$("menu").querySelectorAll(FOCO)].filter((el) => el.offsetParent !== null);
    if (!els.length) return;
    const first = els[0], last = els.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  // a click on the link of the page already shown doesn't fire hashchange: close anyway
  $("menu").querySelector("nav").addEventListener("click", (e) => { if (e.target.closest("a")) cerrar(false); });
  addEventListener("hashchange", () => cerrar(false));
}

export function abrir() {
  if (abierto) return;
  abierto = true;
  clearTimeout(cerrando);
  volverA = document.activeElement;
  $("menu").hidden = false; $("velo").hidden = false;
  fondo().forEach((el) => (el.inert = true));
  $("menuBtn").setAttribute("aria-expanded", "true");
  document.body.classList.add("menu-abierto");
  requestAnimationFrame(() => requestAnimationFrame(() => { $("menu").classList.add("abierto"); $("velo").classList.add("abierto"); }));
  // focus the current section (or the first link)
  ($("menu").querySelector('nav a[aria-current="page"]') || $("menu").querySelector("nav a")).focus({ preventScroll: true });
}

/** devolverFoco=false when closing because of a navigation (focus then goes to the new view). */
export function cerrar(devolverFoco = true) {
  if (!abierto) return;
  abierto = false;
  $("menu").classList.remove("abierto"); $("velo").classList.remove("abierto");
  fondo().forEach((el) => (el.inert = false));
  $("menuBtn").setAttribute("aria-expanded", "false");
  document.body.classList.remove("menu-abierto");
  cerrando = setTimeout(() => { $("menu").hidden = true; $("velo").hidden = true; }, quieto() ? 0 : 240);
  if (devolverFoco) (volverA?.isConnected ? volverA : $("menuBtn")).focus({ preventScroll: true });
  // after a navigation the router moves focus to the new view; if nothing took it, don't leave it in the hidden drawer
  else setTimeout(() => { const a = document.activeElement; if (!a || a === document.body || $("menu").contains(a)) $("menuBtn").focus({ preventScroll: true }); }, 60);
}
