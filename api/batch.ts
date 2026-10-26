import { requireAccess } from './_auth.js'
import { randomBytes } from 'node:crypto'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { get, put } from '@vercel/blob'
import { one } from './_sec.js'
import { modelUrl, tunnelDown } from './_model.js'

// Background analyses. The model server does the work and hands the answers to this function in small parts; they are
// stored in a private Blob store, so a person can close the page and open the same link later.
//   POST {action:'create', search | filings, title}   start an analysis (the model server must be on)
//   POST {action:'stop' | 'resume', id}
//   POST {action:'save', id, patch?, part?}           model server only (needs the API key)
//   GET  ?id=<id>                                     progress          GET ?id=<id>&part=<n>   one stored part
const TOKEN = process.env.MODEL_API_KEY || ''
const ID = /^[0-9a-f]{16}$/
const LIVE = ['queued', 'collecting', 'running']
const STALE_MS = 5 * 60 * 1000 // a running analysis that has sent nothing for this long has lost its server

interface Meta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  status: 'queued' | 'collecting' | 'running' | 'done' | 'stopped' | 'interrupted' | 'error'
  total: number
  done: number
  errors: number
  parts: number
  search?: Record<string, string>
  filings?: unknown[]
  message?: string
  startedAt?: number
  finishedAt?: number
}

const key = (id: string, name: string) => `batches/${id}/${name}`

async function readBlob<T>(pathname: string): Promise<T | null> {
  const r = await get(pathname, { access: 'private', useCache: false })
  if (!r || r.statusCode !== 200) return null
  return JSON.parse(await new Response(r.stream).text()) as T
}

const writeBlob = (pathname: string, data: unknown) =>
  put(pathname, JSON.stringify(data), { access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 60 })

/** Calls the model server. `offline` means nothing is listening (it is switched off or still booting). */
async function model(path: string, init: RequestInit = {}, ms = 15000): Promise<{ ok: boolean; offline: boolean; status: number; body: any }> {
  const SPACE = await modelUrl()
  if (!SPACE) return { ok: false, offline: true, status: 503, body: {} }
  try {
    const r = await fetch(`${SPACE}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': '1' },
      signal: AbortSignal.timeout(ms),
    })
    if (tunnelDown(r)) return { ok: false, offline: true, status: 503, body: {} }
    const body = await r.json().catch(() => ({}))
    return { ok: r.ok, offline: false, status: r.status, body }
  } catch {
    return { ok: false, offline: true, status: 503, body: {} }
  }
}

const recent = new Map<string, number[]>()
function tooMany(ip: string): boolean {
  const now = Date.now()
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < 10 * 60 * 1000)
  hits.push(now)
  recent.set(ip, hits)
  return hits.length > 12
}

const clean = (v: unknown, max = 200) => String(v ?? '').slice(0, max)

function searchOf(b: any): Record<string, string> | undefined {
  const s = b?.search
  if (!s || typeof s !== 'object') return undefined
  return { q: clean(s.q), forms: clean(s.forms, 40), start: /^\d{4}-\d{2}-\d{2}$/.test(s.start) ? s.start : '', end: /^\d{4}-\d{2}-\d{2}$/.test(s.end) ? s.end : '', cik: /^\d{1,10}$/.test(s.cik) ? s.cik : '', item: /^\d\.\d{2}$/.test(s.item) ? s.item : '' }
}

function filingsOf(b: any): unknown[] | undefined {
  if (!Array.isArray(b?.filings)) return undefined
  return b.filings
    .filter((f: any) => /^\d{1,10}$/.test(String(f?.cik)) && /^\d{10}-\d{2}-\d{6}$/.test(String(f?.accession)))
    .slice(0, 500)
    .map((f: any) => ({
      accession: f.accession, cik: String(f.cik), company: clean(f.company), ticker: clean(f.ticker, 20), date: clean(f.date, 10), form: clean(f.form, 20),
      items: Array.isArray(f.items) ? f.items.map((i: unknown) => clean(i, 8)).slice(0, 30) : [], location: clean(f.location), description: clean(f.description),
      docUrl: clean(f.docUrl, 400), indexUrl: clean(f.indexUrl, 400),
    }))
}

/** What the model server says is happening now, laid over what was stored. */
async function view(meta: Meta): Promise<Meta & { live: boolean }> {
  if (!LIVE.includes(meta.status)) return { ...meta, live: false }
  const r = await model(`/batches/${meta.id}`, {}, 4000)
  if (r.ok && r.body?.status) {
    const b = r.body
    return { ...meta, status: b.status, total: Math.max(b.total ?? 0, meta.total), done: b.done ?? meta.done, errors: b.errors ?? meta.errors, message: b.message || meta.message, updatedAt: Math.max(meta.updatedAt, b.updatedAt ?? 0), live: true }
  }
  if (Date.now() - meta.updatedAt > STALE_MS) {
    return { ...meta, status: 'interrupted', message: meta.message || 'The model server stopped before this analysis finished. Turn it on again and press Resume.', live: false }
  }
  return { ...meta, live: false }
}

async function doneAccessions(meta: Meta): Promise<string[]> {
  const ok = new Set<string>()
  const bad = new Set<string>()
  for (let n = 0; n < meta.parts; n++) {
    const part = await readBlob<{ filing: { accession: string }; result?: unknown }[]>(key(meta.id, `part-${n}.json`))
    for (const e of part ?? []) (e.result ? ok : bad).add(e.filing.accession)
  }
  bad.forEach((a) => ok.has(a) && bad.delete(a)) // a retry that worked clears the old error
  return [...ok]
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAccess(req, res)) return
  res.setHeader('Cache-Control', 'no-store')
  if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(503).json({ error: 'not_configured', message: 'Analysis storage is not connected yet.' })
  try {
    // ---------------------------------------------------------------- reading
    if (req.method === 'GET') {
      const id = one(req.query.id)
      if (!ID.test(id)) return res.status(400).json({ error: 'bad_request', message: 'That is not a valid analysis link.' })
      // live=1: a page that already has the analysis's details asks only the model server, which is quicker and costs no storage reads.
      // It answers with the counts plus the finished filings that are not stored yet.
      if (one(req.query.live)) {
        const r = await model(`/batches/${id}/tail`, {}, 5000)
        if (r.ok && r.body?.status) {
          const b = r.body
          return res.status(200).json({ live: true, status: b.status, total: b.total, done: b.done, errors: b.errors, message: b.message || '', updatedAt: b.updatedAt, parts: b.parts, tail: b.items ?? [] })
        }
        // the server cannot be reached: fall through to what is stored
      }
      const part = one(req.query.part)
      if (part) {
        const items = await readBlob<unknown[]>(key(id, `part-${parseInt(part, 10) || 0}.json`))
        return items ? res.status(200).json({ items }) : res.status(404).json({ error: 'not_found', message: 'That part is not stored.' })
      }
      const meta = await readBlob<Meta>(key(id, 'meta.json'))
      if (!meta) return res.status(404).json({ error: 'not_found', message: 'No analysis was found for this link. It may have been removed.' })
      const { filings: _f, ...rest } = await view(meta)
      return res.status(200).json(rest)
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const body = (req.body ?? {}) as any
    const action = String(body.action ?? '')

    // ---------------------------------------------------------------- the model server reporting back
    if (action === 'save') {
      if (!TOKEN || req.headers.authorization !== `Bearer ${TOKEN}`) return res.status(401).json({ error: 'unauthorized' })
      const id = String(body.id ?? '')
      if (!ID.test(id)) return res.status(400).json({ error: 'bad_request' })
      const meta = await readBlob<Meta>(key(id, 'meta.json'))
      if (!meta) return res.status(404).json({ error: 'not_found' })
      const p = body.part
      if (p && Number.isInteger(p.n) && p.n >= 0 && Array.isArray(p.items)) {
        await writeBlob(key(id, `part-${p.n}.json`), p.items)
        meta.parts = Math.max(meta.parts, p.n + 1)
      }
      const patch = body.patch ?? {}
      for (const k of ['status', 'total', 'done', 'errors', 'message', 'startedAt', 'finishedAt', 'parts'] as const) {
        if (patch[k] !== undefined) (meta as any)[k] = typeof patch[k] === 'string' ? patch[k].slice(0, 400) : patch[k]
      }
      if (patch.status === 'running' && !meta.startedAt) meta.startedAt = Date.now()
      meta.updatedAt = Date.now()
      await writeBlob(key(id, 'meta.json'), meta)
      const stop = await readBlob<{ stop: boolean }>(key(id, 'stop.json'))
      return res.status(200).json({ ok: true, stop: !!stop?.stop })
    }

    // ---------------------------------------------------------------- people using the site
    const ip = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || 'unknown'

    if (action === 'create') {
      if (tooMany(ip)) return res.status(429).json({ error: 'too_many', message: 'Too many analyses started from this connection. Wait a few minutes.' })
      const search = searchOf(body)
      const filings = filingsOf(body)
      if (!search && !filings?.length) return res.status(400).json({ error: 'bad_request', message: 'Nothing to analyze.' })
      const id = randomBytes(8).toString('hex')
      const now = Date.now()
      const meta: Meta = { id, title: clean(body.title, 160) || 'Analysis', createdAt: now, updatedAt: now, status: 'queued', total: filings?.length ?? 0, done: 0, errors: 0, parts: 0, ...(filings?.length ? { filings } : { search }) }
      const base = `https://${req.headers.host}`
      // check the server is up before storing anything, so failed attempts cost nothing
      const up = await model('/health', {}, 8000)
      if (up.offline || !up.body?.ok) {
        return res.status(503).json({ error: up.offline ? 'model_offline' : 'model_unavailable', message: up.offline ? 'The AI model is not on. Use “Turn on AI model” at the top, wait for it to finish starting, then start the analysis.' : 'The AI model is still loading. Wait until it shows as on, then try again.' })
      }
      // stored first: the server starts reporting back as soon as it is told about the analysis
      await writeBlob(key(id, 'meta.json'), meta)
      await writeBlob(key(id, 'stop.json'), { stop: false })
      const r = await model('/batches', { method: 'POST', body: JSON.stringify({ id, base, search: filings?.length ? undefined : search, filings: filings?.length ? filings : undefined, skip: [], part: 0 }) }, 20000)
      if (!r.ok) {
        await writeBlob(key(id, 'meta.json'), { ...meta, status: 'error', message: 'The model server did not accept this analysis.' })
        const old = r.status === 404 || r.status === 405
        return res.status(503).json({ error: r.offline ? 'model_offline' : 'model_unavailable', message: old ? 'The running AI server is an older version that cannot do background analyses. Press “Turn off”, then turn it on again to get the new version.' : r.body?.detail || 'The model server did not accept the analysis. Try again in a moment.' })
      }
      return res.status(200).json({ id })
    }

    const id = String(body.id ?? '')
    if (!ID.test(id)) return res.status(400).json({ error: 'bad_request', message: 'That is not a valid analysis link.' })
    const stored = await readBlob<Meta>(key(id, 'meta.json'))
    if (!stored) return res.status(404).json({ error: 'not_found', message: 'No analysis was found for this link.' })
    const meta = await view(stored)

    if (action === 'stop') {
      await writeBlob(key(id, 'stop.json'), { stop: true })
      const r = LIVE.includes(meta.status) ? await model(`/batches/${id}/stop`, { method: 'POST', body: '{}' }, 6000) : { ok: false }
      if (!r.ok && LIVE.includes(stored.status)) {
        // nobody is running it any more: mark it stopped ourselves
        const { live: _l, filings: _f, ...rest } = meta
        await writeBlob(key(id, 'meta.json'), { ...stored, status: 'stopped', done: rest.done, errors: rest.errors, updatedAt: Date.now(), finishedAt: Date.now() })
      }
      return res.status(200).json({ ok: true })
    }

    if (action === 'resume') {
      if (!['interrupted', 'stopped', 'error'].includes(meta.status)) return res.status(409).json({ error: 'not_resumable', message: 'This analysis is already running or finished.' })
      if (tooMany(ip)) return res.status(429).json({ error: 'too_many', message: 'Too many requests from this connection. Wait a few minutes.' })
      const skip = await doneAccessions(stored)
      await writeBlob(key(id, 'stop.json'), { stop: false })
      await writeBlob(key(id, 'meta.json'), { ...stored, status: 'queued', message: '', done: skip.length, errors: 0, updatedAt: Date.now(), finishedAt: undefined })
      const r = await model('/batches', { method: 'POST', body: JSON.stringify({ id, base: `https://${req.headers.host}`, search: stored.search, filings: stored.filings, skip, part: stored.parts }) }, 20000)
      if (!r.ok) {
        await writeBlob(key(id, 'meta.json'), { ...stored, status: meta.status, message: meta.message, updatedAt: stored.updatedAt })
        return res.status(503).json({ error: r.offline ? 'model_offline' : 'model_unavailable', message: r.offline ? 'The AI model is not on. Turn it on first, then press Resume.' : r.body?.detail || 'The model server is not ready yet.' })
      }
      return res.status(200).json({ ok: true })
    }
    return res.status(400).json({ error: 'bad_request', message: 'Unknown action.' })
  } catch (e) {
    return res.status(502).json({ error: 'storage_error', message: 'Could not reach the analysis storage.', detail: String(e) })
  }
}
