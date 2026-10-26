import { get, put } from '@vercel/blob'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAccess } from './_auth.js'

// Daily closing prices that a person downloaded from Yahoo Finance themselves (the "Download" button on a ticker's Historical data page)
// and uploaded here. Yahoo refuses automated requests, so this is how Yahoo's numbers get into the site.
//   POST {ticker:'AAPL', csv:'Date,Open,High,Low,Close,Adj Close,Volume\n2025-02-10,...'}  -> stores the closes for that ticker
//   GET  ?ticker=AAPL                                                                      -> what is stored (first date, last date, count)
export const priceKey = (ticker: string) => `prices/yahoo_${ticker.toUpperCase().replace(/[^A-Z0-9.-]/g, '')}.json`

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
    const d = /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : (() => { const t = Date.parse(raw); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '' })()
    const p = Number((c[ci] || '').replace(/[",$]/g, ''))
    if (d && p > 0) out[d] = Math.round(p * 10000) / 10000
  }
  return out
}

export async function importedPrices(ticker: string): Promise<Record<string, number>> {
  try {
    const r = await get(priceKey(ticker), { access: 'private', useCache: false })
    if (r && r.statusCode === 200) return (JSON.parse(await new Response(r.stream).text()) as { rows: Record<string, number> }).rows || {}
  } catch { /* nothing stored */ }
  return {}
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (!requireAccess(req, res)) return
  const ticker = String(req.method === 'GET' ? req.query.ticker ?? '' : (req.body ?? {}).ticker ?? '').trim()
  if (!/^[A-Za-z0-9.-]{1,10}$/.test(ticker)) return res.status(400).json({ error: 'bad_request', message: 'Give a ticker such as AAPL.' })
  if (req.method === 'GET') {
    const rows = await importedPrices(ticker)
    const days = Object.keys(rows).sort()
    return res.status(200).json({ ticker: ticker.toUpperCase(), count: days.length, first: days[0] ?? null, last: days[days.length - 1] ?? null })
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' })
  try {
    const add = parseYahooCsv(String((req.body ?? {}).csv ?? ''))
    const n = Object.keys(add).length
    if (!n) return res.status(400).json({ error: 'empty', message: 'No prices were found in that file.' })
    const rows = { ...(await importedPrices(ticker)), ...add }
    await put(priceKey(ticker), JSON.stringify({ ticker: ticker.toUpperCase(), updated: new Date().toISOString(), rows }), { access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json' })
    const days = Object.keys(rows).sort()
    return res.status(200).json({ ok: true, ticker: ticker.toUpperCase(), added: n, count: days.length, first: days[0], last: days[days.length - 1] })
  } catch (e) {
    return res.status(400).json({ error: 'bad_file', message: e instanceof Error ? e.message : 'Could not read that file.' })
  }
}
