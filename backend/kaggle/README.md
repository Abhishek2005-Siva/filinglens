# Hosting the model service on Kaggle (free GPU) with an ngrok tunnel

The model service can run as a private Kaggle GPU kernel. The kernel starts the FastAPI service from `app/`, loads every
adapter from the private dataset `filinglens-adapters`, and exposes it through an ngrok tunnel on a static domain. The
website reads that address from `MODEL_URL`.

## Starting and stopping from the website (open to every visitor)
The header button opens an account picker. It reads each Kaggle account's GPU quota live (the same numbers as kaggle.com),
lists the accounts that still have at least 1 GPU hour left (default: the main account), and hides the ones that are out,
with the date they come back. Pressing **Start server** pushes the kernel on the chosen account and stops any server running
elsewhere. **Turn off** deletes the kernel, which ends the session and releases the reserved GPU time.
There is no login. Guard rails instead: Start refuses while a server is already running, and repeated start/stop calls from one visitor are limited (best effort).
It needs, in Vercel's environment settings: `KAGGLE_TOKEN_<ACCOUNT>` for each account,
`NGROK_AUTHTOKEN`, `NGROK_DOMAIN`, `MODEL_API_KEY`, `SEC_USER_AGENT`. Each account needs its own private `filinglens-adapters` dataset.
The accounts are listed in `api/_accounts.ts`.

## Manual setup (command line)
1. Upload the adapters as a private Kaggle dataset (folder layout: `other/<name>/`, including `other/ceo_filing/` for the CEO reader; the old `robertalarge_seed7/` and `deberta_seed42/` folders are no longer read).
2. Create a free ngrok account and claim a free static domain. Put these in the repo-root `.env` (git-ignored):
   `NGROK_AUTHTOKEN`, `NGROK_DOMAIN` (and `SEC_USER_AGENT`).
3. Point the site at the tunnel: set the Vercel env `MODEL_URL` to `https://<your ngrok domain>` (the API key stays the same).

## Start the server
```bash
cd backend/kaggle
API_KEY_FILE=/path/to/service-api-key ./build.sh     # fills secrets into ./out (git-ignored)
./start.sh                                           # pushes the kernel and deletes ./out
```
Optional: `RUN_HOURS=3 IDLE_MINUTES=10 ./build.sh`. The server stops after `RUN_HOURS` or after `IDLE_MINUTES` without any request (default: 7 minutes; the check runs once a minute, so expect 7-8).
Boot takes about 10-15 minutes the first time (pip installs, then loading all models onto the GPUs).

## Notes
- Kaggle sessions end after at most 12 hours, and GPU time counts against the weekly quota (shared with other jobs).
- The kernel is private and contains the API key and ngrok token. Never make it public.
- Colab is not an option: its free tier forbids serving web endpoints.
