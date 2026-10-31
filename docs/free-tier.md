# Running Trenestado for free

What it takes to run the whole thing on free plans (Supabase Free + Cloudflare Free), with the numbers
that decide it. Limits checked on 2026-10-31 against the providers' docs; re-check before launch.

## TL;DR

| Piece | Where | Free? |
|---|---|---|
| Database (history, stats, timetable) | **Supabase** Postgres | ✅ 500 MB, enough for ~3 years (see §4) |
| Collector (polls Renfe/Adif) | **Supabase Edge Function** run by **Supabase Cron** | ✅ 2 s CPU per run; 1 run/min = 43,200 runs/month of 500,000 |
| Live map data (`estado.json`) | **Cloudflare R2**, read through a **Pages Function** | ✅ zero egress; ~43,200 writes/month of 1,000,000 |
| Website (HTML/JS/CSS) | **Cloudflare Pages** (`*.pages.dev`) | ✅ static assets |
| Cercanías departure boards proxy | **Pages Function** | ✅ counts against 100,000 Worker requests/day |
| Domain | `*.pages.dev` | ✅ (a custom domain is optional and costs ~€10/year) |

**Not on Cloudflare: the collector.** Cloudflare Workers Free gives **10 ms of CPU per invocation**
(cron triggers included). One collector cycle (parse ~125 KB of JSON, match ~700 trains to the timetable,
compute speeds/detections, write to the database) needs tens to hundreds of ms. Supabase Edge Functions
give **2 s CPU** per run, so the collector lives there.

## 1. Architecture

```
            every 1 min (Supabase Cron → pg_net)
Renfe/Adif ───────────────► Edge Function "collector" ──► Postgres (train_runs, live_trains, incidents…)
                                     │
                                     └──► R2: estado.json  (live snapshot, gzip)
Browser ──► Cloudflare Pages (static site)
        ├─► /api/estado        Pages Function → R2 (no Supabase egress)
        ├─► /api/salidas/:code Pages Function → Renfe departures (Cercanías), short cache
        └─► Supabase RPC/REST  stats, train page, search, LD departure boards (small, infrequent)
Daily:  Edge Function "gtfs" (or a GitHub Action) loads Renfe's timetable into Postgres
```

Why live data goes through R2 and not straight from Supabase: Supabase Free includes **5 GB/month of
egress**. One open tab polling a 50 KB snapshot every minute is ~70 MB/day, so ~2 tabs open all day would
use the whole allowance. R2 has **no egress fees**; each read is one "Class B" operation (10 M/month free).

## 2. Free-plan limits that matter

| Provider | Limit | Our use at 1-min collection |
|---|---|---|
| Supabase | Database 500 MB | ~210 MB year 1, ~330 MB year 2 (§4) |
| Supabase | Edge Function invocations 500,000/month | collector 43,200 + gtfs 30 |
| Supabase | Edge Function CPU 2 s, wall clock 150 s, memory 256 MB | collector ~100–300 ms CPU (estimate, measure after port) |
| Supabase | Egress 5 GB/month | stats/train/search responses only (~10 KB each) → ~500k page loads/month |
| Supabase | **Paused after 1 week of inactivity**; max 2 active projects | the collector writes every minute; the docs don't define "inactivity" precisely, so watch the first weeks |
| Cloudflare R2 | 1 M Class A (writes)/month, 10 M Class B (reads)/month, 10 GB storage | 43,200 writes; reads = page polls |
| Cloudflare Workers/Pages Functions | 100,000 requests/day, 10 ms CPU each | every `/api/estado` poll and board view is one request |
| Cloudflare Pages | 500 builds/month, 20,000 files, 25 MiB per file | a few deploys/day at most |

## 3. Choosing the intervals

Collection interval (server) and polling interval (browser) are independent.

| Collector every | Edge Function runs/month | R2 writes/month | Fits free? |
|---|---|---|---|
| 15 s | 172,800 | 172,800 | ✅ (but more DB writes/bloat) |
| 30 s | 86,400 | 86,400 | ✅ |
| **1 min (recommended)** | **43,200** | **43,200** | ✅ |
| 2 min | 21,600 | 21,600 | ✅ |

The real ceiling is **browser polls** against 100,000 Worker requests/day:

| Browser polls every | Requests per tab-hour | Visitor capacity/day (10-min visits) |
|---|---|---|
| 15 s | 240 | ~2,500 |
| 1 min | 60 | ~10,000 |
| **2 min** | 30 | **~20,000** |

Recommendation: **collector every 1 minute, browser polls every 1 minute while the tab is visible**
(stops when hidden). Train dots keep moving smoothly in between by extrapolating with their velocity
(cap raised from 60 s to 120 s). With 2-minute polling you double visitor capacity.

Effects of slower data: speed becomes an average over the interval (fine); "stopped between stations"
detection gets 1–2 min slower; the proximity check becomes even less meaningful (positions up to 2 min
old), which is acceptable while it stays experimental.

## 4. Database size on 500 MB

Storage depends on trains per day, not on polling frequency (one summary row per train run).

| Table | Rows | Retention | Steady size |
|---|---|---|---|
| `train_runs` LD/MD | ~1,900/day | 2 years, then rolled up | ~100 MB/year |
| `train_runs` Cercanías | ~4,000–5,000/day (estimate) | **90 days** | ~70 MB steady |
| `daily_line_stats` (per day × line × type, all networks) | ~500/day | forever | ~20 MB/year |
| `gtfs_*` (stations, trips, stop times) | ~80k | replaced daily | ~15 MB |
| `snapshots` (5-min, for 1D/7D charts) | ~25k/day | 7 days | ~5 MB |
| `live_trains`, `incidents`, `proximity_events`, `meta` | small | — | < 5 MB |

≈ 210 MB after year 1, ≈ 330 MB after year 2; from then on the 2-year roll-up keeps it roughly flat
(~350–400 MB). Long windows (1M…YTD) read `daily_line_stats`, so they keep working after per-train rows
are purged; per-train punctuality ("llega tarde el X % de los días") uses the last 90 days.

Write volume: the collector keeps run aggregates and upserts each active train once per cycle
(~700 rows/min at peak). Postgres handles that; autovacuum reclaims the dead rows.

## 5. Requirements checklist

Accounts
- [ ] Supabase account, one Free project (region: `eu-west`/Frankfurt or Madrid if offered)
- [ ] Cloudflare account (Free), R2 enabled (R2 asks for a payment method on file even for the free tier)
- [ ] GitHub repo (optional: Pages deploys from git; GitHub Actions as fallback for the daily GTFS load)

Supabase setup
- [ ] Run `supabase/schema.sql` in the SQL editor (tables, indexes, RLS, roll-up/retention jobs)
- [ ] Enable extensions `pg_cron` and `pg_net` (the schema does this)
- [ ] Deploy Edge Functions `collector` and `gtfs`; set secrets: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
      `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
- [ ] Schedule: collector every minute, gtfs daily at 04:00 Madrid (the schema has the commented
      `cron.schedule` calls to fill in with your project URL and key)

Cloudflare setup
- [ ] R2 bucket `trenestado` (private; read through the Pages Function binding)
- [ ] Pages project from the repo's `public/` folder + `functions/` (Pages Functions: `/api/estado`,
      `/api/salidas/:code`), R2 binding `LIVE`
- [ ] Env vars for the frontend: `SUPABASE_URL`, `SUPABASE_ANON_KEY` (public, read-only by RLS)

Code changes still needed (the current app is a single Node server with SQLite)
- [ ] Port collector to a Deno Edge Function (same logic; SQLite calls → Supabase upserts; in-memory
      state → `live_trains` table so speed/stopped detection survives between runs)
- [ ] Port stats/train/search/boards queries to Postgres RPC functions
- [ ] Frontend: read `/api/estado` from the Pages Function, the rest from Supabase; poll every 60 s

## 6. Things that could break "free"

- **Supabase pausing** if the project is judged inactive. Mitigation: the collector writes every minute;
  if it still pauses, Supabase Pro is $25/month.
- **Traffic spikes** (e.g. a big incident shared on social media) can exhaust 100,000 Worker requests/day.
  Requests then fail until 00:00 UTC. Mitigation: raise the browser poll interval automatically when the
  daily count gets high, or serve `estado.json` from R2 through a custom domain with Cloudflare caching
  (needs a domain).
- **Adif from datacenter IPs**: Supabase runs on AWS; Adif's CDN may block it where it didn't block us.
  Incidents then come only from our own detection (already handled).
- **Renfe changes the undocumented map JSON**: not a cost issue, but the collector would need updating.
