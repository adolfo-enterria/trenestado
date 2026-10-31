// Shared code for the Supabase Edge Functions (collector, api). Mirrors server/*.js of the local app.
import postgres from "npm:postgres@3.4.7";
import { AwsClient } from "npm:aws4fetch@1.0.20";

// ---------- database (SUPABASE_DB_URL is provided to every Edge Function) ----------
export const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, {
  prepare: false, max: 3, idle_timeout: 10, connect_timeout: 15,
  debug: Deno.env.get("SQL_DEBUG") ? (_c: number, q: string, p: unknown[]) => console.log("SQL", q.replace(/\s+/g, " ").slice(0, 160), JSON.stringify(p).slice(0, 120)) : undefined,
});

// ---------- R2 (optional: without credentials the snapshot only goes to the live_state table) ----------
const R2_KEY = Deno.env.get("R2_ACCESS_KEY_ID");
const r2 = R2_KEY ? new AwsClient({ accessKeyId: R2_KEY, secretAccessKey: Deno.env.get("R2_SECRET_ACCESS_KEY")!, service: "s3", region: "auto" }) : null;
const R2_URL = r2 ? `https://${Deno.env.get("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com/${Deno.env.get("R2_BUCKET") || "trenestado"}` : "";
export const r2Enabled = !!r2;
export async function r2Put(key: string, body: string, type = "application/json", cache = "public, max-age=30") {
  if (!r2) return false;
  const r = await r2.fetch(`${R2_URL}/${key}`, { method: "PUT", body, headers: { "Content-Type": type, "Cache-Control": cache } });
  if (!r.ok) throw new Error(`R2 PUT ${key} → ${r.status}`);
  return true;
}
export async function r2GetJson<T>(key: string): Promise<T | null> {
  if (!r2) return null;
  const r = await r2.fetch(`${R2_URL}/${key}`);
  return r.ok ? (await r.json()) as T : null;
}

// ---------- constants (same as server/config.js, server/products.js) ----------
export const DELAY = { leve: 5, grave: 15 };
export const STOPPED = { kmh: 4, minMinutes: 5, majorMinutes: 15, majorDelayRise: 15 };
export const PROXIMITY = { maxFixAgeS: 60, minKmh: 30, maxHeadingDiff: 30, decel: 0.5, marginM: 500, persistCycles: 2 };
export const WINDOWS: Record<string, number | null> = { now: 0, "1D": 1, "7D": 7, "1M": 30, "3M": 91, "6M": 182, "1A": 365, YTD: null };

export const TYPES = [
  { id: "ave", name: "AVE", prod: [2, 25] },
  { id: "avlo", name: "Avlo", prod: [28] },
  { id: "avant", name: "Avant", prod: [3] },
  { id: "alvia", name: "Alvia", prod: [11] },
  { id: "ld", name: "Euromed e Intercity", prod: [10, 13, 4, 5, 7, 8, 9, 24] },
  { id: "md", name: "Media distancia y regionales", prod: [14, 15, 16, 18, 19, 20, 21, 0] },
  { id: "cer", name: "Cercanías" },
  { id: "iryo", name: "Iryo", noData: true },
  { id: "ouigo", name: "Ouigo", noData: true },
];
const PRODUCT_NAME: Record<number, string> = {
  2: "AVE", 25: "AVE", 28: "Avlo", 3: "Avant", 11: "Alvia", 10: "Euromed", 13: "Intercity", 4: "Talgo", 5: "Altaria", 7: "Diurno",
  8: "Estrella", 9: "Tren Hotel", 24: "AV City", 14: "Andalucía Exprés", 15: "Catalunya Exprés", 16: "Media distancia", 18: "Regional",
  19: "Regional Exprés", 20: "TRD", 21: "Proximidad",
};
export const typeOf = (p: number | null) => (TYPES.find((t) => t.prod?.includes(p as number)) || TYPES.find((t) => t.id === "md")!).id;
export const productName = (p: number | null, fallback = "Tren") => (p != null && PRODUCT_NAME[p]) || fallback;

// ---------- helpers ----------
export const normCode = (c: unknown) => String(c ?? "").trim().replace(/^0+/, "").padStart(5, "0");
export const normTrain = (n: unknown) => String(n ?? "").trim().replace(/\D/g, "").replace(/^0+/, "").padStart(5, "0");
export const madridDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(d);
export const madridMinutes = (d = new Date()) => {
  const [h, m] = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d).split(":").map(Number);
  return h * 60 + m;
};
export const hhmm = (min: number | null | undefined) => (min == null ? null : String(Math.floor((((min % 1440) + 1440) % 1440) / 60)).padStart(2, "0") + ":" + String(((min % 60) + 60) % 60).padStart(2, "0"));
const rad = (d: number) => (d * Math.PI) / 180;
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number) {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
export const headingDiff = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
export const norm = (s: unknown) => String(s ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

// ---------- stations (cached per warm instance; refreshed every 6 h) ----------
export type Station = { code: string; name: string; lat: number; lon: number; region: string | null; region_name: string | null; province: string | null };
let stationCache: { at: number; map: Map<string, Station> } | null = null;
export async function stations() {
  if (stationCache && Date.now() - stationCache.at < 6 * 3600_000) return stationCache.map;
  const rows = await sql<Station[]>`select code, name, lat, lon, region, region_name, province from public.stations`;
  stationCache = { at: Date.now(), map: new Map(rows.map((r) => [r.code, r])) };
  return stationCache.map;
}

const SHORT: Record<string, string> = {
  "60000": "Madrid Atocha", "17000": "Madrid Chamartín", "18000": "Madrid Atocha", "10000": "Madrid Príncipe Pío", "71801": "Barcelona Sants",
  "79400": "Barcelona França", "03216": "València J. Sorolla", "65000": "València Nord", "51003": "Sevilla", "60911": "Alicante", "04040": "Zaragoza",
  "08223": "Vigo", "31412": "A Coruña", "15100": "León", "15211": "Oviedo", "11511": "San Sebastián", "04307": "Figueres", "87089": "Marsella",
  "87303": "Lyon", "03309": "Villena AV", "08240": "Medina AV", "60600": "Albacete", "03208": "Cuenca", "04007": "Guadalajara", "08004": "Segovia",
  "04104": "Camp de Tarragona", "50500": "Córdoba", "54413": "Málaga",
};
export const shortName = (st: Map<string, Station>, code: string) => {
  if (SHORT[code]) return SHORT[code];
  const s = st.get(code);
  return s ? s.name.split("/")[0].replace(/\s*-\s*/g, " ").replace(/^(.{26}).+$/, "$1…").trim() : "estación " + code;
};
const cityName = (st: Map<string, Station>, code: string) => {
  const s = SHORT[code] || st.get(code)?.name || code;
  const first = s.split(/[-/]/)[0].trim();
  return first.replace(/\s+(Delicias|Sants|Nord|Santa Justa|AV|Chamartín|Atocha|Príncipe Pío|Campo Grande|Joaquín Sorolla|J\. Sorolla)$/i, "").trim() || first;
};
export const lineKey = (st: Map<string, Station>, a: string, b: string) => {
  const x = cityName(st, a), y = cityName(st, b);
  return x.localeCompare(y, "es") <= 0 ? `${x} ↔ ${y}` : `${y} ↔ ${x}`;
};
export function nearestStationKm(st: Map<string, Station>, lat: number, lon: number) {
  const k = Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (const s of st.values()) { const dx = (s.lon - lon) * k, dy = s.lat - lat, d = dx * dx + dy * dy; if (d < best) best = d; }
  return Math.sqrt(best) * 111.2;
}

/** Real track path through station codes, from the rail_pairs table (straight where unknown). */
export async function pathForStops(st: Map<string, Station>, codes: string[]) {
  const keys = codes.slice(1).map((b, i) => { const a = codes[i]; return a < b ? `${a}-${b}` : `${b}-${a}`; });
  const rows = keys.length ? await sql<{ pair: string; pts: number[] }[]>`select pair, pts from public.rail_pairs where pair = any(${keys})` : [];
  const pairs = new Map(rows.map((r) => [r.pair, r.pts]));
  const out: [number, number][] = [];
  codes.forEach((c, i) => {
    const s = st.get(c); if (!s) return;
    if (i > 0) {
      const flat = pairs.get(keys[i - 1]);
      if (flat) {
        let pts: [number, number][] = [];
        for (let j = 0; j < flat.length; j += 2) pts.push([flat[j], flat[j + 1]]);
        const a = st.get(codes[i - 1]);
        if (a && haversineKm(pts[0][0], pts[0][1], a.lat, a.lon) > haversineKm(pts.at(-1)![0], pts.at(-1)![1], a.lat, a.lon)) pts = pts.reverse();
        out.push(...pts.slice(1, -1));
      }
    }
    out.push([s.lat, s.lon]);
  });
  return out;
}

// ---------- HTTP helpers ----------
const UA = "trenestado/0.1 (github.com/adolfo-enterria/trenestado; datos abiertos de Renfe)";
const utf8 = new TextDecoder("utf-8", { fatal: true }), latin1 = new TextDecoder("latin1");
export async function getText(url: string, timeoutMs = 20_000) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, signal: AbortSignal.timeout(timeoutMs) });
  const buf = new Uint8Array(await r.arrayBuffer());
  let text: string; try { text = utf8.decode(buf); } catch { text = latin1.decode(buf); }
  if (!r.ok) { const e = new Error(`HTTP ${r.status}`) as Error & { status?: number }; e.status = r.status; throw e; }
  return text;
}
export const getJson = async (url: string, t?: number) => JSON.parse(await getText(url, t));
export const json = (data: unknown, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache, "Access-Control-Allow-Origin": "*" } });

// ---------- Renfe / Adif feeds (same as server/sources/*.js) ----------
export const URLS = {
  flotaLD: "https://tiempo-real.renfe.com/renfe-visor/flotaLD.json",
  flotaCer: "https://tiempo-real.renfe.com/renfe-visor/flota.json",
  renfeAlerts: "https://tiempo-real.renfe.com/renfe-visor/alerts.json",
  tripUpdatesLD: "https://gtfsrt.renfe.com/trip_updates_LD.json",
  rtAlerts: "https://gtfsrt.renfe.com/alerts.json",
  salidas: (code: string) => `https://tiempo-real.renfe.com/renfe-json-cutter/write/salidas/estacion/${code}.json`,
  adif: "https://www.adif.es/viajeros/estado-de-la-red",
};

export async function fetchFleet() {
  const d = await getJson(URLS.flotaLD);
  return {
    updated: d.fechaActualizacion as string,
    trains: (d.trenes || []).map((t: Record<string, unknown>) => ({
      n: normTrain(t.codComercial), p: Number(t.codProduct), lat: Number(t.latitud), lon: Number(t.longitud), ts: Number(t.time) * 1000,
      ret: Number.parseInt(String(t.ultRetraso), 10) || 0, ant: normCode(t.codEstAnt), sig: normCode(t.codEstSig),
      ori: normCode(t.codOrigen), des: normCode(t.codDestino), nextAt: (t.horaLlegadaSigEst as string) || null, acc: !!t.accesible, mat: (t.mat as string) || null,
    })),
  };
}
export async function fetchCercanias() {
  const d = await getJson(URLS.flotaCer);
  return (d.trenes || []).map((t: Record<string, unknown>) => ({
    n: normTrain(t.codTren), line: String(t.codLinea || ""), nucleo: String(t.nucleo || ""), tripId: String(t.tripId || ""),
    lat: Number(t.latitud), lon: Number(t.longitud), ret: Number.parseInt(String(t.retrasoMin), 10) || 0,
    act: normCode(t.codEstAct), sig: normCode(t.codEstSig), ori: normCode(t.codEstOrig), des: normCode(t.codEstDest),
    nextAt: (t.horaLlegadaSigEst as string) || null, via: (t.via as string) || null, acc: !!t.accesible,
  }));
}
export async function fetchTripUpdatesLD() {
  const d = await getJson(URLS.tripUpdatesLD);
  const cancelled: { train: string; date: string; tripId: string }[] = [], delays = new Map<string, number>();
  for (const e of d.entity || []) {
    const tu = e.tripUpdate; if (!tu) continue;
    const id: string = tu.trip?.tripId || "";
    const m = id.match(/^(\d{5})\d(\d{4}-\d{2}-\d{2})$/);
    const train = normTrain(m ? m[1] : id.slice(0, 5));
    if (tu.trip?.scheduleRelationship === "CANCELED") cancelled.push({ train, date: m ? m[2] : madridDate(), tripId: id });
    else if (tu.delay != null) delays.set(train, Number(tu.delay));
  }
  return { cancelled, delays };
}
export async function fetchNotices() {
  const out: { id: string; text: string; scope: string; kind: string }[] = [];
  const [visor, rt] = await Promise.allSettled([getJson(URLS.renfeAlerts), getJson(URLS.rtAlerts)]);
  if (visor.status === "fulfilled") {
    const es = (x: { idiomas?: { lengua: string; texto: string }[] }) => x.idiomas?.find((i) => i.lengua === "es")?.texto || x.idiomas?.[0]?.texto || "";
    const av = visor.value.avisos || {};
    (av.estacion || []).forEach((x: Record<string, unknown>, i: number) => out.push({ id: `renfe-e-${x.estacion}-${i}`, text: es(x), scope: "Estación", kind: "estacion" }));
    (av.linea || []).forEach((x: Record<string, unknown>, i: number) => out.push({ id: `renfe-l-${x.idnegocio}-${x.linea}-${i}`, text: es(x), scope: `Línea ${x.linea}`, kind: "linea" }));
  }
  if (rt.status === "fulfilled") for (const e of rt.value.entity || []) {
    const t = e.alert?.descriptionText?.translation; out.push({ id: "rt-" + e.id, text: t?.find((x: { language: string }) => x.language === "es")?.text || t?.[0]?.text || "", scope: "Cercanías", kind: "servicio" });
  }
  if (visor.status === "rejected" && rt.status === "rejected") throw visor.reason;
  return out;
}
export async function fetchSalidas(code: string) {
  const d = await getJson(URLS.salidas(code), 10_000);
  const t = (s: string) => { const m = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})/.exec(s || ""); return m ? `${m[4]}:${m[5]}` : null; };
  return (d.estacion?.salidas || []).map((s: Record<string, string>) => ({ train: normTrain(s.trenId), line: s.linea, dest: normCode(s.destino), destName: s.destinoNombre, planned: t(s.horaSalidaPlanificada), real: t(s.horaSalidaReal), platform: s.via || null }));
}

const MAJOR = /\b(interrumpid[ao]s?|suspendid[ao]s?|cortad[ao]s?|accidente|descarrilamiento|descarrila|alcance|arrollamiento|incendio|colisi[oó]n)\b/i;
const decodeEntities = (s: string) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
const clean = (h: string) => decodeEntities(h.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return (h >>> 0).toString(36); };
export async function fetchAdif() {
  const html = await getText(URLS.adif, 15_000);
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
    const major = MAJOR.test(titulo + " " + texto.join(" "));
    out.push({ id: "adif-" + (m[1] || hash(titulo)), source: "adif", level: major ? "grave" : card === "alerta" ? "leve" : "info", major, title: titulo, text: texto, scope: ambito });
  }
  return out;
}
