import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAccess } from './_auth.js'
import { UA, noDashes, one, padCik, secFetch } from './_sec.js'

// Market value of a company on a date, worked out two ways so they can be compared:
//   shares  = the cover-page share count from the company's latest 10-K / 10-Q filed on or before the date (SEC XBRL, dei:EntityCommonStockSharesOutstanding)
//   method 1 (SEC only)  price = the latest priced insider trade (Form 4, open-market buy/sell or tax-withholding) in the 120 days up to the date
//   method 2 (Yahoo)     price = the closing price on that day (or the last trading day before it) from Yahoo's chart data
// GET ?cik=320193&date=2025-02-10
const DAY = 86_400_000
const t = (ms = 9000) => AbortSignal.timeout(ms)

interface Fact { end: string; val: number; accn: string; form: string; filed: string }

async function shares(cik: string, date: string) {
  const r = await secFetch(`https://data.sec.gov/api/xbrl/companyconcept/CIK${padCik(cik)}/dei/EntityCommonStockSharesOutstanding.json`)
  if (!r.ok) return null
  const j = (await r.json()) as { units?: { shares?: Fact[] } }
  const facts = (j.units?.shares ?? []).filter((f) => f.filed <= date && f.val > 0)
  if (!facts.length) return null
  const latest = facts.reduce((a, b) => (b.filed > a.filed || (b.filed === a.filed && b.end > a.end) ? b : a))
  // several share classes are reported as several values in the same filing: add the distinct ones
  const same = facts.filter((f) => f.accn === latest.accn && f.end === latest.end)
  const classes = [...new Set(same.map((f) => f.val))]
  return { value: classes.reduce((a, b) => a + b, 0), classes: classes.length, asOf: latest.end, filed: latest.filed, form: latest.form, accession: latest.accn }
}

async function secPrice(cik: string, date: string) {
  const sub = await secFetch(`https://data.sec.gov/submissions/CIK${padCik(cik)}.json`)
  if (!sub.ok) return { error: `SEC submissions ${sub.status}` }
  const j = (await sub.json()) as { tickers?: string[]; name?: string; filings: { recent: { form: string[]; filingDate: string[]; accessionNumber: string[]; primaryDocument: string[] } } }
  const rc = j.filings.recent
  const lo = new Date(Date.parse(date) - 120 * DAY).toISOString().slice(0, 10)
  const forms: { acc: string; doc: string; filed: string }[] = []
  for (let i = 0; i < rc.form.length; i++) {
    if ((rc.form[i] === '4' || rc.form[i] === '4/A') && rc.filingDate[i] <= date && rc.filingDate[i] >= lo) forms.push({ acc: rc.accessionNumber[i], doc: rc.primaryDocument[i].split('/').pop() || '', filed: rc.filingDate[i] })
    if (forms.length >= 10) break
  }
  const rows: { date: string; price: number; shares: number; code: string; acc: string }[] = []
  for (const f of forms) {
    try {
      const x = await (await fetch(`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${noDashes(f.acc)}/${f.doc}`, { headers: { 'User-Agent': UA }, signal: t() })).text()
      for (const blk of x.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g) ?? []) {
        const d = /<transactionDate>\s*<value>([^<]+)/.exec(blk)?.[1]?.trim()
        const p = Number(/<transactionPricePerShare>\s*<value>([^<]+)/.exec(blk)?.[1])
        const sh = Number(/<transactionShares>\s*<value>([^<]+)/.exec(blk)?.[1]) || 0
        const code = /<transactionCode>([^<]+)/.exec(blk)?.[1]?.trim() || ''
        if (d && d <= date && d >= lo && p > 0 && ['P', 'S', 'F'].includes(code)) rows.push({ date: d, price: p, shares: sh, code, acc: f.acc })
      }
    } catch { /* one unreadable Form 4 is not fatal */ }
  }
  if (!rows.length) return { ticker: j.tickers?.[0] ?? '', name: j.name ?? '', error: 'no priced insider trade in the 120 days before the date' }
  const day = rows.reduce((a, b) => (b.date > a ? b.date : a), '')
  const same = rows.filter((r) => r.date === day)
  const w = same.reduce((a, r) => a + (r.shares || 1), 0)
  const price = same.reduce((a, r) => a + r.price * (r.shares || 1), 0) / w
  return { ticker: j.tickers?.[0] ?? '', name: j.name ?? '', price: Math.round(price * 100) / 100, priceDate: day, daysOld: Math.round((Date.parse(date) - Date.parse(day)) / DAY), trades: same.length, accession: same[0].acc }
}

async function yahooPrice(ticker: string, date: string) {
  if (!ticker) return { error: 'no ticker' }
  const end = Math.floor((Date.parse(date) + 2 * DAY) / 1000)
  const start = Math.floor((Date.parse(date) - 12 * DAY) / 1000)
  let status = 0
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${start}&period2=${end}&interval=1d&events=split`, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36', Accept: 'application/json' }, signal: t() })
      status = r.status
      if (!r.ok) continue
      const j = (await r.json()) as { chart?: { result?: { meta: { gmtoffset?: number }; timestamp?: number[]; indicators: { quote: { close: (number | null)[] }[] } }[] } }
      const res = j.chart?.result?.[0]
      if (!res?.timestamp) continue
      const off = (res.meta.gmtoffset ?? 0) * 1000
      let best: { d: string; c: number } | null = null
      res.timestamp.forEach((ts, i) => {
        const d = new Date(ts * 1000 + off).toISOString().slice(0, 10)
        const c = res.indicators.quote[0].close[i]
        if (c != null && d <= date && (!best || d > best.d)) best = { d, c }
      })
      if (best) return { price: Math.round((best as { c: number }).c * 100) / 100, priceDate: (best as { d: string }).d }
    } catch { /* try the other host */ }
  }
  return { error: status === 429 ? 'Yahoo is refusing this server for now (HTTP 429, too many requests)' : status ? `Yahoo answered HTTP ${status} with no price for that date` : 'Yahoo returned no price for that date' }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (!requireAccess(req, res)) return
  const cik = one(req.query.cik).replace(/\D/g, '')
  const date = one(req.query.date) || new Date().toISOString().slice(0, 10)
  if (!cik || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'bad_request', message: 'Give ?cik=…&date=YYYY-MM-DD.' })
  try {
    const [sh, sec] = await Promise.all([shares(cik, date), secPrice(cik, date)])
    const ticker = one(req.query.ticker) || ('ticker' in sec ? (sec.ticker as string) : '')
    const yh = await yahooPrice(ticker, date)
    const cap = (p?: number) => (sh && p ? Math.round(sh.value * p) : null)
    const secCap = cap('price' in sec ? sec.price : undefined)
    const yhCap = cap('price' in yh ? yh.price : undefined)
    return res.status(200).json({
      cik, date, ticker, name: 'name' in sec ? sec.name : '',
      shares: sh, sec: { ...sec, marketCap: secCap }, yahoo: { ...yh, marketCap: yhCap },
      differencePct: secCap && yhCap ? Math.round(((secCap - yhCap) / yhCap) * 10000) / 100 : null,
    })
  } catch (e) {
    return res.status(502).json({ error: 'upstream', message: `Could not compute the market value: ${String(e).slice(0, 160)}` })
  }
}
