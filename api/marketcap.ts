import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAccess } from './_auth.js'
import { manualFor } from './manual.js'
import { importedPrices } from './prices.js'
import { UA, noDashes, one, padCik, secFetch } from './_sec.js'

// Market value of a company on a date, worked out two ways so they can be compared:
//   shares  = the cover-page share count from the company's latest 10-K / 10-Q filed on or before the date (SEC XBRL, dei:EntityCommonStockSharesOutstanding)
//   method 1 (SEC only)  price = the latest priced insider trade (Form 4, open-market buy/sell or tax-withholding) in the 120 days up to the date
//   method 2 (Yahoo)     price = the closing price on that day (or the last trading day before it) read from Yahoo Finance's public page; a person can type it in if that fails
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

/** The closing price on or before the date, from the closes the site holds for the ticker: read from Yahoo Finance's public page (api/yahoo.ts, which stores
 *  them) or uploaded from a Yahoo CSV. They expire (see prices.ts). Nothing is fetched here: when nothing is stored the card asks api/yahoo.ts to read
 *  the page, and if that finds nothing the person can type the price in (api/manual.ts) or leave it empty. */
async function closingPrice(ticker: string, date: string): Promise<{ price?: number; priceDate?: string; source?: string; error?: string }> {
  if (!ticker) return { error: 'no ticker for this company' }
  const mine = await importedPrices(ticker)
  const lo = new Date(Date.parse(date) - 10 * DAY).toISOString().slice(0, 10)
  const day = Object.keys(mine).filter((d) => d <= date && d >= lo).sort().pop()
  if (day) return { price: Math.round(mine[day] * 100) / 100, priceDate: day, source: 'Yahoo Finance' }
  return { error: 'No stored Yahoo price for this ticker and date.' }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (!requireAccess(req, res)) return
  const cik = one(req.query.cik).replace(/\D/g, '')
  const date = one(req.query.date) || new Date().toISOString().slice(0, 10)
  if (!cik || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'bad_request', message: 'Give ?cik=…&date=YYYY-MM-DD.' })
  try {
    const T = { start: Date.now(), shares: 0, sec: 0, price: 0, manual: 0 }
    const timed = async <X,>(k: 'shares' | 'sec', p: Promise<X>) => { const r = await p; T[k] = Date.now() - T.start; return r }
    const [sh0, sec] = await Promise.all([timed('shares', shares(cik, date)), timed('sec', secPrice(cik, date))])
    const ticker = one(req.query.ticker) || ('ticker' in sec ? (sec.ticker as string) : '')
    const t1 = Date.now()
    const [yh0, man] = await Promise.all([closingPrice(ticker, date), manualFor(cik, date)])
    T.price = Date.now() - t1
    // values a person typed in win over the automatic ones
    const sh = man.shares ? { value: man.shares, classes: 1, asOf: date, filed: date, form: 'entered by hand', accession: '' } : sh0
    const yh = man.price ? { price: man.price, priceDate: date, source: 'Entered by hand' } : yh0
    const cap = (p?: number) => (sh && p ? Math.round(sh.value * p) : null)
    const secCap = cap('price' in sec ? sec.price : undefined)
    const yhCap = cap('price' in yh ? yh.price : undefined)
    return res.status(200).json({
      cik, date, ticker, name: 'name' in sec ? sec.name : '',
      shares: sh, sec: { ...sec, marketCap: secCap }, market: { ...yh, marketCap: yhCap },
      differencePct: secCap && yhCap ? Math.round(((secCap - yhCap) / yhCap) * 10000) / 100 : null,
      manual: { price: !!man.price, shares: !!man.shares },
      timings: { sharesMs: T.shares, secMs: T.sec, priceLookupMs: T.price, totalMs: Date.now() - T.start },
    })
  } catch (e) {
    return res.status(502).json({ error: 'upstream', message: `Could not compute the market value: ${String(e).slice(0, 160)}` })
  }
}
