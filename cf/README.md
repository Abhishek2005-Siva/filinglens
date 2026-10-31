# Running the site on Cloudflare (free plan)

The same `api/*.ts` functions run on Vercel and on Cloudflare. `cf/worker.ts` wraps them; `wrangler.jsonc` swaps Vercel's file storage for a D1 database
(`cf/blob.ts`) and the packed Chromium for Cloudflare's Browser Rendering (`api/_browser.ts`). Static pages come from `dist/`.

## One-time setup
1. Free account at dash.cloudflare.com, then `npx wrangler login`.
2. `npx wrangler d1 create filinglens`, then put the database id in `wrangler.jsonc` (D1 needs no payment method; R2 does).
3. Secrets, one at a time with `npx wrangler secret put NAME`:
   `SITE_PASSWORD_HMAC` (run `node cf/make-secret.mjs` to make it), `AUTH_SECRET` (any long random text), `MODEL_API_KEY`, `SEC_USER_AGENT`,
   `NGROK_AUTHTOKEN`, `NGROK_DOMAIN`, `KAGGLE_TOKEN_BUTTERBOY`, `KAGGLE_TOKEN_THANUJAMANJUNATH`, `KAGGLE_TOKEN_CS23B2005`, `KAGGLE_TOKEN_ABHISHEKKUMARSIVA`.
   `MODEL_API_KEY` must be the same value the Kaggle notebooks are built with.
4. `npm run cf:deploy` (builds the pages, packs the AI-server code, deploys). Local test: `npm run cf:dev` with the secrets in `.dev.vars` (git-ignored).

## Limits to watch (free plan)
100,000 requests a day, 10 ms of processor time per request, Browser Rendering 10 minutes a day and 3 browsers at once, D1 100,000 rows written and 5 million rows read a day, 5 GB.
