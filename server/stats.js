// Statistics for the Estadísticas tab. Window → table mapping in docs/requirements.md §3.
import { db, meta, AGG_SQL } from "./db.js";
import { DELAY } from "./config.js";
import { madridDate } from "./sources/gtfs-static.js";
import { state, cancelledOn } from "./state.js";

export const WINDOWS = { now: 0, "1D": 1, "7D": 7, "1M": 30, "3M": 91, "6M": 182, "1A": 365, YTD: null };

function windowStart(w, now = Date.now()) {
  if (w === "YTD") {
    const y = madridDate(new Date(now)).slice(0, 4);
    return { ms: Date.parse(`${y}-01-01T00:00:00+01:00`), date: `${y}-01-01` };
  }
  const ms = now - WINDOWS[w] * 86400_000;
  return { ms, date: madridDate(new Date(ms)) };
}

// epoch ms of 00:00 Europe/Madrid on a YYYY-MM-DD date (handles DST)
function madridMidnight(date) {
  const noon = new Date(date + "T12:00:00Z");
  const off = new Date(noon.toLocaleString("en-US", { timeZone: "Europe/Madrid" })) - new Date(noon.toLocaleString("en-US", { timeZone: "UTC" }));
  return Date.parse(date + "T00:00:00Z") - off;
}

const median = (arr) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const BUCKETS = [[-Infinity, 0, "En hora"], [1, 4, "1–4"], [5, 14, "5–14"], [15, 29, "15–29"], [30, 59, "30–59"], [60, Infinity, "60+"]];
const bucketize = (delays) => BUCKETS.map(([a, b, label]) => ({ label, n: delays.filter((d) => d >= a && d <= b).length }));

function filterSql(f, alias = "") {
  const p = alias ? alias + "." : "";
  const where = [], args = [];
  if (f.types?.length) { where.push(`${p}type IN (${f.types.map(() => "?").join(",")})`); args.push(...f.types); }
  if (f.region) { where.push(`${p}dest_region = ?`); args.push(f.region); }
  return { where, args };
}

/** Live window ("Ahora"), from memory. */
function liveStats(f) {
  const trains = [...state.trains.values()].filter((t) => (!f.types?.length || f.types.includes(t.type)) && (!f.region || t.destRegion === f.region));
  const delays = trains.map((t) => Math.max(0, t.ret));
  const lines = new Map();
  for (const t of trains) {
    const k = t.lineKey;
    const l = lines.get(k) || { line: k, runs: 0, sum: 0, late: 0 };
    l.runs++; l.sum += Math.max(0, t.ret); if (t.ret >= DELAY.leve) l.late++;
    lines.set(k, l);
  }
  const L = [...lines.values()].map((l) => ({ line: l.line, runs: l.runs, avgDelay: round1(l.sum / l.runs), pctLate: pct(l.late, l.runs) }));
  const byType = new Map();
  for (const t of trains) { const x = byType.get(t.type) || { type: t.type, runs: 0, sum: 0, late: 0 }; x.runs++; x.sum += Math.max(0, t.ret); if (t.ret >= DELAY.leve) x.late++; byType.set(t.type, x); }
  const speeds = trains.map((t) => t.kmh).filter((x) => x != null && x >= 4);
  // GTFS-RT cancellations exist only for LD/MD trains
  const cancelledToday = !f.types?.length || f.types.some((t) => t !== "cer") ? cancelledOn(madridDate()).length : 0;
  return {
    kpis: {
      trains: trains.length,
      avgDelay: round1(delays.reduce((a, b) => a + b, 0) / (delays.length || 1)),
      medianDelay: median(delays),
      pctLate5: pct(trains.filter((t) => t.ret >= DELAY.leve).length, trains.length),
      pctLate15: pct(trains.filter((t) => t.ret >= DELAY.grave).length, trains.length),
      cancelled: cancelledToday,
      incidents: state.incidents.adif.length + state.incidents.derived.length,
      maxKmh: speeds.length ? Math.max(...speeds) : null,
      avgKmh: speeds.length ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length) : null,
      proximity: state.proximity.length,
    },
    distribution: bucketize(trains.map((t) => t.ret)),
    byType: [...byType.values()].map((x) => ({ type: x.type, runs: x.runs, avgDelay: round1(x.sum / x.runs), pctLate: pct(x.late, x.runs) })),
    lines: rankLines(L),
    worstTrains: trains.sort((a, b) => b.ret - a.ret).slice(0, 10).map((t) => ({ train: t.n, id: t.id, type: t.type, line: t.lineKey, delay: t.ret, date: madridDate() })),
    series: [],
  };
}

function rankLines(L, min = 1) {
  const ok = L.filter((l) => l.runs >= min);
  return {
    worstDelay: [...ok].sort((a, b) => b.avgDelay - a.avgDelay).slice(0, 10),
    mostPunctual: [...ok].filter((l) => l.runs >= Math.max(min, 2)).sort((a, b) => a.pctLate - b.pctLate || a.avgDelay - b.avgDelay).slice(0, 10),
    mostTrains: [...L].sort((a, b) => b.runs - a.runs).slice(0, 10),
    fewestTrains: [...L].sort((a, b) => a.runs - b.runs).slice(0, 10),
  };
}

export function computeStats({ w = "1D", types = [], region = null } = {}) {
  const f = { types, region };
  const now = Date.now();
  const since = Number(meta.get("collecting_since")) || null;
  const coverage = { since: since ? new Date(since).toISOString() : null };
  if (w === "now") return { window: w, coverage, ...liveStats(f) };

  const start = windowStart(w, now);
  if (!(WINDOWS[w] && WINDOWS[w] <= 7)) return longStats(w, f, start, now, since, coverage);
  const { where, args } = filterSql(f);
  // runs seen in the window; cancelled runs count when their scheduled departure falls in the window
  const W = ["(last_seen >= ? OR service_date >= ?)", ...where], A = [start.ms, start.date, ...args];
  const rows = db.prepare(`SELECT train, network, type, line_key, service_date, cancelled, max_delay, max_kmh, sched_dep, last_seen,
      COALESCE(final_delay, last_delay) AS delay FROM train_runs WHERE ${W.join(" AND ")}`).all(...A);
  const runs = rows.filter((r) => {
    if (!r.cancelled) return r.last_seen >= start.ms;
    const t = madridMidnight(r.service_date) + (r.sched_dep ?? 0) * 60_000;
    return t >= start.ms && t <= now;
  });
  const ran = runs.filter((r) => !r.cancelled && r.delay != null);
  const cancelled = runs.filter((r) => r.cancelled).length;
  const delays = ran.map((r) => Math.max(0, r.delay));
  // days actually covered by collection inside this window (per-day figures need ≥ 1 full day)
  const windowDays = (now - start.ms) / 86400_000;
  const coveredDays = since ? Math.min(windowDays, (now - Math.max(since, start.ms)) / 86400_000) : 0;
  const days = Math.max(1, Math.round(coveredDays));

  const sch = filterSql(f);
  const scheduled = db.prepare(`SELECT COALESCE(SUM(n), 0) AS n, COUNT(DISTINCT service_date) AS d FROM scheduled_days WHERE ${["service_date >= ?", ...sch.where].join(" AND ")}`).get(start.date, ...sch.args);

  const incidents = db.prepare(`SELECT level, COUNT(*) AS n FROM incidents WHERE first_seen >= ? AND source != 'renfe' GROUP BY level`).all(start.ms);
  const proximity = db.prepare(`SELECT COUNT(*) AS n FROM proximity_events WHERE ts >= ?`).get(start.ms).n;

  // lines
  const lineMap = new Map();
  for (const r of ran) {
    const l = lineMap.get(r.line_key) || { line: r.line_key, runs: 0, sum: 0, late: 0 };
    l.runs++; l.sum += Math.max(0, r.delay); if (r.delay >= DELAY.leve) l.late++;
    lineMap.set(r.line_key, l);
  }
  const L = [...lineMap.values()].filter((l) => l.line).map((l) => ({ line: l.line, runs: l.runs, perDay: round1(l.runs / days), avgDelay: round1(l.sum / l.runs), pctLate: pct(l.late, l.runs) }));

  // types
  const typeMap = new Map();
  for (const r of ran) { const x = typeMap.get(r.type) || { type: r.type, runs: 0, sum: 0, late: 0 }; x.runs++; x.sum += Math.max(0, r.delay); if (r.delay >= DELAY.leve) x.late++; typeMap.set(r.type, x); }

  // trains most often late (≥ 2 runs)
  const trainMap = new Map();
  for (const r of ran) { const k = r.network + r.train; const x = trainMap.get(k) || { train: r.train, id: idOf(r), type: r.type, line: r.line_key, runs: 0, late: 0, sum: 0 }; x.runs++; x.sum += Math.max(0, r.delay); if (r.delay >= DELAY.leve) x.late++; trainMap.set(k, x); }
  const oftenLate = [...trainMap.values()].filter((x) => x.runs >= 2).map((x) => ({ ...x, pctLate: pct(x.late, x.runs), avgDelay: round1(x.sum / x.runs) }))
    .sort((a, b) => b.pctLate - a.pctLate || b.avgDelay - a.avgDelay).slice(0, 10);

  // time series: hourly (≤ 7 days, from snapshots → has region) or daily (from train_runs)
  let series;
  if (WINDOWS[w] && WINDOWS[w] <= 7) {
    const s = filterSql(f);
    const sw = ["ts >= ?", ...s.where.map((x) => x.replace("dest_region", "region"))];
    const rows = db.prepare(`SELECT ts, SUM(trains) AS trains, SUM(delayed5) AS d5, SUM(delay_sum) AS sum FROM snapshots WHERE ${sw.join(" AND ")} GROUP BY ts ORDER BY ts`).all(start.ms, ...s.args);
    const byHour = new Map();
    for (const r of rows) {
      const h = Math.floor(r.ts / 3600_000) * 3600_000;
      const x = byHour.get(h) || { n: 0, trains: 0, d5: 0, sum: 0 };
      x.n++; x.trains += r.trains; x.d5 += r.d5; x.sum += r.sum; byHour.set(h, x);
    }
    series = { step: "hour", points: [...byHour].map(([t, x]) => ({ t, trains: Math.round(x.trains / x.n), avgDelay: round1(x.sum / (x.trains || 1)), pctLate: pct(x.d5, x.trains) })) };
  } else {
    const byDay = new Map();
    for (const r of runs) {
      const x = byDay.get(r.service_date) || { runs: 0, sum: 0, late: 0, cancelled: 0 };
      if (r.cancelled) x.cancelled++; else if (r.delay != null) { x.runs++; x.sum += Math.max(0, r.delay); if (r.delay >= DELAY.leve) x.late++; }
      byDay.set(r.service_date, x);
    }
    series = { step: "day", points: [...byDay].sort().map(([d, x]) => ({ t: Date.parse(d + "T12:00:00Z"), trains: x.runs, avgDelay: round1(x.sum / (x.runs || 1)), pctLate: pct(x.late, x.runs), cancelled: x.cancelled })) };
  }

  // busiest hours of day (avg trains circulating), from hourly_stats
  const ht = filterSql({ types }); // hourly_stats has no region
  // trains circulating in an hour = Σ over types of obs / cycles; then averaged per hour of day
  const perHour = new Map();
  for (const r of db.prepare(`SELECT hour, obs, cycles FROM hourly_stats WHERE ${["hour >= ?", ...ht.where].join(" AND ")}`).all(start.date, ...ht.args))
    perHour.set(r.hour, (perHour.get(r.hour) || 0) + r.obs / r.cycles);
  const hod = new Map();
  for (const [hour, v] of perHour) { const h = Number(hour.slice(11, 13)); const x = hod.get(h) || { sum: 0, n: 0 }; x.sum += v; x.n++; hod.set(h, x); }
  const hourly = [...hod].sort((a, b) => a[0] - b[0]).map(([h, x]) => ({ h, avg: x.sum / x.n }));

  const speeds = runs.map((r) => r.max_kmh).filter((x) => x != null && x > 0);
  return {
    window: w, coverage: { ...coverage, days: round1(coveredDays) },
    kpis: {
      runs: ran.length,
      perDay: coveredDays >= 1 ? round1(ran.length / coveredDays) : null,
      scheduledPerDay: scheduled.d ? round1(scheduled.n / scheduled.d) : null,
      avgDelay: round1(delays.reduce((a, b) => a + b, 0) / (delays.length || 1)),
      medianDelay: median(delays),
      pctLate5: pct(ran.filter((r) => r.delay >= DELAY.leve).length, ran.length),
      pctLate15: pct(ran.filter((r) => r.delay >= DELAY.grave).length, ran.length),
      cancelled,
      availability: runs.length ? pct(runs.length - cancelled, runs.length) : null,
      incidents: incidents.reduce((a, b) => a + b.n, 0),
      incidentsByLevel: Object.fromEntries(incidents.map((x) => [x.level, x.n])),
      maxKmh: speeds.length ? Math.round(Math.max(...speeds)) : null,
      proximity,
    },
    distribution: bucketize(ran.map((r) => r.delay)),
    byType: [...typeMap.values()].map((x) => ({ type: x.type, runs: x.runs, avgDelay: round1(x.sum / x.runs), pctLate: pct(x.late, x.runs) })),
    lines: rankLines(L, Math.min(3, Math.max(1, days))),
    worstTrains: [...ran].sort((a, b) => b.max_delay - a.max_delay).slice(0, 10).map((r) => ({ train: r.train, id: idOf(r), type: r.type, line: r.line_key, delay: r.max_delay, date: r.service_date })),
    oftenLate,
    busiestHours: hourly.map((x) => ({ h: x.h, avg: Math.round(x.avg) })),
    series,
  };
}



const idOf = (r) => (r.network === "cer" ? "c" + r.train : r.train);

/** 1M…YTD: daily_line_stats for finished days + today's train_runs aggregated on the fly. */
function longStats(w, f, start, now, since, coverage) {
  const today = madridDate(new Date(now));
  const { where, args } = filterSql(f);
  const daily = db.prepare(`SELECT * FROM daily_line_stats WHERE ${["service_date >= ?", "service_date < ?", ...where].join(" AND ")}`).all(start.date, today, ...args);
  const todayRows = db.prepare(AGG_SQL.replace("%WHERE%", "service_date = ?")).all(today)
    .filter((r) => (!f.types?.length || f.types.includes(r.type)) && (!f.region || r.dest_region === f.region));
  const rows = [...daily, ...todayRows];

  const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const runs = sum("runs"), cancelled = sum("cancelled"), late5 = sum("late5"), late15 = sum("late15"), delaySum = sum("delay_sum");
  const windowDays = (now - start.ms) / 86400_000;
  const coveredDays = since ? Math.min(windowDays, (now - Math.max(since, start.ms)) / 86400_000) : 0;
  const days = Math.max(1, Math.round(coveredDays));

  const group = (key) => {
    const m = new Map();
    for (const r of rows) {
      const k = r[key]; if (!k) continue;
      const x = m.get(k) || { k, runs: 0, sum: 0, late: 0 };
      x.runs += r.runs; x.sum += r.delay_sum; x.late += r.late5;
      m.set(k, x);
    }
    return [...m.values()].filter((x) => x.runs);
  };
  const L = group("line_key").map((x) => ({ line: x.k, runs: x.runs, perDay: round1(x.runs / days), avgDelay: round1(x.sum / x.runs), pctLate: pct(x.late, x.runs) }));
  const byDay = new Map();
  for (const r of rows) {
    const x = byDay.get(r.service_date) || { runs: 0, sum: 0, late: 0, cancelled: 0 };
    x.runs += r.runs; x.sum += r.delay_sum; x.late += r.late5; x.cancelled += r.cancelled;
    byDay.set(r.service_date, x);
  }
  const sch = filterSql(f);
  const scheduled = db.prepare(`SELECT COALESCE(SUM(n), 0) AS n, COUNT(DISTINCT service_date) AS d FROM scheduled_days WHERE ${["service_date >= ?", ...sch.where].join(" AND ")}`).get(start.date, ...sch.args);
  const incidents = db.prepare(`SELECT level, COUNT(*) AS n FROM incidents WHERE first_seen >= ? AND source != 'renfe' GROUP BY level`).all(start.ms);
  const proximity = db.prepare(`SELECT COUNT(*) AS n FROM proximity_events WHERE ts >= ?`).get(start.ms).n;

  // per-train rankings from train_runs (LD kept 2 years, Cercanías 90 days)
  const tw = filterSql(f);
  const W = ["service_date >= ?", "cancelled = 0", ...tw.where].join(" AND ");
  const worst = db.prepare(`SELECT train, network, type, line_key, max_delay, service_date FROM train_runs WHERE ${W} AND max_delay IS NOT NULL ORDER BY max_delay DESC LIMIT 10`).all(start.date, ...tw.args);
  const often = db.prepare(`SELECT train, network, MAX(type) AS type, MAX(line_key) AS line_key, COUNT(*) AS runs,
      SUM(COALESCE(final_delay, last_delay) >= 5) AS late, AVG(MAX(0, COALESCE(final_delay, last_delay))) AS avg
    FROM train_runs WHERE ${W} AND last_delay IS NOT NULL GROUP BY network, train HAVING COUNT(*) >= 2
    ORDER BY late * 1.0 / COUNT(*) DESC, avg DESC LIMIT 10`).all(start.date, ...tw.args);

  const perHour = new Map();
  const ht = filterSql({ types: f.types });
  for (const r of db.prepare(`SELECT hour, obs, cycles FROM hourly_stats WHERE ${["hour >= ?", ...ht.where].join(" AND ")}`).all(start.date, ...ht.args))
    perHour.set(r.hour, (perHour.get(r.hour) || 0) + r.obs / r.cycles);
  const hod = new Map();
  for (const [hour, v] of perHour) { const h = Number(hour.slice(11, 13)); const x = hod.get(h) || { sum: 0, n: 0 }; x.sum += v; x.n++; hod.set(h, x); }

  return {
    window: w, coverage: { ...coverage, days: round1(coveredDays) },
    kpis: {
      runs, perDay: coveredDays >= 1 ? round1(runs / coveredDays) : null,
      scheduledPerDay: scheduled.d ? round1(scheduled.n / scheduled.d) : null,
      avgDelay: round1(delaySum / (runs || 1)), medianDelay: null,
      pctLate5: pct(late5, runs), pctLate15: pct(late15, runs),
      cancelled, availability: runs + cancelled ? pct(runs, runs + cancelled) : null,
      incidents: incidents.reduce((a, b) => a + b.n, 0), incidentsByLevel: Object.fromEntries(incidents.map((x) => [x.level, x.n])),
      maxKmh: rows.length ? Math.round(Math.max(0, ...rows.map((r) => r.max_kmh || 0))) || null : null,
      proximity,
    },
    distribution: BUCKETS.map(([, , label], i) => ({ label, n: sum("b" + i) })),
    byType: group("type").map((x) => ({ type: x.k, runs: x.runs, avgDelay: round1(x.sum / x.runs), pctLate: pct(x.late, x.runs) })),
    lines: rankLines(L, Math.min(3, days)),
    worstTrains: worst.map((r) => ({ train: r.train, id: idOf(r), type: r.type, line: r.line_key, delay: r.max_delay, date: r.service_date })),
    oftenLate: often.map((r) => ({ train: r.train, id: idOf(r), type: r.type, line: r.line_key, runs: r.runs, late: r.late, pctLate: pct(r.late, r.runs), avgDelay: round1(r.avg) })),
    busiestHours: [...hod].sort((a, b) => a[0] - b[0]).map(([h, x]) => ({ h, avg: Math.round(x.sum / x.n) })),
    series: { step: "day", points: [...byDay].sort().map(([d, x]) => ({ t: Date.parse(d + "T12:00:00Z"), trains: x.runs, avgDelay: round1(x.sum / (x.runs || 1)), pctLate: pct(x.late, x.runs), cancelled: x.cancelled })) },
  };
}
