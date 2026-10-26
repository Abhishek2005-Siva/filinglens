import { get, put } from '@vercel/blob'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAccess } from './_auth.js'

// Values a person typed in when the automatic lookup found nothing (the closing price on the filing date, and/or the share count).
//   POST {cik, date, price?, shares?}   -> saves them (a value of 0 or null removes it)
//   GET  ?cik=…&date=…                  -> what is saved
export interface Manual { price?: number; shares?: number; at?: string }
const path = (cik: string, date: string) => `manual/${cik.replace(/\D/g, '')}_${date}.json`

export async function manualFor(cik: string, date: string): Promise<Manual> {
  try {
    const r = await get(path(cik, date), { access: 'private', useCache: false })
    if (r && r.statusCode === 200) return JSON.parse(await new Response(r.stream).text()) as Manual
  } catch { /* nothing saved */ }
  return {}
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (!requireAccess(req, res)) return
  const src = (req.method === 'GET' ? req.query : req.body ?? {}) as Record<string, string | number | null | undefined>
  const cik = String(src.cik ?? '').replace(/\D/g, '')
  const date = String(src.date ?? '')
  if (!cik || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'bad_request', message: 'Give the company and the date.' })
  if (req.method === 'GET') return res.status(200).json(await manualFor(cik, date))
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' })
  const cur = await manualFor(cik, date)
  const next: Manual = { ...cur, at: new Date().toISOString() }
  for (const k of ['price', 'shares'] as const) {
    if (!(k in src)) continue
    const v = Number(src[k])
    if (src[k] === null || src[k] === '' || v === 0) delete next[k]
    else if (!Number.isFinite(v) || v < 0 || (k === 'price' && v > 1e7) || (k === 'shares' && v > 1e13)) return res.status(400).json({ error: 'bad_value', message: `That ${k === 'price' ? 'price' : 'share count'} does not look right.` })
    else next[k] = v
  }
  await put(path(cik, date), JSON.stringify(next), { access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json' })
  return res.status(200).json({ ok: true, ...next })
}
