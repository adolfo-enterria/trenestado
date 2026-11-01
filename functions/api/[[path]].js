// Cloudflare Pages Function for every /api/* request of the deployed site.
//   /api/estado            → R2 live/estado.json (written every minute by the Supabase collector)
//   /api/base|red|tierra|red-cercanias → R2 static/*.json (written daily by the GitHub Action)
//   /api/export/info, /api/export      → R2 exports/* (monthly CSV files, written daily)
//   anything else          → Supabase Edge Function "api"
// Bindings / variables (Pages → Settings): R2 bucket binding LIVE, variable SUPABASE_URL (not secret; the
// Supabase "api" function is public and read-only, so no key is needed).
// Only streams bytes, so it stays within the free plan's 10 ms CPU per request.
// Responses go through Cloudflare's Cache API (see cacheKey): a hit costs no R2 read and no Supabase call.

const STATIC = { base: "static/base.json", red: "static/red.json", tierra: "static/tierra.json", "red-cercanias": "static/red-cercanias.json" };
// Supabase routes → the query parameters each one reads (the only ones kept in the cache key), and whether it
// takes an id (/api/tren/03303). Anything else is refused here so it never costs a Supabase invocation.
const SUPABASE = { tren: [[], true], estacion: [["tipo"], true], puntualidad: [[], true], buscar: [["q"], false],
  stats: [["w", "tipos", "region"], false], incidencias: [[], false], fuentes: [[], false] };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const headers = (type, cache) => ({ "Content-Type": type, "Cache-Control": cache, "Access-Control-Allow-Origin": "*" });
const err = (status, error) => new Response(JSON.stringify({ error }), { status, headers: headers("application/json; charset=utf-8", "no-store") });

async function fromR2(env, key, cache, fallback) {
  const obj = env.LIVE ? await env.LIVE.get(key) : null;
  if (!obj) return fallback ? fallback() : err(503, "Datos aún no disponibles");
  return new Response(obj.body, { headers: { ...headers(obj.httpMetadata?.contentType || "application/json; charset=utf-8", cache), ETag: obj.httpEtag } });
}

// Monthly CSVs for the requested range, concatenated (header kept from the first file only).
async function exportCsv(env, url) {
  const id = url.searchParams.get("datos") || "";
  const desde = url.searchParams.get("desde") || "", hasta = url.searchParams.get("hasta") || "";
  if (!/^[a-z]+$/.test(id) || !DATE.test(desde) || !DATE.test(hasta) || desde > hasta) return err(400, "Parámetros no válidos");
  const idx = await env.LIVE?.get("exports/index.json");
  if (!idx) return err(503, "Las descargas aún no están preparadas");
  const ds = (await idx.json()).datasets?.find((d) => d.id === id);
  if (!ds) return err(404, "Conjunto de datos desconocido");
  const months = ds.meses.map((m) => m.mes).filter((m) => m >= desde.slice(0, 7) && m <= hasta.slice(0, 7));
  if (!months.length) return err(404, "No hay datos en ese periodo");
  const { readable, writable } = new TransformStream();
  (async () => {
    const w = writable.getWriter();
    for (const [i, m] of months.entries()) {
      const obj = await env.LIVE.get(`exports/${id}/${m}.csv`);
      if (!obj) continue;
      if (i === 0) { await obj.body.pipeTo(new WritableStream({ write: (c) => w.write(c) })); continue; }
      // skip the header line of every file after the first
      let skipping = true;
      await obj.body.pipeTo(new WritableStream({ write: (c) => {
        if (!skipping) return w.write(c);
        const nl = c.indexOf(10);
        if (nl < 0) return;
        skipping = false;
        return w.write(c.subarray(nl + 1));
      } }));
    }
    await w.close();
  })();
  return new Response(readable, { headers: { ...headers("text/csv; charset=utf-8", "public, max-age=600"),
    "Content-Disposition": `attachment; filename="trenestado_${id}_${months[0]}_${months.at(-1)}.csv"` } });
}

// Cache key with only what the route reads, so ?x=<random> or extra path segments can't skip the cache.
// undefined = unknown route; null = known but not cacheable (invalid export parameters, answered with a 400).
function cacheKey(url, parts) {
  const path = parts.join("/"), key = new URL(url.origin + "/api/" + path);
  if (path === "estado" || STATIC[path] || path === "export/info") return key.href;
  if (path === "export") {
    // a download is whole monthly files, so only the dataset and the first and last month matter
    const id = url.searchParams.get("datos") || "", desde = url.searchParams.get("desde") || "", hasta = url.searchParams.get("hasta") || "";
    if (!/^[a-z]+$/.test(id) || !DATE.test(desde) || !DATE.test(hasta) || desde > hasta) return null;
    key.search = new URLSearchParams({ datos: id, desde: desde.slice(0, 7), hasta: hasta.slice(0, 7) });
    return key.href;
  }
  const route = SUPABASE[parts[0]];
  if (!route || parts.length > (route[1] ? 2 : 1)) return undefined;
  if (route[1]) key.pathname = "/api/" + parts[0] + "/" + encodeURIComponent((parts[1] || "").trim().toLowerCase());
  for (const k of route[0]) { const v = url.searchParams.get(k); if (v != null) key.searchParams.set(k, v); }
  return key.href;
}

async function respond(request, env, url, path) {
  if (path === "estado") return fromR2(env, "live/estado.json", "public, max-age=20");
  if (STATIC[path]) return fromR2(env, STATIC[path], "public, max-age=3600");
  if (path === "export/info") return fromR2(env, "exports/index.json", "public, max-age=600");
  if (path === "export") return exportCsv(env, url);

  // everything else → Supabase Edge Function "api" (it sets Cache-Control per route)
  if (!env.SUPABASE_URL) return err(500, "Falta SUPABASE_URL");
  const r = await fetch(`${env.SUPABASE_URL}/functions/v1/api/${path}${url.search}`);
  return new Response(r.body, { status: r.status, headers: { ...headers(r.headers.get("Content-Type") || "application/json", r.headers.get("Cache-Control") || "no-store") } });
}

export async function onRequest({ request, env, params, waitUntil }) {
  const url = new URL(request.url);
  const parts = params.path || [];
  if (request.method !== "GET" && request.method !== "HEAD") return err(405, "Solo lectura");
  const key = cacheKey(url, parts);
  if (key === undefined) return err(404, "Ruta desconocida");

  const cache = caches.default;
  const hit = key && await cache.match(key);
  if (hit) { const res = new Response(hit.body, hit); res.headers.set("X-Trenestado-Cache", "hit"); return res; }
  const res = await respond(request, env, url, parts.join("/"));
  res.headers.set("X-Trenestado-Cache", "miss");
  if (key && res.status === 200 && /max-age=[1-9]/.test(res.headers.get("Cache-Control") || "")) waitUntil(cache.put(key, res.clone()));
  return res;
}
