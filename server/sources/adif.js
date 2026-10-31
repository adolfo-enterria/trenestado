// Adif "Estado de la red": server-rendered notices (<article class="aviso-item">).
// Adif's CDN usually answers 403 to server requests. We make one honest request every few
// minutes and accept failure; we never try to look like a browser to get past it.
import { URLS } from "../config.js";
import { getText } from "./http.js";

const MAJOR = /\b(interrumpid[ao]s?|suspendid[ao]s?|cortad[ao]s?|accidente|descarrilamiento|descarrila|alcance|arrollamiento|incendio|colisi[oó]n)\b/i;

const decodeEntities = (s) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
const clean = (html) => decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

export function parseAdif(html) {
  const out = [];
  const re = /<article[^>]*class="[^"]*aviso-item[^"]*"[^>]*?(?:data-article-id="(\d+)")?[^>]*>([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = re.exec(html))) {
    const body = m[2];
    const ambito = clean(body.match(/<h2[^>]*aviso-item__ambito[^>]*>([\s\S]*?)<\/h2>/i)?.[1] || "");
    const titulo = clean(body.match(/aviso-card__titulo[^>]*>([\s\S]*?)<\/span>/i)?.[1] || "");
    const card = body.match(/aviso-card--([a-z-]+)/i)?.[1] || "";
    const content = body.match(/aviso-card__content[^>]*>([\s\S]*?)<\/div>/i)?.[1] || "";
    const texto = [...content.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((p) => clean(p[1])).filter(Boolean);
    const full = titulo + " " + texto.join(" ");
    const major = MAJOR.test(full);
    const level = major ? "grave" : card === "alerta" ? "leve" : "info";
    out.push({ id: "adif-" + (m[1] || hash(titulo)), source: "adif", level, major, title: titulo, text: texto, scope: ambito });
  }
  return out;
}

function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return (h >>> 0).toString(36); }

export async function fetchAdif() {
  return parseAdif(await getText(URLS.adif, { timeoutMs: 15_000 }));
}
