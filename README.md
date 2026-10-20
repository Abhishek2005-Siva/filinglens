# FilingLens

**See what happened in any SEC 8-K filing, in plain English.**

When something important happens at a US public company, it must tell the SEC in a document called an **8-K**. Thousands are filed every month and most are long and technical. FilingLens searches the SEC's public filings database, reads filings with AI, and tells you what changed: a new CEO or CFO, a bankruptcy, a delisting notice, a new auditor, how shareholders voted, a completed acquisition, a new or ended agreement, an equity sale, earnings guidance, a restructuring or impairment. Open one filing, or analyze every result of a search at once into a spreadsheet (CSV or Excel) that keeps running in the background if you close the page. Every answer comes with the exact sentence it is based on and a link to the original filing.

> **Model files are not in this repository.** Trained weights, training data and checkpoints live in a separate private project and a private Hugging Face model repo. This repo contains the front-end, the serverless API, the model-service code (no weights) and the results data it displays.

## What it detects

Every filing you open is run through **all** of these detectors; each one only reports when its 8-K Item is present.

| Detector | 8-K Item | Model | Held-out result |
|---|---|---|---|
| **CEO appointed or leaving** | 5.02 | 3 readers vote: RoBERTa-large x2 + DeBERTa-v3, per sentence | March 2025: new CEO 94.7% right / 84.8% found; CEO leaving 95.8% / 79.3% |
| **CFO appointed or leaving** | 5.02 | 4 RoBERTa-large fold models averaged | Cross-validation: new CFO 95.8% / 93.7%; CFO leaving 88.6% / 91.3% |
| **Bankruptcy or receivership** | 1.03 | RoBERTa-large + DeBERTa-v3, section level, date-aware | 149 events: 94.7% right / 96.0% found |
| **Delisting or listing notice** | 3.01 | RoBERTa-large x2 + DeBERTa-v3, section level | 477 events: deficiency 97% / 92%, exchange delisting 90% / 89%, voluntary 95% / 99% |
| **Change of auditor** | 4.01 | RoBERTa-base + rule engine | 348 filings: F1 0.97-0.99 on dismissed / resigned / engaged / reportable event |
| **Shareholder vote results** | 5.07 | RoBERTa-base + rule engine + vote-table parser | 589 filings: F1 0.96-0.99 on directors, auditor, say-on-pay, equity plan |
| **Acquisition / sale completed** *(experimental)* | 2.01 | RoBERTa-base sentences + RoBERTa-large direction | Deal completed F1 0.95; who-bought-whom 90% |
| **Material agreements** *(experimental)* | 1.01 / 1.02 | RoBERTa-base event + type readers | Entered F1 0.94, ended F1 0.88; type is a hint only |
| **Unregistered equity sales** *(experimental)* | 3.02 | RoBERTa-base sale + type readers | No independent accuracy yet |
| **Earnings guidance** *(experimental)* | 2.02 | RoBERTa-large on the press release | Accuracy 90.6%, macro-F1 0.77 |
| **Restructuring / impairment** *(experimental)* | 2.05 / 2.06 | RoBERTa-large (seed 123) | Accuracy 95.4%, macro-F1 0.86 (random split) |

Each detector uses the best honestly-measured model found for that event type. "Experimental" means the testing is thinner (small or tuned-on test sets, or labels made by rules). Models that were tested but not selected, and every per-model metric, are on the **Model notes** page. Not included yet: a single frozen CFO model, restatements (4.02), cybersecurity (1.05).

**Caveats:** accuracy is scored against answer keys built from a separate large AI model plus rules, with disagreements hand-checked for some detectors, so treat the numbers as strong estimates, not guarantees. FilingLens is a research tool, not financial or legal advice.

## Pages

| Page | What it shows |
|---|---|
| **Overview** | What FilingLens does, all eleven detectors with their tested accuracy, and one detector (CEO changes) as a worked example of how every detector is measured |
| **Search filings** | A live version of the SEC filing search: keywords, company, form type, date range and a "type of event" filter. Click any filing to analyze it, or press **Analyze all results** |
| **Filing analysis** | Live progress with a countdown, then every event found across all detectors, how sure the AI is, how each reader voted, the evidence sentence, extracted details and a copyable JSON |
| **My analyses / Analysis** | Background analyses of whole searches (no cap). Progress, an activity log, Stop and Resume, and the finished spreadsheet with CSV / Excel download. Results appear while it runs and stay available by link after the page is closed |
| **Under the hood** | Drawings of the architecture, the steps for one filing, the 12 detectors, how the models were made, and the scores |
| **Test results** | The scoreboard method, and the CEO detector's flagged and missed events from March 2025, searchable, with links to the SEC filing |
| **Model notes** | Every model built and tested, with every metric from the project logs |

A header button picks which Kaggle account's free GPU runs the model server, shows live start-up progress, and turns it off. The server stops by itself after 7 minutes without real use.

## Architecture

```
Browser (React)  -->  Vercel serverless API (api/*.ts)  -->  SEC EDGAR (search, company list, filings)
                          |      |
                          |      +--> private Vercel Blob store (background analysis results)
                          |
                          +-->  ngrok tunnel  -->  Model service on a Kaggle GPU (backend/)  -->  private adapters (Kaggle dataset)
```

- `api/search`, `api/filings`, `api/companies`: proxy the SEC's public EDGAR endpoints (with the required contact User-Agent).
- `api/analyze`: starts and polls a model job. The browser never sees the model service address or key.
- `api/host`: picks the Kaggle account (it hides accounts that are out of GPU hours), starts and stops the model server, and reports start-up progress.
- `api/batch`: background analyses. The model server collects the filings of a search, analyzes them, and hands results back in small parts that are stored in a private Blob store. Pages read progress live from the server and the stored parts after it is gone.
- `backend/`: FastAPI service. It downloads the filing once, parses it two ways (plain text and table-preserving text), finds each Item's section, and runs every applicable detector with the exact pipeline that detector was trained and tested with (eleven detectors). LoRA adapters are merged into the base weights and sentences are batched by length. int8 quantization was tested and rejected because it changed real decisions.
- `backend/kaggle/`: the Kaggle GPU kernel template that boots the service and opens the tunnel.
- **The fine-tuned model files are never in this repository or on GitHub.** They live in a private Kaggle dataset (and a private Hugging Face repo) and are mounted by the model server at start-up.

## Tech stack

- React 18 + TypeScript, built with Vite
- No UI or chart libraries: charts are plain HTML/CSS, routing is a tiny hash router
- Light and dark themes follow the system setting; layout is responsive and keyboard accessible

## Run locally

```bash
npm install
npm run dev        # http://localhost:5173 (search and analysis need the Vercel API; use `vercel dev`)
npm run build      # type-checks and builds to dist/
npm run preview    # serve the production build
```

## Project layout

```
src/
  pages/        Overview, Search, Filing, Analysis, Analyses, HowItWorks, Explorer, ModelLab, Notes
  components/   DetectorCard, WaitLoader, ModelPower, StartPanel, StartProgress, BatchPanel, ResultSheet, CompanyPicker, Stat, Dots, BarChart, Highlight
  data/
    detectors.ts     the detector catalogue and its recorded accuracy
    notes.ts         all model experiments and metrics shown on the Model notes page
    march2025.json   real CEO predictions joined with the answer key (generated)
api/                serverless functions (SEC proxy + model proxy)
backend/            model service (FastAPI), Kaggle kernel template, background batch runner
  app/detect/       Item slicers, input builders and rule engines for the other detectors
scripts/
  build-data.mjs    regenerates march2025.json (maintainers only)
```

## Deploying

**Model server (Kaggle + ngrok)**: the site builds and starts the Kaggle kernel itself (`api/host.ts`, template in `backend/kaggle/server_template.py`). Each Kaggle account needs its API token in a Vercel environment variable and the private adapters dataset. See `backend/kaggle/README.md`.

**Website (Vercel)**: framework preset Vite, build command `npm run build`, output `dist`. Create a private Blob store (`vercel blob create-store <name> --access private`) for background analyses. Environment variables:

| Variable | Purpose |
|---|---|
| `SEC_USER_AGENT` | Contact string the SEC requires on automated requests, e.g. `Your Name you@example.com` |
| `MODEL_URL` | Public (ngrok) address of the model server |
| `MODEL_API_KEY` | Shared secret the model server expects, also used when it reports results back |
| `NGROK_AUTHTOKEN`, `NGROK_DOMAIN` | Tunnel credentials written into the private Kaggle kernel |
| `KAGGLE_TOKEN_<ACCOUNT>` | One Kaggle API token per account listed in `api/_accounts.ts` |
| `BLOB_READ_WRITE_TOKEN` | Added automatically when the Blob store is linked |

Without a running model server, search still works and the analysis pages explain the model is off.
