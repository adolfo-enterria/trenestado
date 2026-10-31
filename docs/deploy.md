# Deploying Trenestado (Supabase + Cloudflare, free plans)

Architecture and limits: `docs/free-tier.md`. This is the step-by-step.

```
Supabase Cron (every minute) ─► Edge Function "collector" ─► Postgres ──────────────┐
                                        └─► R2 live/estado.json                     │
GitHub Actions (daily) ─► timetables → Postgres; static map data + monthly CSVs → R2 │
Browser ─► Cloudflare Pages (public/) ─► functions/api/[[path]].js ─► R2 or Edge Function "api"
```

## 1. Supabase

1. Create a project at https://supabase.com (Free). Region: Europe (Frankfurt or Paris). Save the
   database password somewhere safe.
2. **SQL Editor → New query** → paste all of `supabase/schema.sql` → **Run**. It's re-runnable.
3. Note from **Project Settings**:
   - Project ref (the `xxxx` in `https://xxxx.supabase.co`)
   - **API keys**: the publishable/anon key (public, read-only thanks to RLS)
   - **Database → Connection string → Session pooler** URI (for GitHub Actions; contains the password)

## 2. Cloudflare R2 (storage for the live snapshot, static data and downloads)

1. Cloudflare dashboard → **R2** → enable it (asks for a payment method even on the free plan; you won't
   be charged within 10 GB / 1 M writes / 10 M reads per month).
2. Create bucket **`trenestado`** (location: Europe).
3. **R2 → Manage API tokens → Create API token**: permission *Object Read & Write*, bucket `trenestado`.
   Note the **Access Key ID**, **Secret Access Key** and your **Account ID**.

## 3. Edge Functions

Locally, once (the CLI opens the browser to log in):

```sh
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase secrets set CRON_SECRET=<long random string> R2_ACCOUNT_ID=<id> R2_ACCESS_KEY_ID=<key> R2_SECRET_ACCESS_KEY=<secret> R2_BUCKET=trenestado
npx supabase functions deploy collector
npx supabase functions deploy api
```

Then in the **SQL Editor**, schedule the collector every minute (same CRON_SECRET value):

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<same CRON_SECRET>', 'cron_secret');
select cron.schedule('trenestado-collector', '* * * * *', $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/collector',
    headers := jsonb_build_object('x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
                                  'Content-Type', 'application/json'),
    body    := '{}'::jsonb, timeout_milliseconds := 55000)
$$);
```

## 4. GitHub Actions (daily timetables, static data, downloads)

Repository → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `DATABASE_URL` | Supabase session pooler URI (with the password) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | from step 2 |
| `R2_BUCKET` | `trenestado` |

Then **Actions → daily-sync → Run workflow** once (the first run loads the timetables; until then the
collector has no stations). It runs by itself every night at 03:30 UTC.

## 5. Cloudflare Pages (the website)

1. **Workers & Pages → Create → Pages → Connect to Git** → repository `trenestado`.
2. Build settings: framework *None*, build command *(empty)*, **output directory `public`**.
   The `functions/` folder at the repo root is picked up automatically.
3. **Settings → Bindings → R2 bucket**: variable name **`LIVE`**, bucket `trenestado`.
4. **Settings → Variables**: `SUPABASE_URL` = `https://<project-ref>.supabase.co`,
   `SUPABASE_ANON_KEY` = the publishable/anon key.
5. Redeploy. The site is at `https://<project>.pages.dev`.

The frontend loads `/vendor/leaflet/…`, `/vendor/chart.js/…`, `/vendor/maplibre-gl/…` and
`/vendor/maplibre-gl-leaflet/…`, which the local server serves from `node_modules`. For Pages, copy them into
`public/vendor/` with `npm run vendor` (see package.json) before deploying — the build command can do it:
**build command `npm ci && npm run vendor`**.

## Checking it works

- Supabase → **Edge Functions → collector → Logs**: one call per minute, `{"trains": …}`.
- `https://<project>.pages.dev/api/estado` returns JSON with `trenes`.
- `https://<project>.pages.dev/api/fuentes` shows each source's status.
