# To-do

## Rotate the R2 API token (optional, low urgency)

**Why:** on 2026-10-31 the token value (`cfat_…`) was pasted by mistake into the `R2_ACCOUNT_ID` secret, so
it appeared in the collector's logs in Supabase (Edge Functions → collector → Logs). Those logs are private
to the project, so the risk is low, but the value has been seen and should be replaced.

**Important:** don't delete the token. The token value, the Access Key ID and the Secret Access Key all
belong to the same token (the secret access key is derived from the token value). Deleting it would cut
R2 off and the live map would stop updating. Roll it instead:

1. Cloudflare → **R2 Object Storage → API tokens** → the `trenestado` token → **Roll** (regenerate).
2. Copy the new **Secret Access Key** shown once. The Access Key ID and the Account ID don't change.
3. Update it in both places (run in the project folder):
   ```sh
   npx supabase secrets set --project-ref naudtfoygjhisvrtqzig R2_SECRET_ACCESS_KEY=<new secret>
   gh secret set R2_SECRET_ACCESS_KEY
   ```
4. Redeploy the collector so it picks the new secret up:
   ```sh
   npx supabase functions deploy collector --project-ref naudtfoygjhisvrtqzig --use-api
   ```
5. Check: https://trenestado.pages.dev/api/estado should show a `generado` time from the last minute, and
   GitHub → Actions → **daily-sync** → Run workflow should finish green.

If anything fails, the old token can't be restored — repeat from step 1 and make sure the secret is
pasted without spaces.

## Reset the `postgres` database password (optional, low urgency)

**Why:** until 2026-11-01 the GitHub secret `DATABASE_URL` used the `postgres` superuser. It now uses the
restricted `trenestado_sync` role, so the old password isn't stored anywhere we use, but it has existed
outside Supabase. Resetting it makes any old copy useless.

1. Supabase → **Project Settings → Database → Reset database password**. Use letters and digits only and
   keep it in your password manager; nothing in the project needs it.
2. Within 2 minutes, check that the collector still works: Supabase → **Edge Functions → collector → Logs**
   shows a call per minute with `{"trains": …}`, and https://trenestado.pages.dev/api/estado has a
   `generado` time from the last minute. Supabase should update the Edge Functions' own `SUPABASE_DB_URL`
   by itself; if the collector starts failing, that's the first thing to check.
3. Nothing else changes: the daily job connects as `trenestado_sync`, whose password is separate.

## Only if someone abuses the site (not needed now)

The `/api/*` responses are cached at the edge (`X-Trenestado-Cache: hit|miss`), and there's an R2 usage
alert at 8 M Class B reads a month plus a spending alert. If those alerts ever fire, or the site stops
because a free quota runs out:

- **Custom domain** on Cloudflare: allows a WAF rate-limiting rule (e.g. 60 requests / 10 s per IP on
  `/api/`). Rate-limiting rules can't be added to a `*.pages.dev` address.
- **Direct calls to Supabase** (`https://naudtfoygjhisvrtqzig.supabase.co/functions/v1/api/…` skips
  Cloudflare): have the Pages Function send a shared `x-proxy-secret` header and make the `api` Edge
  Function reject requests without it.
- **Pin the GitHub Actions** in `.github/workflows/daily.yml` to commit SHAs instead of `@v4` tags.
