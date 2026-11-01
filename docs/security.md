# Security

The repository is public and the site is live, so this file lists what an outsider can and can't do, what
has been checked, and what is still to fix. Last reviewed: 2026-11-01 (external audit + code check).

## What is public on purpose, and what must stay secret

| Public (fine to be seen) | Secret (never in the repo, logs or chat) |
|---|---|
| Supabase project ref `naudtfoygjhisvrtqzig` and org id | Database password / `DATABASE_URL` |
| `https://<ref>.supabase.co` and the Edge Function URLs | Supabase `service_role` / secret keys |
| R2 bucket name `trenestado` | R2 Access Key ID + Secret Access Key, R2 API token (`cfat_…`) |
| All the code, the workflow file, `supabase/schema.sql` | `cron_secret` (lives only in Supabase Vault) |
| Every dataset the site shows (it's Renfe/Adif open data) | Logins of the GitHub, Supabase and Cloudflare accounts |

Nothing in the right-hand column is in the git history: the full history was scanned for connection strings,
`cfat_` tokens and passwords and came back clean. The worst realistic outcomes are therefore (a) the site
stops working because a free quota runs out, (b) a small Cloudflare bill (R2 has a payment method on file),
and (c) personal data — the e-mail in the commits.

## Findings

Severity is for this project (a free, read-only public site), not in absolute terms.

| # | Finding | Verified | Severity | Status |
|---|---|---|---|---|
| 1 | Uncached `/api/*` lets anyone burn the free quotas (and R2 reads cost money past the free tier) | Yes, with a correction | **Medium** | Fixed: edge cache confirmed working on `pages.dev`; R2 Class B usage alert at 8 M |
| 2 | Daily job connects to Postgres as `postgres` | Yes | Medium | Fixed: `DATABASE_URL` uses `trenestado_sync` (daily-sync green 2026-11-01) |
| 3 | `supabase/.temp/` is committed | Yes | Info | Fixed |
| 4 | Collaborators with write access can read the secrets | Yes | Medium (only if you add collaborators) | Fixed: fork PR approval for all outside contributors; ruleset blocks force push/deletion of `main` |
| 5 | `${{ inputs.steps }}` interpolated into `run:` | Yes | Low | Fixed |
| 6 | Station names in Leaflet tooltips not escaped (`train.js:164`) | Yes, with a correction | Low | Fixed |
| 7 | Personal e-mail in commit metadata | Yes (all 6 commits) | Privacy | Accepted (owner doesn't mind) |
| 8 | Supabase Data API (PostgREST) is enabled but unused | New | Low | Fixed: Data API off |
| 9 | API returns raw error messages | New | Low | Fixed (500s) |
| 10 | ~~`/api/estacion` calls Renfe on every request~~ | No — already cached | – | Not an issue |
| 11 | Workflow has no explicit `permissions:` and actions aren't pinned | New | Low | `permissions` fixed; Dependabot alerts on; pinning skipped |
| 12 | Cloudflare Pages preview deployments | New | Check | Fixed: preview branch deployments off |
| 13 | Account security (2FA, alerts, scanning) | New | **High impact** if missed | Secret scanning + push protection on; 2FA to check (you) |

---

### 1. Quota exhaustion through `/api/*` — Medium

**Verified.** Every `/api/*` request runs the Pages Function in `functions/api/[[path]].js`. Responses from
Pages Functions are not stored in Cloudflare's edge cache, and the forward to Supabase uses
`cacheEverything: false`, so the `cacheTtl: 20` has no effect on JSON. Each request therefore costs:

| Request | Pages Function (free: 100 000/day) | R2 Class B read (free: 10 M/month, then paid) | Supabase Edge Function (free: 500 000/month) |
|---|---|---|---|
| `/api/estado`, `/api/base`, `/api/red`… | 1 | 1 | – |
| `/api/export?…` | 1 | 1 + one per month in the range | – |
| `/api/tren`, `/api/estacion`, `/api/stats`… | 1 | – | 1 (+ Postgres queries) |
| `https://<ref>.supabase.co/functions/v1/api/…` (direct, skipping Cloudflare) | – | – | 1 |

**Correction to the audit:** "it wouldn't cost money" isn't quite right. The cost guards in
`scripts/sync-supabase.mjs` and the collector cap R2 *writes* and *storage*, not *reads*. Reads go through the
`LIVE` binding with no cap. The Pages Function daily limit bounds it (≈ 100 000 requests/day; with long export
ranges each one can be 10+ reads, so a determined attacker could reach tens of millions of reads a month).
At $0.36 per extra million that's a few dollars, not a disaster, but it isn't zero.

When a quota runs out: Pages Functions fail (static pages still load but the map has no data); Supabase
Edge Functions on the Free plan stop until the next cycle. Supabase Free has no overage billing.

**Second correction:** a Cloudflare WAF rate-limiting rule can't be added to a `*.pages.dev` hostname — WAF
rules apply to zones (domains) you own. Options, cheapest first:

1. **Cache inside the Pages Function** — *done.* `functions/api/[[path]].js` puts every successful response
   in Cloudflare's Cache API; a hit costs no R2 read and no Supabase invocation. The cache key keeps only
   the parameters each route reads, so `?x=<random>` can't bypass it, and exports are keyed by dataset and
   month range. Unknown `/api/` routes are answered with a 404 there instead of being forwarded to Supabase.
   The Edge Function now sends `public, max-age=N` for every route (20–300 s) so its answers are cacheable.
   Every response carries `X-Trenestado-Cache: hit|miss`. **After deploying, check for `hit`**: if it never
   appears on `pages.dev`, the Cache API is a no-op there and option 3 is the fix.
2. **Cap the export range** — *not done:* it would break the "1 año" and "Todo" presets on the downloads page,
   and with the normalised cache key each dataset/month range is only read from R2 once per 10 minutes.
3. **Custom domain** (any cheap domain added to Cloudflare): unlocks the free rate-limiting rule (Security →
   WAF → Rate limiting rules, e.g. 60 requests / 10 s per IP on `/api/`) and normal edge caching.
4. **Cloudflare billing alert**: Notifications → Add → Billing / usage-based billing, so any R2 charge e-mails
   you before it grows.
5. The direct Supabase URL can't be hidden (the ref is in the history and is not a secret anyway). If abuse
   ever happens there, the fix is a shared header: the Pages Function sends `x-proxy-secret`, the `api` Edge
   Function rejects requests without it. Not worth doing preventively.

**Capacity note (not an attack):** the browser polls `/api/estado` every `pollSeconds` (60 s). Around 70
people with the map open all day already use 100 000 Pages Function requests. Option 1 doesn't change that
count (the function still runs), only the R2/Supabase cost behind it. If the site gets popular, serve
`live/estado.json` straight from R2 on a custom domain (public bucket, cached at the edge, no function).

### 2. Daily job connects as `postgres` — Medium

**Verified.** `DATABASE_URL` in GitHub Secrets is the session-pooler URI with the `postgres` user
(`docs/deploy.md` §1), which can do anything in the database, including dropping it. If the secret ever
leaks, a restricted role limits the damage to the timetable tables, which are rebuilt every night anyway.

What the job touches (from `scripts/sync-supabase.mjs`):

- **writes** (insert/update/delete/truncate): `stations`, `gtfs_calendar`, `gtfs_calendar_dates`, `gtfs_trips`,
  `gtfs_shapes`, `gtfs_stop_times`, `cercanias_lines`, `scheduled_days`, `places`, `rail_pairs`, `meta`,
  `source_status`
- **reads** (exports): `train_runs`, `daily_line_stats`, `incidents`, `proximity_events`, `hourly_stats`, plus
  the tables above

All tables have Row Level Security, so the new role needs policies as well as grants (`postgres` bypasses
RLS; a new role doesn't). *Done:* this is now a re-runnable section of `supabase/schema.sql` (tested on
Postgres: the role can rebuild its tables, and gets "permission denied" writing `train_runs`, truncating
`incidents`, dropping or creating tables). For reference, it amounts to:

```sql
create role trenestado_sync login password '<long random password, letters and digits only>';
grant usage on schema public to trenestado_sync;
grant select on all tables in schema public to trenestado_sync;
grant insert, update, delete, truncate on
  public.stations, public.gtfs_calendar, public.gtfs_calendar_dates, public.gtfs_trips, public.gtfs_shapes,
  public.gtfs_stop_times, public.cercanias_lines, public.scheduled_days, public.places, public.rail_pairs,
  public.meta, public.source_status
  to trenestado_sync;
grant usage on all sequences in schema public to trenestado_sync;

-- RLS: read everything, write only the tables above
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('create policy "sync read" on public.%I for select to trenestado_sync using (true)', t);
  end loop;
  foreach t in array array['stations','gtfs_calendar','gtfs_calendar_dates','gtfs_trips','gtfs_shapes',
    'gtfs_stop_times','cercanias_lines','scheduled_days','places','rail_pairs','meta','source_status'] loop
    execute format('create policy "sync write" on public.%I for all to trenestado_sync using (true) with check (true)', t);
  end loop;
end $$;
```

**Your steps:** run `schema.sql` again in the SQL Editor, then
`alter role trenestado_sync password '<long random letters and digits>';` (there, never in a file). Then set
the GitHub secret to the same pooler URI with user `trenestado_sync.naudtfoygjhisvrtqzig` and the
new password (`gh secret set DATABASE_URL`), run **daily-sync** by hand and check it goes green. Once it
works, change the `postgres` password (Project Settings → Database → Reset password) since it's no longer
needed anywhere outside Supabase. Add the SQL to `supabase/schema.sql` so a rebuild keeps it.

### 3. `supabase/.temp/` committed — Info

**Verified.** `supabase/.temp/linked-project.json` (project ref, org id) and `supabase/.temp/cli-latest` are
tracked. Nothing secret inside; it's CLI cache. Add to `.gitignore` and untrack:

```
supabase/.temp/
.env
.env.*
```
```sh
git rm -r --cached supabase/.temp
```

`.env*` is added preventively: there's no `.env` today, but `.gitignore` doesn't cover one if it's ever
created. Removing the file doesn't hide the ref (it's in history, in `docs/to-do.md` and in every request
URL), and it doesn't need hiding.

### 4. Collaborators — Medium if you add any

**Verified, with nuance.** Anyone with **write** access can edit `.github/workflows/daily.yml` (or add a
workflow) on a branch, run it, and print the secrets. So: accept outside contributions as **pull requests
from forks**, never grant write access.

Pull requests from forks don't receive repository secrets and `daily.yml` doesn't run on `pull_request`, so
the fork route is already safe. Still worth setting:

- Settings → Actions → General → **Fork pull request workflows from outside collaborators** → *Require
  approval for all outside collaborators*.
- Settings → Branches → protect `main` (require a PR, no force pushes). Cloudflare Pages deploys whatever
  lands on `main`, so this is also what stops a bad merge going live unnoticed.

### 5. `${{ inputs.steps }}` in `run:` — Low

**Verified** (`.github/workflows/daily.yml`, last line). The expression is pasted into the shell script before
it runs, so an input like `gtfs; curl … $DATABASE_URL` would execute. Only people with write access can
start `workflow_dispatch`, i.e. only you today. Pass it through the environment instead:

```yaml
      - name: Sync timetables, static data and exports
        env:
          STEPS: ${{ inputs.steps }}
          ALL_MONTHS: ${{ inputs.all_months && '--all-months' || '' }}
          # …secrets as now…
        run: node --no-warnings scripts/sync-supabase.mjs $STEPS $ALL_MONTHS
```

(`$STEPS` unquoted on purpose so `gtfs static` still splits into two arguments; the shell doesn't execute
the contents of a variable.)

### 6. Unescaped tooltip in `train.js` — Low

**Verified for line 164, not for line 168.** In `public/js/train.js:164` the station name `s.n` (and
`s.est`/`s.arr`) goes into `bindTooltip()`, which Leaflet renders as HTML. Station names come from Renfe's
GTFS, so it's only exploitable if that data were malicious. Fix:

```js
.bindTooltip(`${esc(s.n)} ${esc(s.est || s.arr || "")}`)
```

Line 168 uses `d.n`, which the API builds with `normTrain()` (digits only), so it can't carry HTML; wrapping
it in `esc()` too is harmless. Everything else that writes HTML (`innerHTML`, `bindPopup`, `divIcon`) was
checked and already uses `esc()` for data from Renfe/Adif; the unescaped values left are train numbers
(digits) or constants from the code.

### 7. Personal e-mail in commits — Privacy

**Verified.** All 6 commits have author `adolfofge@gmail.com`; anyone can read it with `git log` or by adding
`.patch` to a commit URL on GitHub.

For new commits: *this repo is done* — `git config --local user.email` is now
`280293118+adolfo-enterria@users.noreply.github.com`. Still to do (you):

1. GitHub → Settings → Emails → tick **Keep my email addresses private** and **Block command line pushes
   that expose my email**. Copy the `…@users.noreply.github.com` address shown there.
2. For your other repos: `git config --global user.email "280293118+adolfo-enterria@users.noreply.github.com"`.

The existing commits keep the address. Removing it means rewriting history (`git filter-repo --mailmap`) and
force-pushing `main`; with 6 commits and no other contributors that's feasible, but the address may already
be cached by GitHub's API or mirrors, so only do it if it matters to you.

### 8. Supabase Data API (PostgREST) enabled but unused — Low

**New.** `supabase/schema.sql` grants `select` to `anon` on every public table ("public read" policies), and
its header still says the browser reads with the anon key. It doesn't any more: the site goes through
Cloudflare → Edge Functions, which connect with `SUPABASE_DB_URL`. Anyone with the publishable key (it's
designed to be public) can still bulk-read every table at `https://<ref>.supabase.co/rest/v1/…`, using egress
(free: 5 GB/month) and database CPU, around Cloudflare. No data is private, so the risk is only quota.

Fix: Project Settings → **Data API** → turn it off (or remove `public` from *Exposed schemas*). Then fix the
comment at the top of `schema.sql`.

### 9. Raw error messages in API responses — Low

**New.** `supabase/functions/api/index.ts` returns `String(e.message)` with status 500, and `/api/fuentes`
shows each source's last error. Postgres errors can reveal table and column names; nothing secret, since the
schema is public. Optional: return a generic `"Error interno"` and keep the detail in `console.error` (already
logged).

### 10. `/api/estacion` calls Renfe on every request — not an issue

**Withdrawn.** `estacion()` already keeps Renfe's departures for 30 s per station in `salidasCache`, and
only for known station codes, so a loop on `/api/estacion/<code>` reaches Renfe at most twice a minute per
station. The edge cache from finding 1 now sits in front of it as well.

### 11. Workflow hardening — Low

**New.**

- *Done:* `permissions: contents: read` at the top of `daily.yml`. The job only needs to check out the code; this
  stops `GITHUB_TOKEN` having write access whatever the repository default is.
- `actions/checkout@v4` and `actions/setup-node@v4` are tag references. Pinning to a full commit SHA protects
  against a compromised tag. Both are official GitHub actions, so this is optional.
- `npm ci --omit=dev` installs from `package-lock.json`, which is good. Enable **Dependabot alerts**
  (Settings → Code security) to hear about vulnerable dependencies.

### 12. Cloudflare Pages preview deployments — Check

**New, not verifiable from the code.** Pages can build previews of other branches and pull requests, and
preview environments can have their own bindings. Check Pages → Settings → **Builds & deployments → Preview
branch control**: set it to *None* or to your own branches, and make sure the preview environment doesn't
have the `LIVE` R2 binding unless you need it.

### 13. Accounts — the part that actually matters most

Someone in your GitHub, Supabase or Cloudflare account can do everything the findings above try to prevent,
and more. Check:

- [ ] **2FA** on GitHub, Supabase, Cloudflare and the e-mail account their password resets go to (an authenticator
      app or passkey, not SMS).
- [x] GitHub → Settings → Code security: **Secret scanning** and **Push protection** on (free for public
      repos). Push protection blocks a push that contains a token.
- [x] Cloudflare billing notification (finding 1): a spending alert plus a usage alert at 8 M R2 Class B reads.
- [x] R2 bucket → Settings: **Public access** off (`r2.dev` URL disabled). The site reads it through the
      binding, so it doesn't need to be public.
- [ ] Rotate the R2 secret that ended up in the collector logs — see `docs/to-do.md`.
- [ ] Never paste secrets into issues, commits, chats or screenshots; when a secret appears somewhere it
      shouldn't, rotate it rather than delete the message.

## Checked and fine

- No secrets in the code or git history (connection strings, `cfat_` tokens, passwords, JWTs).
- The `collector` Edge Function rejects calls without the `x-cron-secret` header; the secret is generated
  inside the database and read from Vault, never copied anywhere.
- All SQL uses the `postgres` library's tagged templates (parameterised); no `sql.unsafe`. API inputs are
  whitelisted (`w`, `tipos`, `region`) or normalised (`normTrain`).
- The Pages Function only accepts GET/HEAD, validates `/api/export` parameters with strict regexes, and only
  reads fixed R2 keys.
- RLS is on for every table; `anon` can only read, `maintenance()` and `rollup_day()` are revoked from public.
- The daily job masks secrets in its output and validates `DATABASE_URL` without printing it.
- `Access-Control-Allow-Origin: *` is fine: the API is read-only public data with no cookies or auth.
