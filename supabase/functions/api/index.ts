// API (Supabase Edge Function): train page, station boards, search, stats, punctuality, incidents, sources.
// Port of server/index.js + server/stats.js against Postgres. Cloudflare's Pages Function forwards
// /api/<route> here; /api/estado and static data come from R2 instead (see functions/api/[[path]].js).
import {
  sql, json, stations, shortName, lineKey, pathForStops, haversineKm, madridDate, madridMinutes, hhmm, normTrain, normCode, norm,
  productName, typeOf, fetchSalidas, TYPES, WINDOWS, DELAY, type Station,
} from "../_shared/core.ts";

const REGIONS = ["01", "02", "03", "06", "07", "08", "09", "10", "11", "12", "13", "14", "15", "16", "17"];
const parseId = (raw: string) => { const s = String(raw || "").trim().toLowerCase(); const network = s.startsWith("c") ? "cer" : "ld"; const n = normTrain(s); return { network, n, id: network === "cer" ? "c" + n : n }; };
const round1 = (x: number | null | undefined) => (x == null || Number.isNaN(x) ? null : Math.round(x * 10) / 10);
const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : null);
const num = (x: unknown) => (x == null ? 0 : Number(x));

async function punctuality(network: string, n: string) {
  const [r] = await sql`select public.train_punctuality(${network}, ${n}, 30) as p`;
  const p = r?.p || {};
  return p.dias ? p : { dias: 0 };
}
async function liveTrain(id: string) {
  const [r] = await sql`select extra from public.live_trains where id = ${id} and last_seen > now() - interval '5 minutes'`;
  return r ? { ...(r.extra.t || {}), tripId: r.extra.trip } : null;
}
async function liveProximity(id: string) {
  const [r] = await sql`select payload->'proximidad' as p from public.live_state where id = 1`;
  return ((r?.p || []) as { follower: string; leader: string }[]).filter((p) => p.follower === id || p.leader === id);
}
const stopsOut = (st: Map<string, Station>, stops: { station: string; arr_min: number | null; dep_min: number | null }[], delay: number, passedIdx: number, live: Record<string, unknown> | null) =>
  stops.map((s, i) => {
    const t = i === 0 ? s.dep_min : s.arr_min;
    return {
      code: s.station, n: shortName(st, s.station), full: st.get(s.station)?.name, lat: st.get(s.station)?.lat, lon: st.get(s.station)?.lon,
      arr: hhmm(s.arr_min), dep: hhmm(s.dep_min), est: hhmm(t == null ? null : t + Math.max(0, delay)),
      estado: i <= passedIdx ? "pasado" : live && (s.station === live.sig || (live.ant === live.sig && s.station === live.ant)) ? "siguiente" : "pendiente",
    };
  });

// ---------------------------------------------------------------------------------------------------
async function tren(rawId: string) {
  const { network, n, id } = parseId(rawId);
  if (n === "00000") return json({ error: "Número de tren no válido" }, 400);
  const st = await stations();
  const today = madridDate(), nowMin = madridMinutes();
  const live = await liveTrain(id) as Record<string, any> | null;
  const since = madridDate(new Date(Date.now() - 30 * 86400_000));
  const history = await sql`select service_date::text, coalesce(final_delay, last_delay) as delay, max_delay, cancelled::int as cancelled, finished::int as finished, max_kmh
    from public.train_runs where network = ${network} and train = ${n} and service_date >= ${since} order by service_date desc`;
  const base = { id, n, red: network, proximidad: await liveProximity(id), historial: { ...(await punctuality(network, n)), dias_detalle: history } };

  const [trip] = network === "cer"
    ? await sql`select trip_id, product, route_name, line, shape_id from public.gtfs_trips where network = 'cer' and (trip_id = ${live?.tripId ?? ""} or (train = ${n} and run_date = ${today}))
        order by (trip_id = ${live?.tripId ?? ""}) desc limit 1`
    : await sql`select trip_id, product, route_name, null as line, null as shape_id from public.gtfs_trips where network = 'ld' and train = ${n} and public.runs_on(service_id, ${today}) limit 1`;
  const stops = trip ? await sql<{ station: string; arr_min: number | null; dep_min: number | null }[]>`select station, arr_min, dep_min from public.gtfs_stop_times where trip_id = ${trip.trip_id} order by seq` : [];
  const delay = live?.ret ?? 0;
  const cancelled = network === "ld" && (await sql`select 1 from public.cancellations where service_date = ${today} and train = ${n} limit 1`).length > 0;
  let status: string;
  if (live) status = "circulando";
  else if (cancelled) status = "cancelado";
  else if (!stops.length) status = network === "ld" && (await sql`select 1 from public.gtfs_trips where network = 'ld' and train = ${n} limit 1`).length ? "no-circula-hoy" : history.some((h) => h.service_date === today) ? "finalizado" : "desconocido";
  else if (nowMin < (stops[0].dep_min ?? 0)) status = "programado";
  else if (nowMin > (stops.at(-1)!.arr_min ?? 0) + (network === "cer" ? 15 : 30)) status = "finalizado";
  else status = "sin-posicion";
  let passedIdx = -1;
  if (stops.length && live) { const i = stops.findIndex((s) => s.station === live.ant); passedIdx = live.ant === live.sig ? i - 1 : i; }
  else if (stops.length) passedIdx = stops.reduce((acc, s, i) => ((s.dep_min ?? s.arr_min ?? 0) + delay < nowMin ? i : acc), -1);
  const codes = stops.map((s) => s.station);
  const linea = network === "cer" ? (live ? `${live.nucleo} ${live.linea}` : trip?.line ?? null) : codes.length ? lineKey(st, codes[0], codes.at(-1)!) : live ? lineKey(st, live.ori, live.des) : null;
  let ruta: [number, number][] = [];
  if (network === "ld" && codes.length) ruta = await pathForStops(st, codes);
  if (network === "cer" && trip?.shape_id) {
    const [s] = await sql`select points from public.gtfs_shapes where shape_id = ${trip.shape_id}`;
    const shape = (s?.points || []) as [number, number][];
    const near = (code: string) => { const x = st.get(code); if (!x) return -1; let bi = 0, bd = Infinity; shape.forEach(([a, b], i) => { const d = (a - x.lat) ** 2 + (b - x.lon) ** 2; if (d < bd) { bd = d; bi = i; } }); return bi; };
    const a = near(codes[0]), b = near(codes.at(-1)!);
    ruta = a < 0 || b < 0 || a === b ? shape : a < b ? shape.slice(a, b + 1) : shape.slice(b, a + 1).reverse();
  }
  const product = live?.p ?? trip?.product ?? null;
  const incidencias = network === "ld" ? (await sql`select id, source, level, major, title, body, scope, path, trains, first_seen from public.incidents
      where active and (${n} = any(coalesce(trains, '{}')) or scope = ${linea ?? ""})`).map((i) => ({ ...i, text: (i.body || "").split("\n"), seen: +new Date(i.first_seen) })) : [];
  return json({
    ...base, product, nom: network === "cer" ? (live?.nom || (trip ? `Cercanías ${trip.line}` : "Cercanías")) : product != null ? productName(product) : trip?.route_name || "Tren",
    tipo: network === "cer" ? "cer" : product != null ? typeOf(product) : null, status, delay,
    live: live && { ...live, line: live.linea, nucleoName: live.nucleo, antN: shortName(st, live.ant), sigN: shortName(st, live.sig) },
    origen: codes.length ? shortName(st, codes[0]) : live && shortName(st, live.ori), destino: codes.length ? shortName(st, codes.at(-1)!) : live && shortName(st, live.des),
    linea, stops: stopsOut(st, stops, delay, passedIdx, live), ruta, incidencias,
  });
}

// ---------------------------------------------------------------------------------------------------
const salidasCache = new Map<string, { at: number; rows: Awaited<ReturnType<typeof fetchSalidas>>; error?: string | null }>();
async function estacion(rawCode: string, tipo: string) {
  const code = normCode(rawCode);
  const st = await stations();
  const s = st.get(code);
  if (!s) return json({ error: "Estación desconocida" }, 404);
  const kind = tipo === "llegadas" ? "llegadas" : "salidas";
  const now = madridMinutes(), today = madridDate(), yday = madridDate(new Date(Date.now() - 86400_000));
  const tt = await sql`select train, trip_id, product, route_name, sched_min, other_station, service_date::text as day from public.station_timetable(${code}, ${kind}, ${now - 30}, ${now + 180})`;
  const trains = [...new Set(tt.map((r) => r.train))];
  const lives = trains.length ? await sql`select train, delay_min, prev_station, next_station, extra->>'trip' as trip from public.live_trains where network = 'ld' and train = any(${trains}) and last_seen > now() - interval '5 minutes'` : [];
  const liveBy = new Map(lives.map((l) => [l.train, l]));
  const canc = new Set((await sql`select train || '|' || service_date::text as k from public.cancellations where service_date in (${today}, ${yday})`).map((r) => r.k));
  const seqs = tt.length ? await sql`select trip_id, station, seq from public.gtfs_stop_times where trip_id = any(${tt.map((r) => r.trip_id)}) and (station = ${code} or station = any(${lives.map((l) => l.prev_station)}))` : [];
  const seqOf = (trip: string, station: string) => seqs.find((x) => x.trip_id === trip && x.station === station)?.seq;
  const rows: Record<string, unknown>[] = [];
  for (const r of tt) {
    const live = liveBy.get(r.train), cancelled = canc.has(`${r.train}|${r.day}`);
    const isLive = !!live && (!live.trip || live.trip === r.trip_id);
    const delay = isLive ? live!.delay_min : null;
    let estado = cancelled ? "cancelado" : isLive ? "circulando" : "programado";
    if (isLive) {
      const a = seqOf(r.trip_id, live!.prev_station), me = seqOf(r.trip_id, code);
      if (a != null && me != null && (a > me || (a === me && live!.prev_station !== live!.next_station && kind === "salidas"))) estado = kind === "salidas" ? "salido" : "llegado";
    }
    const est = r.sched_min + Math.max(0, delay || 0);
    if (est < now - (estado === "programado" ? 5 : 10)) continue;
    rows.push({ red: "ld", id: r.train, n: r.train, nom: r.product != null ? productName(r.product) : r.route_name, hora: hhmm(r.sched_min), est: delay ? hhmm(est) : null,
      retraso: delay, min: est, otro: shortName(st, r.other_station), via: null, estado });
  }
  let cer: { rows: Awaited<ReturnType<typeof fetchSalidas>>; error?: string | null } = { rows: [] };
  if (kind === "salidas") {
    const c = salidasCache.get(code);
    if (c && Date.now() - c.at < 30_000) cer = c;
    else {
      try { cer = { rows: await fetchSalidas(code) }; } catch (e) { cer = { rows: [], error: (e as { status?: number }).status === 404 ? null : String((e as Error).message) }; }
      salidasCache.set(code, { at: Date.now(), ...cer });
    }
    const liveCer = new Set((await sql`select id from public.live_trains where network = 'cer' and last_seen > now() - interval '5 minutes'`).map((r) => r.id));
    for (const r of cer.rows) {
      const toM = (x: string | null) => (x ? Number(x.slice(0, 2)) * 60 + Number(x.slice(3)) : null);
      const p = toM(r.planned), e = toM(r.real) ?? p;
      if (p == null) continue;
      let min = e!; if (min < now - 600) min += 1440;
      const delay = e != null ? ((((e - p) % 1440) + 1440 + 720) % 1440) - 720 : null;
      rows.push({ red: "cer", id: "c" + r.train, n: r.train, nom: `Cercanías ${r.line || ""}`.trim(), linea: r.line, hora: r.planned, est: delay ? r.real : null,
        retraso: delay, min, otro: r.destName || shortName(st, r.dest), via: r.platform, estado: liveCer.has("c" + r.train) ? "circulando" : "programado" });
    }
  }
  rows.sort((a, b) => (a.min as number) - (b.min as number));
  return json({ code, nombre: s.name, region: s.region_name, lat: s.lat, lon: s.lon, tipo: kind,
    cercanias: kind === "salidas" ? (cer.rows.length ? "ok" : cer.error ? "error" : "sin-datos") : "no-disponible", filas: rows.slice(0, 60) });
}

// ---------------------------------------------------------------------------------------------------
async function buscar(raw: string) {
  raw = raw.trim().slice(0, 60);
  if (!raw) return json({ trenes: [], estaciones: [], lugares: [] });
  const st = await stations();
  const digits = raw.replace(/\D/g, "");
  const trenes: Record<string, unknown>[] = [];
  if (digits.length >= 2) {
    const want = digits.replace(/^0+/, ""), today = madridDate();
    const lives = await sql`select id, network, train, extra->'t' as t from public.live_trains where ltrim(train, '0') like ${want + "%"} and last_seen > now() - interval '5 minutes'
      order by (ltrim(train, '0') = ${want}) desc, train limit 15`;
    const sched = await sql`select distinct on (train) train, product, route_name,
        (select json_build_array(min(dep_min)) from public.gtfs_stop_times s where s.trip_id = t.trip_id) as dep,
        (select station from public.gtfs_stop_times s where s.trip_id = t.trip_id order by seq asc limit 1) as o,
        (select station from public.gtfs_stop_times s where s.trip_id = t.trip_id order by seq desc limit 1) as d,
        public.runs_on(service_id, ${today}) as hoy
      from public.gtfs_trips t where network = 'ld' and ltrim(train, '0') like ${want + "%"} order by train, public.runs_on(service_id, ${today}) desc limit 15`;
    const seen = new Set<string>();
    const add = async (id: string, network: string, n: string, l: Record<string, any> | null, s: Record<string, any> | null) => {
      if (seen.has(id) || trenes.length >= 15) return;
      seen.add(id);
      const p = l?.p ?? s?.product;
      trenes.push({ id, n, red: network, nom: l?.nom || (p != null ? productName(p) : s?.route_name || "Tren"), vivo: !!l, ret: l?.ret ?? null,
        ruta: s?.o ? `${shortName(st, s.o)} → ${shortName(st, s.d)}` : l ? `${shortName(st, l.ori)} → ${shortName(st, l.des)}` : null,
        sal: s?.hoy ? hhmm(s.dep?.[0]) : null, hoy: !!s?.hoy || !!l, puntualidad: await punctuality(network, n) });
    };
    const schedBy = new Map(sched.map((s) => [s.train, s]));
    for (const l of lives) await add(l.id, l.network, l.train, l.t, l.network === "ld" ? schedBy.get(l.train) ?? null : null);
    for (const s of sched) await add(s.train, "ld", s.train, null, s);
  }
  const q = norm(raw);
  const estaciones: Record<string, unknown>[] = [];
  let lugares: unknown[] = [];
  if (q.replace(/\d/g, "").trim().length >= 3) {
    const hits = [...st.values()].filter((s) => norm(s.name).includes(q)).sort((a, b) => a.name.length - b.name.length).slice(0, 8);
    for (const s of hits) estaciones.push({ code: s.code, n: s.name, reg: s.region_name, lat: s.lat, lon: s.lon, ahora: 0 });
    if (!(digits.length >= 2 && digits.length === raw.replace(/\s/g, "").length))
      lugares = [...await sql`select name as n, province as prov, lat, lon from public.places where name_norm like ${"%" + q + "%"}
        order by (name_norm like ${q + "%"}) desc, length(name_norm) limit 6`];
  }
  return json({ trenes, estaciones, lugares });
}

// ---------------------------------------------------------------------------------------------------
function rankLines(L: { line: string; runs: number; avgDelay: number | null; pctLate: number | null }[], min = 1) {
  const okL = L.filter((l) => l.runs >= min);
  return {
    worstDelay: [...okL].sort((a, b) => (b.avgDelay ?? 0) - (a.avgDelay ?? 0)).slice(0, 10),
    mostPunctual: [...okL].filter((l) => l.runs >= Math.max(min, 2)).sort((a, b) => (a.pctLate ?? 0) - (b.pctLate ?? 0) || (a.avgDelay ?? 0) - (b.avgDelay ?? 0)).slice(0, 10),
    mostTrains: [...L].sort((a, b) => b.runs - a.runs).slice(0, 10),
    fewestTrains: [...L].sort((a, b) => a.runs - b.runs).slice(0, 10),
  };
}
const BUCKETS = ["En hora", "1–4", "5–14", "15–29", "30–59", "60+"];

async function stats(w: string, types: string[], region: string | null) {
  const now = Date.now(), today = madridDate();
  const [m] = await sql`select value from public.meta where key = 'collecting_since'`;
  const since = m ? Number(m.value) : null;
  const coverage: Record<string, unknown> = { since: since ? new Date(since).toISOString() : null };
  const tf = (alias = "") => sql`${types.length ? sql`and ${sql(alias + "type")} = any(${types})` : sql``} ${region ? sql`and ${sql(alias + "dest_region")} = ${region}` : sql``}`;

  if (w === "now") {
    const lives = (await sql`select extra->'t' as t from public.live_trains where last_seen > now() - interval '5 minutes'`).map((r) => r.t)
      .filter((t) => (!types.length || types.includes(t.tipo)) && (!region || t.dreg === region));
    const st = await stations();
    const delays = lives.map((t) => Math.max(0, t.ret)).sort((a, b) => a - b);
    const lines = new Map<string, { line: string; runs: number; sum: number; late: number }>(), byType = new Map<string, { type: string; runs: number; sum: number; late: number }>();
    for (const t of lives) {
      const k = t.red === "cer" ? `${t.nucleo} ${t.linea}` : lineKey(st, t.ori, t.des);
      const l = lines.get(k) || { line: k, runs: 0, sum: 0, late: 0 }; l.runs++; l.sum += Math.max(0, t.ret); if (t.ret >= DELAY.leve) l.late++; lines.set(k, l);
      const x = byType.get(t.tipo) || { type: t.tipo, runs: 0, sum: 0, late: 0 }; x.runs++; x.sum += Math.max(0, t.ret); if (t.ret >= DELAY.leve) x.late++; byType.set(t.tipo, x);
    }
    const speeds = lives.map((t) => t.kmh).filter((x) => x != null && x >= 4);
    const [c] = await sql`select count(distinct train)::int as n from public.cancellations where service_date = ${today}`;
    const [inc] = await sql`select count(*)::int as n from public.incidents where active and source <> 'renfe'`;
    const [px] = await sql`select jsonb_array_length(coalesce(payload->'proximidad', '[]')) as n from public.live_state where id = 1`;
    return json({ window: w, coverage, series: [],
      kpis: { trains: lives.length, avgDelay: round1(delays.reduce((a, b) => a + b, 0) / (delays.length || 1)), medianDelay: delays.length ? delays[Math.floor(delays.length / 2)] : null,
        pctLate5: pct(lives.filter((t) => t.ret >= 5).length, lives.length), pctLate15: pct(lives.filter((t) => t.ret >= 15).length, lives.length),
        cancelled: !types.length || types.some((t) => t !== "cer") ? c.n : 0, incidents: inc.n, maxKmh: speeds.length ? Math.max(...speeds) : null,
        avgKmh: speeds.length ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length) : null, proximity: px?.n ?? 0 },
      distribution: BUCKETS.map((label, i) => ({ label, n: lives.filter((t) => [t.ret <= 0, t.ret >= 1 && t.ret <= 4, t.ret >= 5 && t.ret <= 14, t.ret >= 15 && t.ret <= 29, t.ret >= 30 && t.ret <= 59, t.ret >= 60][i]).length })),
      byType: [...byType.values()].map((x) => ({ type: x.type, runs: x.runs, avgDelay: round1(x.sum / x.runs), pctLate: pct(x.late, x.runs) })),
      lines: rankLines([...lines.values()].map((l) => ({ line: l.line, runs: l.runs, avgDelay: round1(l.sum / l.runs), pctLate: pct(l.late, l.runs) }))),
      worstTrains: [...lives].sort((a, b) => b.ret - a.ret).slice(0, 10).map((t) => ({ train: t.n, id: t.id, type: t.tipo, line: t.red === "cer" ? `${t.nucleo} ${t.linea}` : lineKey(st, t.ori, t.des), delay: t.ret, date: today })),
    });
  }

  const days = WINDOWS[w];
  const startMs = w === "YTD" ? Date.parse(`${today.slice(0, 4)}-01-01T00:00:00+01:00`) : now - (days as number) * 86400_000;
  const start = new Date(startMs), startDate = w === "YTD" ? `${today.slice(0, 4)}-01-01` : madridDate(start);
  const windowDays = (now - startMs) / 86400_000;
  const coveredDays = since ? Math.min(windowDays, (now - Math.max(since, startMs)) / 86400_000) : 0;
  const nDays = Math.max(1, Math.round(coveredDays));
  coverage.days = round1(coveredDays);
  const short = days != null && days <= 7;

  // per-line rows for the window: short = train_runs directly; long = daily_line_stats + today's runs aggregated on the fly
  const agg = (where: ReturnType<typeof sql>) => sql`
    select service_date::text, coalesce(type, '') as type, coalesce(line_key, '') as line_key,
      count(*) filter (where not cancelled)::int as runs, count(*) filter (where cancelled)::int as cancelled,
      count(*) filter (where not cancelled and coalesce(final_delay, last_delay) >= 5)::int as late5,
      count(*) filter (where not cancelled and coalesce(final_delay, last_delay) >= 15)::int as late15,
      coalesce(sum(greatest(coalesce(final_delay, last_delay, 0), 0)) filter (where not cancelled), 0)::int as delay_sum,
      max(max_kmh) as max_kmh,
      count(*) filter (where not cancelled and coalesce(final_delay, last_delay) <= 0)::int as b0,
      count(*) filter (where not cancelled and coalesce(final_delay, last_delay) between 1 and 4)::int as b1,
      count(*) filter (where not cancelled and coalesce(final_delay, last_delay) between 5 and 14)::int as b2,
      count(*) filter (where not cancelled and coalesce(final_delay, last_delay) between 15 and 29)::int as b3,
      count(*) filter (where not cancelled and coalesce(final_delay, last_delay) between 30 and 59)::int as b4,
      count(*) filter (where not cancelled and coalesce(final_delay, last_delay) >= 60)::int as b5
    from public.train_runs where ${where} and (cancelled or last_delay is not null) ${tf()}
    group by service_date, coalesce(type, ''), coalesce(line_key, '')`;
  const rows = short
    ? await agg(sql`((not cancelled and last_seen >= ${start}) or (cancelled and ((service_date::timestamp + make_interval(mins => coalesce(sched_dep, 0)::int)) at time zone 'Europe/Madrid') between ${start} and now()))`)
    : [...await sql`select service_date::text, type, line_key, runs, cancelled, late5, late15, delay_sum, max_kmh, b0, b1, b2, b3, b4, b5 from public.daily_line_stats
        where service_date >= ${startDate} and service_date < ${today} ${tf()}`, ...await agg(sql`service_date = ${today}`)];
  const sum = (k: string) => rows.reduce((a, r) => a + num(r[k]), 0);
  const runs = sum("runs"), cancelled = sum("cancelled"), late5 = sum("late5"), late15 = sum("late15"), delaySum = sum("delay_sum");
  const group = (key: string) => {
    const g = new Map<string, { k: string; runs: number; sum: number; late: number }>();
    for (const r of rows) { const k = r[key]; if (!k) continue; const x = g.get(k) || { k, runs: 0, sum: 0, late: 0 }; x.runs += num(r.runs); x.sum += num(r.delay_sum); x.late += num(r.late5); g.set(k, x); }
    return [...g.values()].filter((x) => x.runs);
  };
  const byDay = new Map<string, { runs: number; sum: number; late: number; cancelled: number }>();
  for (const r of rows) { const x = byDay.get(r.service_date) || { runs: 0, sum: 0, late: 0, cancelled: 0 }; x.runs += num(r.runs); x.sum += num(r.delay_sum); x.late += num(r.late5); x.cancelled += num(r.cancelled); byDay.set(r.service_date, x); }

  const [med] = short ? await sql`select percentile_disc(0.5) within group (order by greatest(coalesce(final_delay, last_delay), 0)) as m from public.train_runs
      where not cancelled and last_delay is not null and last_seen >= ${start} ${tf()}` : [{ m: null }];
  const [sch] = await sql`select coalesce(sum(n), 0)::int as n, count(distinct service_date)::int as d from public.scheduled_days where service_date >= ${startDate}
      ${types.length ? sql`and type = any(${types})` : sql``} ${region ? sql`and dest_region = ${region}` : sql``}`;
  const inc = await sql`select level, count(*)::int as n from public.incidents where first_seen >= ${start} and source <> 'renfe' group by level`;
  const [px] = await sql`select count(*)::int as n from public.proximity_events where ts >= ${start}`;
  const worst = await sql`select train, network, type, line_key, max_delay, service_date::text from public.train_runs
      where service_date >= ${startDate} and not cancelled and max_delay is not null ${tf()} order by max_delay desc limit 10`;
  const often = await sql`select train, network, max(type) as type, max(line_key) as line_key, count(*)::int as runs,
        count(*) filter (where coalesce(final_delay, last_delay) >= 5)::int as late, avg(greatest(coalesce(final_delay, last_delay), 0)) as avg
      from public.train_runs where service_date >= ${startDate} and not cancelled and last_delay is not null ${tf()}
      group by network, train having count(*) >= 2 order by count(*) filter (where coalesce(final_delay, last_delay) >= 5)::float / count(*) desc, avg desc limit 10`;
  const hod = await sql`select extract(hour from hour at time zone 'Europe/Madrid')::int as h, avg(t)::float as avg from (
        select hour, sum(obs::float / cycles) as t from public.hourly_stats where hour >= ${start} ${types.length ? sql`and type = any(${types})` : sql``} group by hour) x
      group by 1 order by 1`;
  let series;
  if (short) {
    const pts = await sql`select date_trunc('hour', ts) as h, avg(trains)::float as trains, sum(delayed5)::int as d5, sum(trains)::int as tr, sum(delay_sum)::int as s
        from (select ts, sum(trains) as trains, sum(delayed5) as delayed5, sum(delay_sum) as delay_sum from public.snapshots where ts >= ${start}
          ${types.length ? sql`and type = any(${types})` : sql``} ${region ? sql`and region = ${region}` : sql``} group by ts) x group by 1 order by 1`;
    series = { step: "hour", points: pts.map((p) => ({ t: +new Date(p.h), trains: Math.round(p.trains), avgDelay: round1(p.s / (p.tr || 1)), pctLate: pct(p.d5, p.tr) })) };
  } else series = { step: "day", points: [...byDay].sort().map(([d, x]) => ({ t: Date.parse(d + "T12:00:00Z"), trains: x.runs, avgDelay: round1(x.sum / (x.runs || 1)), pctLate: pct(x.late, x.runs), cancelled: x.cancelled })) };
  // deno-lint-ignore no-explicit-any
  const idOf = (r: any) => (r.network === "cer" ? "c" + r.train : r.train);

  return json({
    window: w, coverage,
    kpis: {
      runs, perDay: coveredDays >= 1 ? round1(runs / coveredDays) : null, scheduledPerDay: sch.d ? round1(sch.n / sch.d) : null,
      avgDelay: round1(delaySum / (runs || 1)), medianDelay: med?.m ?? null, pctLate5: pct(late5, runs), pctLate15: pct(late15, runs),
      cancelled, availability: runs + cancelled ? pct(runs, runs + cancelled) : null,
      incidents: inc.reduce((a, b) => a + b.n, 0), incidentsByLevel: Object.fromEntries(inc.map((x) => [x.level, x.n])),
      maxKmh: rows.length ? Math.round(Math.max(0, ...rows.map((r) => num(r.max_kmh)))) || null : null, proximity: px.n,
    },
    distribution: BUCKETS.map((label, i) => ({ label, n: sum("b" + i) })),
    byType: group("type").map((x) => ({ type: x.k, runs: x.runs, avgDelay: round1(x.sum / x.runs), pctLate: pct(x.late, x.runs) })),
    lines: rankLines(group("line_key").map((x) => ({ line: x.k, runs: x.runs, perDay: round1(x.runs / nDays), avgDelay: round1(x.sum / x.runs), pctLate: pct(x.late, x.runs) })), Math.min(3, nDays)),
    worstTrains: worst.map((r) => ({ train: r.train, id: idOf(r), type: r.type, line: r.line_key, delay: r.max_delay, date: r.service_date })),
    oftenLate: often.map((r) => ({ train: r.train, id: idOf(r), type: r.type, line: r.line_key, runs: r.runs, late: r.late, pctLate: pct(r.late, r.runs), avgDelay: round1(r.avg) })),
    busiestHours: hod.map((x) => ({ h: x.h, avg: Math.round(x.avg) })),
    series,
  });
}

// ---------------------------------------------------------------------------------------------------
async function incidencias() {
  const inc = await sql`select id, source, level, major, title, body, scope, path, trains, first_seen from public.incidents where active and source <> 'renfe'
      order by case level when 'grave' then 0 when 'leve' then 1 else 2 end, first_seen desc`;
  const [n] = await sql`select value from public.meta where key = 'renfe_notices'`;
  const src = await sql`select name, ok, at, tried_at, error, detail from public.source_status where name in ('adif', 'renfeAlerts')`;
  return json({
    incidencias: inc.map((i) => ({ id: i.id, source: i.source, level: i.level, major: i.major, title: i.title, text: (i.body || "").split("\n").filter(Boolean), scope: i.scope, path: i.path, trains: i.trains, seen: +new Date(i.first_seen) })),
    avisosRenfe: n ? JSON.parse(n.value) : [],
    fuentes: Object.fromEntries(src.map((s) => [s.name, { ok: s.ok, at: s.at, triedAt: s.tried_at, error: s.error, ...(s.detail || {}) }])),
  }, 200, "public, max-age=30");
}

async function fuentes() {
  const src = await sql`select name, ok, at, tried_at, error, detail from public.source_status`;
  const [g] = await sql`select value from public.meta where key = 'gtfs_loaded_at'`;
  const [c] = await sql`select (select count(*) from public.stations)::int as est, (select count(*) from public.gtfs_trips)::int as trips`;
  return json({ fuentes: Object.fromEntries(src.map((s) => [s.name, { ok: s.ok, at: s.at, triedAt: s.tried_at, error: s.error, ...(s.detail || {}) }])),
    gtfs: { cargado: g?.value ?? null, estaciones: c.est, viajes: c.trips } }, 200, "public, max-age=30");
}

// ---------------------------------------------------------------------------------------------------
// Seconds each route may be cached (browser and the Cloudflare Pages Function) when the handler doesn't set
// its own Cache-Control. The collector writes once a minute, so nothing here is fresher than that anyway.
const TTL: Record<string, number> = { tren: 20, estacion: 30, buscar: 300, stats: 60, puntualidad: 300, incidencias: 30, fuentes: 30 };

async function route(parts: string[], q: URLSearchParams) {
  switch (parts[0]) {
    case "tren": return await tren(parts[1] || "");
    case "estacion": return await estacion(parts[1] || "", q.get("tipo") || "salidas");
    case "buscar": return await buscar(q.get("q") || "");
    case "stats": {
      const w = q.get("w") && WINDOWS[q.get("w")!] !== undefined ? q.get("w")! : "1D";
      const types = String(q.get("tipos") || "").split(",").filter((t) => TYPES.some((x) => x.id === t && !x.noData));
      const region = REGIONS.includes(q.get("region") || "") ? q.get("region") : null;
      return await stats(w, types, region);
    }
    case "puntualidad": { const { network, n } = parseId(parts[1] || ""); return json(await punctuality(network, n), 200, "public, max-age=300"); }
    case "incidencias": return await incidencias();
    case "fuentes": return await fuentes();
    default: return json({ error: "Ruta desconocida" }, 404);
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/(functions\/v1\/)?api\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  try {
    const res = await route(parts, url.searchParams);
    if (res.status === 200 && res.headers.get("Cache-Control") === "no-store" && TTL[parts[0]]) res.headers.set("Cache-Control", `public, max-age=${TTL[parts[0]]}`);
    return res;
  } catch (e) {
    console.error(parts.join("/"), e); // detail stays in the logs; clients get a generic message
    return json({ error: "Error interno" }, 500);
  }
});
