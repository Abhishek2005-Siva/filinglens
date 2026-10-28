import type { Browser, Page } from 'puppeteer-core'
import { launchBrowser } from './_browser.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAccess } from './_auth.js'
import { storePrices } from './prices.js'
import { UA, one } from './_sec.js'

// Reads Yahoo Finance's public history page in a headless browser on the server and stores the closes (they are kept for a few days only, see prices.ts).
// Pictures, fonts and video are not downloaded, which is most of the page weight. A sign-in, a CAPTCHA or an error page is reported, not worked around.
//   GET  ?ticker=AAPL&from=2025-02-01&to=2025-02-14[&quote=1]     one company (the filing page uses this)
//   POST {items:[{ticker,from,to},…], tabs?:1–5}                  many companies: one browser, a few tabs side by side
// A call never runs past about 40 seconds; companies it did not reach are returned in `remaining` so the caller can send them again.
interface Item { ticker: string; from: string; to: string }
const valid = (i: Item) => /^[A-Z0-9.-]{1,10}$/.test(i.ticker) && /^\d{4}-\d{2}-\d{2}$/.test(i.from) && /^\d{4}-\d{2}-\d{2}$/.test(i.to)
const BLOCKED = /too many requests|unusual traffic|captcha|access denied|robot/i
const DEADLINE_MS = 40_000

const launch = (): Promise<Browser> => launchBrowser()
/** Pictures, fonts and video are never needed. In the light mode scripts and style sheets are skipped too: the price table is already in the page that Yahoo
 *  sends, so the page opens in a fraction of the time and uses very little processor (which is what limits how many tabs can work side by side). */
async function lean(page: Page, light: boolean) {
  await page.setRequestInterception(true)
  page.on('request', (r) => {
    const t = r.resourceType()
    ;['image', 'media', 'font'].includes(t) || (light && ['script', 'stylesheet'].includes(t)) ? void r.abort() : void r.continue()
  })
  if (light) await page.setJavaScriptEnabled(false)
}
async function accept(page: Page, log?: string[]) {
  const btn = (await page.$('button[name="agree"]')) || (await page.$('button.accept-all'))
  if (btn) { await btn.click(); await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => undefined); log?.push('cookie dialog: pressed Accept all') }
}



// ---- plain page fetch (no browser): Yahoo sends the market cap and the price table inside the page itself, and answers a request that identifies itself honestly
// (the same User-Agent with contact details that the SEC requires). This takes a fraction of a second and uses none of the browser allowance. Anything unexpected
// (an HTTP error, a consent page, a changed layout) returns null and the browser path below takes over.
type GetBrowser = () => Promise<Browser>
let plainNote = '' // what the last plain fetch got (shown when the browser fallback also fails), e.g. "plain fetch: HTTP 429"

/** The part of a page between two markers, read from the network stream; stops downloading as soon as it has it (the markers sit about a third into a 1 MB page). */
async function between(url: string, start: string, end: string, until: number): Promise<{ status: number; text: string } | null> {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(Math.max(4000, Math.min(15_000, until - Date.now()))) }).catch(() => null)
  if (!r) { plainNote = 'plain fetch: no answer'; return null }
  plainNote = `plain fetch: HTTP ${r.status}`
  if (!r.ok || !r.body) { await r.body?.cancel().catch(() => undefined); return { status: r.status, text: '' } }
  const reader = r.body.getReader(), dec = new TextDecoder()
  let buf = '', from = -1, seen = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      seen += value.length
      if (from < 0) {
        from = buf.indexOf(start)
        if (from < 0) { buf = buf.slice(-start.length); continue }
        buf = buf.slice(from); from = 0
      }
      const e = buf.indexOf(end, start.length)
      if (e >= 0) return { status: r.status, text: buf.slice(0, e + end.length) }
      if (seen > 4_000_000) break
    }
  } finally { await reader.cancel().catch(() => undefined) }
  plainNote = 'plain fetch: the expected part was not in the page'
  return { status: r.status, text: '' }
}

const plainCap = async (ticker: string, until: number) => {
  const g = await between(`https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/`, 'data-field="marketCap"', '</fin-streamer>', until)
  if (g?.status === 404) return { text: null, value: null, final: true as const }
  const text = g?.text ? (/>\s*([^<\s]+)/.exec(g.text)?.[1] ?? null) : null
  return text && parseCap(text) ? { text, value: parseCap(text), final: false as const } : null
}

const plainHistory = async (it: Item, until: number): Promise<Read | null> => {
  const t0 = Date.now()
  const p1 = Math.floor(Date.parse(it.from) / 1000), p2 = Math.floor(Date.parse(it.to) / 1000) + 86_400
  const g = await between(`https://finance.yahoo.com/quote/${encodeURIComponent(it.ticker)}/history/?period1=${p1}&period2=${p2}&frequency=1d`, '<table', '</table>', until)
  if (g?.status === 404) return { ok: false, rows: {}, timings: { plainMs: Date.now() - t0 }, log: ['plain fetch: HTTP 404'], error: 'Yahoo does not know this ticker (delisted, renamed or not listed there).' }
  if (!g?.text) return null
  const rows: Record<string, number> = {}
  for (const tr of g.text.match(/<tr[\s\S]*?<\/tr>/g) ?? []) {
    const c = (tr.match(/<td[\s\S]*?<\/td>/g) ?? []).map((td) => td.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim())
    if (c.length < 6) continue // dividend and split lines are shorter
    const t = Date.parse(`${c[0]} UTC`), close = Number(c[4].replace(/,/g, ''))
    if (Number.isFinite(t) && close > 0) rows[new Date(t).toISOString().slice(0, 10)] = close
  }
  const n = Object.keys(rows).length
  return { ok: n > 0, rows, timings: { plainMs: Date.now() - t0 }, log: ['plain fetch', `table rows read: ${n}`], title: 'plain', ...(n ? {} : { error: 'Yahoo showed no prices for this ticker and these dates (delisted, renamed or not listed there).' }) }
}

/** "3.12T", "812.4B", "45.6M" or "1,234,567" as a number of dollars. */
export function parseCap(text: string | null): number | null {
  const m = /^\$?\s*([\d,]*\.?\d+)\s*([TBMK])?$/i.exec((text || '').trim())
  if (!m) return null
  const n = Number(m[1].replace(/,/g, '')) * ({ T: 1e12, B: 1e9, M: 1e6, K: 1e3 } as Record<string, number>)[(m[2] || '').toUpperCase()] || Number(m[1].replace(/,/g, ''))
  return n > 0 ? Math.round(n) : null
}

/** Today's market cap from the company's Yahoo quote page ("Market Cap (intraday)"), one tab. `light` skips scripts (faster); the caller retries with scripts if it finds nothing. */
async function readQuote(gb: GetBrowser, ticker: string, until: number, light = false) {
  const page = await (await gb()).newPage()
  try {
    await lean(page, light)
    await page.goto(`https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/`, { waitUntil: 'domcontentloaded', timeout: Math.max(5000, Math.min(25_000, until - Date.now())) })
    if (!light) await accept(page)
    const text = await page.evaluate(() => {
      const li = Array.from(document.querySelectorAll('li, tr')).find((e) => /^Market Cap/i.test((e.textContent || '').trim()))
      return li ? (li.textContent || '').replace(/^Market Cap\s*(\(intraday\))?/i, '').trim().slice(0, 30) : null
    })
    return { text, value: parseCap(text) }
  } finally { await page.close().catch(() => undefined) }
}

interface Read { needsScripts?: boolean; ok: boolean; rows: Record<string, number>; blocked?: string; error?: string; timings: Record<string, number>; log: string[]; title?: string }

/** One company on one tab. `until` is the moment after which no more waiting is done. */
async function readHistory(gb: GetBrowser, it: Item, until: number, light = true): Promise<Read> {
  const tm: Record<string, number> = {}, log: string[] = []
  const t0 = Date.now()
  const page = await (await gb()).newPage()
  try {
    await lean(page, light)
    tm.tabMs = Date.now() - t0
    const p1 = Math.floor(Date.parse(it.from) / 1000), p2 = Math.floor(Date.parse(it.to) / 1000) + 86_400
    const tg = Date.now()
    const resp = await page.goto(`https://finance.yahoo.com/quote/${encodeURIComponent(it.ticker)}/history/?period1=${p1}&period2=${p2}&frequency=1d`, { waitUntil: 'domcontentloaded', timeout: Math.max(5000, Math.min(25_000, until - Date.now())) })
    tm.pageMs = Date.now() - tg
    log.push(`history page: HTTP ${resp?.status()}`)
    await accept(page, log)
    const tt = Date.now()
    const title = await page.title()
    const bodyText = (await page.evaluate(() => document.body?.innerText || '')).slice(0, 600)
    const head = `${title} ${bodyText.slice(0, 200)}`
    if (BLOCKED.test(head)) return { ok: false, rows: {}, blocked: head.slice(0, 120), timings: tm, log, title }
    await page.waitForSelector('table tbody tr', { timeout: Math.max(3000, Math.min(15_000, until - Date.now())) }).catch(() => undefined)
    const cells: string[][] = await page.$$eval('table tbody tr', (trs) => trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim())))
    tm.tableMs = Date.now() - tt
    const rows: Record<string, number> = {}
    for (const c of cells) {
      if (c.length < 6) continue // dividend and split lines are shorter
      const t = Date.parse(`${c[0]} UTC`), close = Number(c[4].replace(/,/g, ''))
      if (Number.isFinite(t) && close > 0) rows[new Date(t).toISOString().slice(0, 10)] = close
    }
    log.push(`table rows read: ${Object.keys(rows).length}`)
    return { ok: Object.keys(rows).length > 0, rows, timings: tm, log, title, needsScripts: !Object.keys(rows).length && (/consent|guce/.test(page.url()) || !title || /accept all|cookie/i.test(bodyText)), ...(Object.keys(rows).length ? {} : { error: 'Yahoo showed no prices for this ticker and these dates (delisted, renamed or not listed there).' }) }
  } catch (e) {
    return { ok: false, rows: {}, error: String(e).slice(0, 160), timings: tm, log }
  } finally {
    await page.close().catch(() => undefined)
  }
}

/** Light mode first; if that finds no table (for example a cookie dialog that needs scripts), once more with the full page. */
async function read(gb: GetBrowser, it: Item, until: number): Promise<Read> {
  const plain = await plainHistory(it, until)
  if (plain) return plain
  const a = await readHistory(gb, it, until, true).catch((e: unknown): Read => ({ ok: false, rows: {}, error: `${plainNote}; browser: ${String(e).slice(0, 100)}`, timings: {}, log: [plainNote] }))
  if (a.ok || a.blocked || !a.needsScripts || until - Date.now() < 12_000) return a // a delisted company shows an empty table: reading it again with the full page would not help
  const b = await readHistory(gb, it, until, false)
  b.timings = { ...b.timings, lightTryMs: Object.values(a.timings).reduce((x, y) => x + y, 0), fullPageRetry: 1 }
  return b.ok || b.blocked ? b : a
}

/** Today's market cap: plain page first, then the browser without scripts, then the browser with them. */
async function quote(gb: GetBrowser, ticker: string, until: number) {
  const p = await plainCap(ticker, until).catch(() => null)
  if (p) return p.final ? null : p
  let q = await readQuote(gb, ticker, until, true).catch(() => null)
  if (!q?.value && Date.now() < until - 12_000) q = await readQuote(gb, ticker, until, false).catch(() => null)
  return q
}

const closeSoon = (b: Browser | null) => (b ? Promise.race([b.close().catch(() => undefined), new Promise((r) => setTimeout(r, 1500))]) : undefined)

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (!requireAccess(req, res)) return
  const t0 = Date.now()
  const until = t0 + DEADLINE_MS
  let browser: Browser | null = null
  let launching: Promise<Browser> | null = null
  const gb: GetBrowser = () => (launching ??= launch().then((b) => (browser = b)))
  try {
    if (req.method === 'POST' && Array.isArray((req.body as { caps?: unknown } | undefined)?.caps)) {
      // today's market cap for many tickers: one browser, a few tabs side by side
      const body = req.body as { caps: string[]; tabs?: number }
      const tickers = [...new Set(body.caps.map((x) => String(x || '').toUpperCase()).filter((x) => /^[A-Z0-9.-]{1,10}$/.test(x)))].slice(0, 40)
      if (!tickers.length) return res.status(400).json({ error: 'bad_request', message: 'Send {caps:[ticker,…]}.' })
      const tabs = Math.max(1, Math.min(10, Math.floor(body.tabs ?? 6)))
      const out: { ticker: string; value: number | null; ms: number }[] = []
      let next = 0
      const worker = async (n: number) => {
        await new Promise((r) => setTimeout(r, n * 300))
        while (next < tickers.length && Date.now() < until - 8000) {
          const tk = tickers[next++], ts = Date.now()
          const q = await quote(gb, tk, until)
          out.push({ ticker: tk, value: q?.value ?? null, ms: Date.now() - ts })
        }
      }
      await Promise.all(Array.from({ length: tabs }, (_, n) => worker(n)))
      const done = new Set(out.map((o) => o.ticker))
      return res.status(200).json({ results: out, remaining: tickers.filter((x) => !done.has(x)), asOf: new Date().toISOString(), ms: Date.now() - t0 })
    }
    if (req.method === 'POST') {
      const body = (req.body ?? {}) as { items?: Item[]; tabs?: number }
      const items = (body.items ?? []).map((i) => ({ ticker: String(i.ticker || '').toUpperCase(), from: String(i.from), to: String(i.to) })).filter(valid).slice(0, 40)
      if (!items.length) return res.status(400).json({ error: 'bad_request', message: 'Send {items:[{ticker, from, to}]}.' })
      const tabs = Math.max(1, Math.min(10, Math.floor(body.tabs ?? 6)))
      const launchMs = 0
      const out: { ticker: string; to: string; ok: boolean; days: number; ms: number; error?: string }[] = []
      let next = 0, blocked = ''
      const worker = async (n: number) => {
        await new Promise((r) => setTimeout(r, n * 400)) // the tabs do not all start in the same instant
        while (!blocked && next < items.length && Date.now() < until - 8000) {
          const it = items[next++]
          const ts = Date.now()
          const r = await read(gb, it, until)
          if (r.blocked) blocked = r.blocked
          if (r.ok) await storePrices(it.ticker, r.rows)
          out.push({ ticker: it.ticker, to: it.to, ok: r.ok, days: Object.keys(r.rows).length, ms: Date.now() - ts, ...(r.blocked ? { error: 'blocked' } : r.error ? { error: r.error } : {}) })
        }
      }
      await Promise.all(Array.from({ length: tabs }, (_, n) => worker(n)))
      const done = new Set(out.map((o) => o.ticker + o.to))
      return res.status(200).json({
        tabs, requested: items.length, finished: out.length, read: out.filter((o) => o.ok).length, results: out,
        remaining: items.filter((i) => !done.has(i.ticker + i.to)), blocked: blocked || undefined,
        timings: { launchMs, totalMs: Date.now() - t0, perCompanyMs: out.length ? Math.round((Date.now() - t0 - launchMs) / out.length) : null },
      })
    }
    const ticker = one(req.query.ticker).toUpperCase()
    const to = one(req.query.to) || new Date().toISOString().slice(0, 10)
    const from = one(req.query.from) || new Date(Date.parse(to) - 14 * 86_400_000).toISOString().slice(0, 10)
    if (!valid({ ticker, from, to })) return res.status(400).json({ error: 'bad_request', message: 'Give ?ticker=AAPL&from=YYYY-MM-DD&to=YYYY-MM-DD.' })
    const launchMs = 0
    if (one(req.query.caponly)) {
      const q = await quote(gb, ticker, until)
      return res.status(200).json({ ok: !!q?.value, ticker, currentMarketCap: q?.value ?? null, shown: q?.text ?? null, asOf: new Date().toISOString(), ms: Date.now() - t0, ...(q?.value ? {} : { note: 'Yahoo’s quote page showed no market cap for this ticker.' }) })
    }
    const r = await read(gb, { ticker, from, to }, until)
    let marketCap: string | null = null
    const tm = { launchMs, ...r.timings } as Record<string, number>
    if (r.ok && one(req.query.quote) && Date.now() < until - 6000) {
      marketCap = (await quote(gb, ticker, until))?.text ?? null
    }
    const ts = Date.now()
    let stored = 0
    if (r.ok) stored = (await storePrices(ticker, r.rows)).length
    tm.storeMs = Date.now() - ts
    return res.status(200).json({ ok: r.ok, blocked: !!r.blocked || undefined, title: r.title, closes: r.rows, stored, currentMarketCap: marketCap, log: r.log, ms: Date.now() - t0, timings: tm, ...(r.error ? { empty: !r.blocked, note: r.error } : {}) })
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e).slice(0, 200), ms: Date.now() - t0 })
  } finally {
    await closeSoon(browser)
  }
}
