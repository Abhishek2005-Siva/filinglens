import { del, get, list, put } from '@vercel/blob'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAccess } from './_auth.js'

// Closing prices kept by the site: the ones read from Yahoo Finance's public page and the ones a person uploaded from a Yahoo CSV.
// They are a cache, not a record, so they expire: a stored price is used for 7 days, or for 6 hours when it is for a day within the last 3 days (a recent
// close can still be revised, and a split changes every earlier close). A daily job (see vercel.json) deletes what has expired. Values a person typed into a
// filing's market-value card (api/manual.ts) are their own entries, not cache, and are never deleted by this.
//   POST {ticker:'AAPL', csv:'Date,Open,High,Low,Close,Adj Close,Volume\n2025-02-10,...'}  -> stores the closes for that ticker
//   GET  ?ticker=AAPL                                                                      -> what is stored (first date, last date, count)
//   GET  ?cleanup=1                                                                        -> deletes expired prices (the daily job calls this)
export const TTL_DAYS = 7
export const TTL_MS = TTL_DAYS * 86_400_000
export const RECENT_TTL_MS = 6 * 3_600_000
export const priceKey = (ticker: string) => `prices/yahoo_${ticker.toUpperCase().replace(/[^A-Z0-9.-]/g, '')}.json`

/** True when a stored value fetched at `at` (ms) for the trading day `day` (YYYY-MM-DD) may still be used. */
export const fresh = (at: number | undefined, day: string, now = Date.now()): boolean => {
  if (!at) return false
  const recent = Date.parse(day) > now - 3 * 86_400_000
  return now - at < (recent ? RECENT_TTL_MS : TTL_MS)
}

interface Stored { ticker: string; updated: string; rows: Record<string, number>; at?: Record<string, number> }

const splitCsv = (line: string): string[] => (line.match(/("([^"]|"")*"|[^,]*)(,|$)/g) ?? []).map((x) => x.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"')).slice(0, -1)

export function parseYahooCsv(csv: string): Record<string, number> {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (lines.length < 2) return {}
  const head = splitCsv(lines[0]).map((h) => h.trim().toLowerCase())
  const di = head.indexOf('date'), ci = head.indexOf('close')
  if (di < 0 || ci < 0) throw new Error('The file needs a "Date" column and a "Close" column (the file Yahoo gives you has both).')
  const out: Record<string, number> = {}
  for (const l of lines.slice(1, 6001)) {
    const c = splitCsv(l)
    const raw = (c[di] || '').trim().replace(/"/g, '')
    const d = /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : (() => { const t = Date.parse(raw); if (!Number.isFinite(t)) return ''; const x = new Date(t); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}` })()
    const p = Number((c[ci] || '').replace(/[",$]/g, ''))
    if (d && p > 0) out[d] = Math.round(p * 10000) / 10000
  }
  return out
}

async function readStored(ticker: string): Promise<Stored | null> {
  try {
    const r = await get(priceKey(ticker), { access: 'private', useCache: false })
    if (r && r.statusCode === 200) return JSON.parse(await new Response(r.stream).text()) as Stored
  } catch { /* nothing stored */ }
  return null
}

/** Stored closes that are still fresh, as {day: close}. */
export async function importedPrices(ticker: string): Promise<Record<string, number>> {
  const s = await readStored(ticker)
  if (!s) return {}
  const legacy = Date.parse(s.updated) || 0 // files written before each day had its own time
  const out: Record<string, number> = {}
  for (const [day, close] of Object.entries(s.rows || {})) if (fresh(s.at?.[day] ?? legacy, day)) out[day] = close
  return out
}

/** Adds closes to what is stored for a ticker (newer values replace older ones for the same day); expired days are dropped. Returns the sorted stored days. */
export async function storePrices(ticker: string, add: Record<string, number>): Promise<string[]> {
  const now = Date.now()
  const cur = await readStored(ticker)
  const legacy = cur ? Date.parse(cur.updated) || 0 : 0
  const rows: Record<string, number> = {}, at: Record<string, number> = {}
  for (const [day, close] of Object.entries(cur?.rows ?? {})) {
    const t = cur?.at?.[day] ?? legacy
    if (fresh(t, day, now)) { rows[day] = close; at[day] = t }
  }
  for (const [day, close] of Object.entries(add)) { rows[day] = close; at[day] = now }
  await put(priceKey(ticker), JSON.stringify({ ticker: ticker.toUpperCase(), updated: new Date(now).toISOString(), rows, at } satisfies Stored), { access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json' })
  return Object.keys(rows).sort()
}

/** Deletes expired prices: whole files that are old, and expired days inside files that are not. Manual entries live under manual/ and are not touched. */
async function cleanup() {
  const now = Date.now()
  let deleted = 0, trimmed = 0, kept = 0, cursor: string | undefined
  do {
    const page = await list({ prefix: 'prices/', limit: 500, cursor })
    cursor = page.cursor
    for (const b of page.blobs) {
      try {
        if (b.pathname.startsWith('prices/yahoo_')) {
          const r = await get(b.pathname, { access: 'private', useCache: false })
          const s = r && r.statusCode === 200 ? (JSON.parse(await new Response(r.stream).text()) as Stored) : null
          const legacy = Date.parse(s?.updated ?? '') || b.uploadedAt.getTime()
          const rows: Record<string, number> = {}, at: Record<string, number> = {}
          for (const [day, close] of Object.entries(s?.rows ?? {})) {
            const t = s?.at?.[day] ?? legacy
            if (fresh(t, day, now)) { rows[day] = close; at[day] = t }
          }
          const n = Object.keys(rows).length
          if (!n) { await del(b.pathname); deleted++ }
          else if (n < Object.keys(s?.rows ?? {}).length) { await put(b.pathname, JSON.stringify({ ...s, rows, at }), { access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json' }); trimmed++ }
          else kept++
        } else {
          await del(b.pathname); deleted++ // anything else under prices/ is left over from a feed that is no longer used
        }
      } catch { /* one unreadable file does not stop the cleanup */ }
    }
  } while (cursor)
  return { deletedFiles: deleted, trimmedFiles: trimmed, keptFiles: kept, ttlDays: TTL_DAYS }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  // the daily cleanup (called by Vercel's scheduler, or by a signed-in person) only ever removes expired cache
  if (req.method === 'GET' && req.query.cleanup && (String(req.headers['user-agent'] || '').startsWith('vercel-cron') || requireAccess(req, res, { location: false }))) {
    return res.status(200).json(await cleanup())
  }
  if (res.headersSent || res.writableEnded) return
  if (!requireAccess(req, res)) return
  const ticker = String(req.method === 'GET' ? req.query.ticker ?? '' : (req.body ?? {}).ticker ?? '').trim()
  if (!/^[A-Za-z0-9.-]{1,10}$/.test(ticker)) return res.status(400).json({ error: 'bad_request', message: 'Give a ticker such as AAPL.' })
  if (req.method === 'GET') {
    const rows = await importedPrices(ticker)
    const days = Object.keys(rows).sort()
    return res.status(200).json({ ticker: ticker.toUpperCase(), count: days.length, first: days[0] ?? null, last: days[days.length - 1] ?? null, keptForDays: TTL_DAYS })
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' })
  try {
    const add = parseYahooCsv(String((req.body ?? {}).csv ?? ''))
    const n = Object.keys(add).length
    if (!n) return res.status(400).json({ error: 'empty', message: 'No prices were found in that file.' })
    const days = await storePrices(ticker, add)
    return res.status(200).json({ ok: true, ticker: ticker.toUpperCase(), added: n, count: days.length, first: days[0], last: days[days.length - 1], keptForDays: TTL_DAYS })
  } catch (e) {
    return res.status(400).json({ error: 'bad_file', message: e instanceof Error ? e.message : 'Could not read that file.' })
  }
}
