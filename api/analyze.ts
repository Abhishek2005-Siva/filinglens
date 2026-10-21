import type { VercelRequest, VercelResponse } from '@vercel/node'
import { one } from './_sec.js'
import { modelUrl, tunnelDown } from './_model.js'

// Thin, authenticated proxy to the private model service (hosted on Modal).
// POST  {cik, accession}  -> {id}        start analysing a filing
// GET   ?job=<id>         -> job status/result
// GET   ?health=1         -> model readiness
const TOKEN = process.env.MODEL_API_KEY || ''

// Modal answers with plain text ("modal-http: workspace ... is disabled") when the host refuses to run the app.
async function readJson(r: Response): Promise<{ body: any; hostError?: string; hostKind?: 'offline' | 'blocked'; hostCode?: string }> {
  const text = await r.text()
  // ngrok answers with its own error code when the tunnel is up but the model server behind it is not running.
  const ngrokCode = r.headers.get('ngrok-error-code') || ''
  if (tunnelDown(r)) {
    return { body: {}, hostKind: 'offline', hostCode: ngrokCode || undefined, hostError: 'The model server is not running right now. It starts on demand (on a free Kaggle GPU). Use “Turn on AI model” at the top, then wait. Once Kaggle gives it a GPU it takes 2–3 minutes; Kaggle’s queue can add more.' }
  }
  try {
    return { body: JSON.parse(text) }
  } catch {
    const m = text.match(/modal-http:\s*([^\n]{0,200})/i)
    if (m) {
      const msg = /disabled|spend|limit|billing|payment/i.test(m[1])
        ? 'The model host (Modal) has paused the workspace, most likely because its spend limit was reached. Raise the limit or add billing in the Modal dashboard, then try again.'
        : `The model host reported: ${m[1]}`
      return { body: {}, hostError: msg, hostKind: 'blocked' }
    }
    return { body: {} }
  }
}

async function call(path: string, init?: RequestInit) {
  const SPACE = await modelUrl()
  if (!SPACE) throw new Error('no model address registered yet')
  return fetch(`${SPACE}${path}`, {
    ...init,
    headers: { ...(init?.headers || {}), Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1' },
  })
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  try {
    if (req.method === 'POST' && (req.body ?? {}).selftest) {
      // Runs every model once on the server; loads any that are not loaded yet, so it can take a while.
      const r = await call('/selftest', { method: 'POST', body: '{}', signal: AbortSignal.timeout(120000) })
      const { body, hostError, hostKind } = await readJson(r)
      if (hostError) return res.status(503).json({ error: hostKind === 'offline' ? 'model_offline' : 'model_host', message: hostError })
      return res.status(r.ok ? 200 : 502).json(body.results ? body : { ok: false })
    }
    if (req.method === 'POST') {
      const { cik, accession } = (req.body ?? {}) as { cik?: string; accession?: string }
      if (!/^\d{1,10}$/.test(String(cik)) || !/^\d{10}-\d{2}-\d{6}$/.test(String(accession))) {
        return res.status(400).json({ error: 'bad_request', message: 'A valid CIK and accession number are required.' })
      }
      const r = await call('/jobs', { method: 'POST', body: JSON.stringify({ cik: String(cik), accession }) })
      const { body, hostError, hostKind } = await readJson(r)
      if (hostError) return res.status(503).json({ error: hostKind === 'offline' ? 'model_offline' : 'model_host', message: hostError })
      return res.status(r.status).json(r.ok ? body : { error: 'model_unavailable', message: body.detail || 'The model service is not ready.' })
    }
    if (one(req.query.health)) {
      // Pinging a sleeping service starts it. Don't hold the request open while it boots:
      // answer "waking" after a few seconds and let the browser ask again.
      try {
        const r = await call('/health', { signal: AbortSignal.timeout(8000) })
        const { body, hostError, hostKind, hostCode } = await readJson(r)
        if (hostError) return res.status(200).json({ ok: false, hostError, hostKind, hostCode })
        return res.status(200).json(Object.keys(body).length ? body : { ok: false, loading: true })
      } catch {
        return res.status(200).json({ ok: false, loading: true, waking: true })
      }
    }
    const job = one(req.query.job)
    if (!/^[a-f0-9]{6,32}$/.test(job)) return res.status(400).json({ error: 'bad_request', message: 'Missing job id.' })
    const r = await call(`/jobs/${job}`)
    const { body, hostError, hostKind } = await readJson(r)
    if (hostError) return res.status(503).json({ error: hostKind === 'offline' ? 'model_offline' : 'model_host', message: hostError })
    return res.status(r.status).json(Object.keys(body).length ? body : { error: 'bad_response' })
  } catch (e) {
    // A sleeping Space can take a minute to wake; the UI shows this as "waking up".
    return res.status(502).json({ error: 'model_unreachable', message: 'The model service is waking up. Try again in a minute.', detail: String(e) })
  }
}
