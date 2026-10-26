import { requireAccess } from './_auth.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { secFetch, one } from './_sec.js'

interface Company {
  cik: string
  name: string
  ticker: string
}

let cache: Company[] | null = null

async function load(): Promise<Company[]> {
  if (cache) return cache
  const r = await secFetch('https://www.sec.gov/files/company_tickers.json')
  if (!r.ok) throw new Error(`SEC responded ${r.status}`)
  const data = (await r.json()) as Record<string, { cik_str: number; ticker: string; title: string }>
  cache = Object.values(data).map((c) => ({ cik: String(c.cik_str), name: c.title, ticker: c.ticker }))
  return cache
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAccess(req, res)) return
  const q = one(req.query.q).trim().toLowerCase()
  if (q.length < 1) return res.status(200).json({ companies: [] })
  try {
    const all = await load()
    const scored: { c: Company; s: number }[] = []
    for (const c of all) {
      const n = c.name.toLowerCase()
      const t = c.ticker.toLowerCase()
      let s = 0
      if (t === q || c.cik === q) s = 100
      else if (t.startsWith(q)) s = 80
      else if (n.startsWith(q)) s = 70
      else if (n.includes(q)) s = 40
      if (s) scored.push({ c, s })
    }
    scored.sort((a, b) => b.s - a.s || a.c.name.localeCompare(b.c.name))
    res.setHeader('Cache-Control', 'private, max-age=3600')
    return res.status(200).json({ companies: scored.slice(0, 8).map((x) => x.c) })
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach the SEC company list.', detail: String(e) })
  }
}
