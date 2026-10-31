// Daily job for the Supabase + Cloudflare deployment (run by .github/workflows/daily.yml, or by hand).
//   1. Timetables → Postgres: Renfe LD GTFS (all trips) + Cercanías GTFS (today's and tomorrow's trips only),
//      stations, scheduled trains per day, places (municipalities), real-track stop pairs, Cercanías lines.
//   2. Static map data → R2: base.json, red.json, tierra.json, red-cercanias.json, rail-graph.json.
//   3. Monthly CSV downloads → R2: exports/<dataset>/<YYYY-MM>.csv + exports/index.json.
// Env: DATABASE_URL (Supabase connection string), R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET.
// Usage: node --no-warnings scripts/sync-supabase.mjs [gtfs] [static] [exports] [--all-months]   (default: all three)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { AwsClient } from "aws4fetch";
import { gtfs, loadGtfs, scheduledOn, madridDate } from "../server/sources/gtfs-static.js";
import { cer, loadCercaniasGtfs } from "../server/sources/gtfs-cercanias.js";
import { fetchCercaniasLines } from "../server/sources/renfe.js";
import { typeOf } from "../server/products.js";
import { allMunicipalities } from "../server/geo.js";
import { baseConfig, land, railSegments, cercaniasLines } from "../server/static-data.js";
import { FORMAT, COLS, csvHeader, csvLine } from "../server/export-format.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const steps = args.filter((a) => !a.startsWith("--"));
const want = (s) => !steps.length || steps.includes(s);
const env = (k, req = true) => { const v = process.env[k]; if (!v && req) throw new Error(`Missing env ${k}`); return v; };

const sql = postgres(env("DATABASE_URL"), { prepare: false, max: 4, idle_timeout: 20, connect_timeout: 30 });
const r2 = process.env.R2_ACCESS_KEY_ID ? new AwsClient({ accessKeyId: env("R2_ACCESS_KEY_ID"), secretAccessKey: env("R2_SECRET_ACCESS_KEY"), service: "s3", region: "auto" }) : null;
const R2_URL = r2 && `https://${env("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com/${process.env.R2_BUCKET || "trenestado"}`;

// Cost guards (R2 free plan: 1 M writes and 10 GB per month). Writes are counted in the same meta key the
// collector uses and stop at the shared budget; download files are skipped if the bucket passes 8 GB.
const R2_MONTHLY_WRITE_BUDGET = 800_000, R2_STORAGE_BUDGET = 8e9;
async function withinWriteBudget() {
  const key = "r2_writes_" + madridDate().slice(0, 7);
  const [r] = await sql`insert into public.meta (key, value) values (${key}, '1')
    on conflict (key) do update set value = (meta.value::bigint + 1)::text returning value::bigint as n`;
  return Number(r.n) <= R2_MONTHLY_WRITE_BUDGET;
}
async function bucketBytes() {
  let total = 0, token = null;
  do {
    const r = await r2.fetch(`${R2_URL}?list-type=2${token ? "&continuation-token=" + encodeURIComponent(token) : ""}`);
    if (!r.ok) throw new Error(`R2 list → ${r.status}`);
    const xml = await r.text();
    for (const m of xml.matchAll(/<Size>(\d+)<\/Size>/g)) total += Number(m[1]);
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] : null;
  } while (token);
  return total;
}

async function put(key, body, type = "application/json") {
  if (!r2) { console.warn(`  (no R2 credentials) skip ${key}`); return; }
  if (!(await withinWriteBudget())) throw new Error(`R2 write budget (${R2_MONTHLY_WRITE_BUDGET}/month) reached; not writing ${key}`);
  const r = await r2.fetch(`${R2_URL}/${key}`, { method: "PUT", body, headers: { "Content-Type": type, "Cache-Control": key.startsWith("static/") ? "public, max-age=3600" : "public, max-age=600" } });
  if (!r.ok) throw new Error(`R2 PUT ${key} → ${r.status} ${await r.text()}`);
  console.log(`  R2 ${key} (${(Buffer.byteLength(body) / 1e3).toFixed(0)} kB)`);
}

async function insertChunks(tx, table, rows, size = 2000) {
  for (let i = 0; i < rows.length; i += size) await tx`insert into ${tx(table)} ${tx(rows.slice(i, i + size))}`;
}
const ymdToDate = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

// ---------------------------------------------------------------------------------------------------
async function syncGtfs() {
  console.log("GTFS → Postgres");
  await loadGtfs({ force: true });
  await loadCercaniasGtfs({ force: true });
  const lines = await fetchCercaniasLines().catch((e) => { console.warn("  Cercanías lines:", e.message); return null; });

  const calendar = [], calendarDates = [];
  for (const [id, s] of gtfs.services) {
    if (/^\d{8}$/.test(s.start) && /^\d{8}$/.test(s.end)) calendar.push({ service_id: id, start_date: ymdToDate(s.start), end_date: ymdToDate(s.end), days: s.days });
    for (const d of s.add) calendarDates.push({ service_id: id, date: ymdToDate(d), added: true });
    for (const d of s.remove) calendarDates.push({ service_id: id, date: ymdToDate(d), added: false });
  }
  const trips = [], stopTimes = [];
  for (const t of gtfs.trips.values()) {
    trips.push({ trip_id: t.tripId, train: t.train, product: t.product, route_name: t.routeName || null, service_id: t.serviceId, network: "ld", line: null, shape_id: null, run_date: null });
    for (const s of t.stops) stopTimes.push({ trip_id: t.tripId, seq: s.seq, station: s.code, arr_min: s.arr, dep_min: s.dep });
  }
  for (const t of cer.trips.values()) {
    trips.push({ trip_id: t.tripId, train: t.train || "00000", product: null, route_name: t.line, service_id: "cer", network: "cer", line: t.line, shape_id: t.shapeId, run_date: t.date });
    for (const s of t.stops) stopTimes.push({ trip_id: t.tripId, seq: s.seq, station: s.code, arr_min: s.arr, dep_min: s.dep });
  }
  const shapes = [...cer.shapes].map(([shape_id, pts]) => ({ shape_id, points: sql.json(pts.map(([a, b]) => [Math.round(a * 1e5) / 1e5, Math.round(b * 1e5) / 1e5])) }));
  const stations = [...gtfs.stations.values()].map((s) => ({ code: s.code, name: s.name, lat: s.lat, lon: s.lon, region: s.region, region_name: s.regionName, province: s.province, cercanias: !!s.cercanias, updated_at: new Date() }));

  const today = madridDate();
  const sched = new Map();
  for (const s of scheduledOn(today)) {
    const type = s.product != null ? typeOf(s.product).id : "md";
    const k = type + "|" + (gtfs.stations.get(s.dest)?.region || "");
    sched.set(k, (sched.get(k) || 0) + 1);
  }
  const places = allMunicipalities().map((m) => ({ name: m.n, name_norm: m.key, province: m.prov, lat: m.lat, lon: m.lon }));
  const rail = JSON.parse(fs.readFileSync(path.join(ROOT, "assets", "rail.json"), "utf8"));
  const pairs = Object.entries(rail.pairs).map(([pair, pts]) => ({ pair, pts: sql.json(pts) }));
  const cerLines = new Map();
  for (const f of lines?.geo.features || []) {
    const p = f.properties, k = `${p.IDNUCLEO}|${p.CODIGO}`;
    if (!cerLines.has(k)) cerLines.set(k, { nucleo: String(p.IDNUCLEO), nucleo_name: p.NUCLEO, line: p.CODIGO, color: p.COLOR || null, geom: sql.json(f.geometry) });
  }

  await sql.begin(async (tx) => {
    await tx`truncate public.gtfs_stop_times, public.gtfs_trips, public.gtfs_calendar, public.gtfs_calendar_dates, public.gtfs_shapes`;
    await insertChunks(tx, "gtfs_calendar", calendar);
    await insertChunks(tx, "gtfs_calendar_dates", calendarDates);
    await insertChunks(tx, "gtfs_trips", trips);
    await insertChunks(tx, "gtfs_stop_times", stopTimes, 5000);
    await insertChunks(tx, "gtfs_shapes", shapes, 50);
    for (let i = 0; i < stations.length; i += 1000) await tx`
      insert into public.stations ${tx(stations.slice(i, i + 1000))}
      on conflict (code) do update set name = excluded.name, lat = excluded.lat, lon = excluded.lon, region = excluded.region,
        region_name = excluded.region_name, province = excluded.province, cercanias = excluded.cercanias, updated_at = excluded.updated_at`;
    await tx`delete from public.scheduled_days where service_date = ${today}`;
    if (sched.size) await tx`insert into public.scheduled_days ${tx([...sched].map(([k, n]) => { const [type, reg] = k.split("|"); return { service_date: today, type, dest_region: reg, n }; }))}`;
    await tx`truncate public.places`;
    await insertChunks(tx, "places", places);
    await tx`truncate public.rail_pairs`;
    await insertChunks(tx, "rail_pairs", pairs, 200);
    if (cerLines.size) { await tx`truncate public.cercanias_lines`; await insertChunks(tx, "cercanias_lines", [...cerLines.values()], 20); }
    await tx`insert into public.meta (key, value) values ('gtfs_loaded_at', ${new Date().toISOString()}) on conflict (key) do update set value = excluded.value`;
    await tx`insert into public.source_status (name, ok, at, tried_at, error, detail) values ('gtfs', true, now(), now(), null, ${tx.json({ stations: stations.length, trips: trips.length })})
      on conflict (name) do update set ok = true, at = now(), tried_at = now(), error = null, detail = excluded.detail`;
  });
  console.log(`  ${trips.length} trips (${cer.trips.size} Cercanías), ${stopTimes.length} stop times, ${stations.length} stations, ${places.length} places, ${pairs.length} rail pairs`);
  return { lines };
}

// ---------------------------------------------------------------------------------------------------
async function syncStatic(lines) {
  console.log("Static data → R2");
  if (!gtfs.loadedAt) await loadGtfs();
  lines ??= await fetchCercaniasLines().catch(() => null);
  const rail = JSON.parse(fs.readFileSync(path.join(ROOT, "assets", "rail.json"), "utf8"));
  await put("static/base.json", JSON.stringify(baseConfig(60)));
  await put("static/red.json", JSON.stringify(railSegments()));
  await put("static/tierra.json", JSON.stringify(land()));
  if (lines) await put("static/red-cercanias.json", JSON.stringify(cercaniasLines(lines.geo)));
  await put("static/rail-graph.json", JSON.stringify({ attribution: rail.attribution, v: rail.graph.v, e: rail.graph.e }));
}

// ---------------------------------------------------------------------------------------------------
// Postgres rows → the SQLite-style rows FORMAT[*].row expects (epoch ms, 0/1, "YYYY-MM-DD").
const EXPORT_SQL = {
  recorridos: (a, b) => sql`select service_date::text, network, train, product, type, origin, dest, dest_region, line_key, sched_dep, sched_arr,
      (extract(epoch from first_seen) * 1000)::bigint as first_seen, (extract(epoch from last_seen) * 1000)::bigint as last_seen,
      samples, delay_sum, max_delay, last_delay, final_delay, max_kmh, cancelled::int as cancelled, finished::int as finished
    from public.train_runs where service_date between ${a} and ${b} order by service_date, network, train`,
  lineas: (a, b) => sql`select service_date::text, network, type, line_key, dest_region, runs, cancelled, late5, late15, delay_sum, max_delay, max_kmh, b0, b1, b2, b3, b4, b5
    from public.daily_line_stats where service_date between ${a} and ${b} order by service_date, network, type, line_key`,
  incidencias: (a, b) => sql`select id, source, level, major::int as major, title, body, scope,
      (extract(epoch from first_seen) * 1000)::bigint as first_seen, (extract(epoch from last_seen) * 1000)::bigint as last_seen
    from public.incidents where source <> 'renfe' and (first_seen at time zone 'Europe/Madrid')::date between ${a} and ${b} order by first_seen`,
  proximidad: (a, b) => sql`select (extract(epoch from ts) * 1000)::bigint as ts, train_a, train_b, dist_m, required_m, kmh_a, kmh_b, lat, lon
    from public.proximity_events where (ts at time zone 'Europe/Madrid')::date between ${a} and ${b} order by ts`,
  horas: (a, b) => sql`select to_char(hour at time zone 'Europe/Madrid', 'YYYY-MM-DD"T"HH24') as hour, type, cycles, obs, delay_sum, delayed5, delayed15
    from public.hourly_stats where (hour at time zone 'Europe/Madrid')::date between ${a} and ${b} order by hour, type`,
};
const RANGE_SQL = {
  recorridos: sql`select min(service_date)::text as a, max(service_date)::text as b from public.train_runs`,
  lineas: sql`select min(service_date)::text as a, max(service_date)::text as b from public.daily_line_stats`,
  incidencias: sql`select min((first_seen at time zone 'Europe/Madrid')::date)::text as a, max((first_seen at time zone 'Europe/Madrid')::date)::text as b from public.incidents where source <> 'renfe'`,
  proximidad: sql`select min((ts at time zone 'Europe/Madrid')::date)::text as a, max((ts at time zone 'Europe/Madrid')::date)::text as b from public.proximity_events`,
  horas: sql`select min((hour at time zone 'Europe/Madrid')::date)::text as a, max((hour at time zone 'Europe/Madrid')::date)::text as b from public.hourly_stats`,
};
const monthsBetween = (a, b) => { const out = []; let [y, m] = a.split("-").map(Number); const [yb, mb] = b.split("-").map(Number); while (y < yb || (y === yb && m <= mb)) { out.push(`${y}-${String(m).padStart(2, "0")}`); if (++m > 12) { m = 1; y++; } } return out; };
const monthEnd = (ym) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

async function syncExports() {
  console.log("Monthly exports → R2");
  if (r2) {
    const bytes = await bucketBytes();
    console.log(`  bucket size ${(bytes / 1e6).toFixed(1)} MB`);
    if (bytes > R2_STORAGE_BUDGET) { console.warn(`  bucket above ${R2_STORAGE_BUDGET / 1e9} GB: skipping download files to stay in the free plan`); return; }
  }
  if (!gtfs.loadedAt) await loadGtfs(); // station names for the CSVs
  const today = madridDate(), yesterday = madridDate(new Date(Date.now() - 86400_000));
  const thisMonth = today.slice(0, 7), lastMonth = madridDate(new Date(Date.now() - 32 * 86400_000)).slice(0, 7);
  const index = { modo: "mensual", formatos: ["csv"], generado: new Date().toISOString(), hasta: yesterday };
  let previous = [];
  try { const r = await r2?.fetch(`${R2_URL}/exports/index.json`); if (r?.ok) previous = (await r.json()).datasets || []; } catch {}
  const prev = new Map(previous.map((d) => [d.id, d]));
  const datasets = [];
  for (const id of Object.keys(FORMAT)) {
    const [{ a, b }] = await RANGE_SQL[id];
    const old = new Map((prev.get(id)?.meses || []).map((m) => [m.mes, m]));
    const meses = [];
    if (a) for (const ym of monthsBetween(a.slice(0, 7), (b < yesterday ? b : yesterday).slice(0, 7))) {
      // rebuild the current and previous month every night (and everything with --all-months)
      if (!args.includes("--all-months") && ym !== thisMonth && ym !== lastMonth && old.has(ym)) { meses.push(old.get(ym)); continue; }
      const end = monthEnd(ym) < yesterday ? monthEnd(ym) : yesterday;
      const rows = await EXPORT_SQL[id](`${ym}-01`, end);
      let csv = csvHeader(id);
      for (const r of rows) csv += csvLine(id, r);
      await put(`exports/${id}/${ym}.csv`, csv, "text/csv; charset=utf-8");
      meses.push({ mes: ym, filas: rows.length, bytes: Buffer.byteLength(csv) });
    }
    datasets.push({ id, nombre: FORMAT[id].nombre, descripcion: FORMAT[id].descripcion, columnas: COLS[id], filtros: [],
      desde: meses.length ? `${meses[0].mes}-01` : null, hasta: meses.length ? (b < yesterday ? b : yesterday) : null,
      filasAprox: meses.reduce((s, m) => s + m.filas, 0), meses });
  }
  await put("exports/index.json", JSON.stringify({ ...index, datasets }));
}

// ---------------------------------------------------------------------------------------------------
try {
  let lines = null;
  if (want("gtfs")) ({ lines } = await syncGtfs());
  if (want("static")) await syncStatic(lines);
  if (want("exports")) await syncExports();
  console.log("done");
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
