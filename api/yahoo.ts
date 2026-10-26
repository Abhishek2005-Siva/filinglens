import chromium from '@sparticuz/chromium'
import puppeteer, { type Browser } from 'puppeteer-core'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAccess } from './_auth.js'
import { storePrices } from './prices.js'
import { one } from './_sec.js'

// EXPERIMENT: opens Yahoo Finance's public web pages in a headless browser on the server, accepts the cookie dialog if it appears, reads the
// daily history table (and the current market cap on the quote page) and stores the closes. One visit per call, nothing hidden: the browser says what it is,
// and a sign-in, a CAPTCHA or an error page is reported as such, not worked around.
//   GET ?ticker=AAPL&from=2025-02-01&to=2025-02-14[&quote=1]
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (!requireAccess(req, res)) return
  const ticker = one(req.query.ticker).toUpperCase()
  const to = one(req.query.to) || new Date().toISOString().slice(0, 10)
  const from = one(req.query.from) || new Date(Date.parse(to) - 14 * 86_400_000).toISOString().slice(0, 10)
  if (!/^[A-Z0-9.-]{1,10}$/.test(ticker) || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return res.status(400).json({ error: 'bad_request', message: 'Give ?ticker=AAPL&from=YYYY-MM-DD&to=YYYY-MM-DD.' })
  const log: string[] = []
  let browser: Browser | null = null
  const t0 = Date.now()
  const tm: Record<string, number> = {}
  try {
    browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: 'shell', defaultViewport: { width: 1280, height: 900 } })
    tm.launchMs = Date.now() - t0
    log.push(`browser started (${tm.launchMs} ms)`)
    const page = await browser.newPage()
    const consent = async () => {
      // the cookie dialog (it appears in some countries): press "Accept all" like a person would
      const url = page.url()
      if (/consent|guce/.test(url) || (await page.$('button[name="agree"]'))) {
        const btn = (await page.$('button[name="agree"]')) || (await page.$('button.accept-all'))
        if (btn) { await btn.click(); await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => undefined); log.push('cookie dialog: pressed Accept all') } else log.push('cookie page seen but no Accept button found')
      }
    }
    const p1 = Math.floor(Date.parse(from) / 1000), p2 = Math.floor(Date.parse(to) / 1000) + 86_400
    const tg = Date.now()
    const resp = await page.goto(`https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/history/?period1=${p1}&period2=${p2}&frequency=1d`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    tm.pageMs = Date.now() - tg
    log.push(`history page: HTTP ${resp?.status()} · ${page.url().slice(0, 90)}`)
    await consent()
    const title = await page.title()
    const body = (await page.evaluate(() => document.body?.innerText || '')).slice(0, 300)
    if (/too many requests|unusual traffic|captcha|access denied|robot/i.test(`${title} ${body}`)) return res.status(200).json({ ok: false, blocked: true, title, log, note: body.slice(0, 160) })
    const tt = Date.now()
    await page.waitForSelector('table tbody tr', { timeout: 20000 }).catch(async () => {
      // one more try: a slow page, not a different method
      log.push('table did not appear in time; loading the page once more')
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => undefined)
      await page.waitForSelector('table tbody tr', { timeout: 20000 }).catch(() => undefined)
    })
    tm.tableMs = Date.now() - tt
    const cells: string[][] = await page.$$eval('table tbody tr', (trs) => trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim())))
    const rows: Record<string, number> = {}
    for (const c of cells) {
      if (c.length < 6) continue // dividend and split lines are shorter
      const t = Date.parse(`${c[0]} UTC`)
      const close = Number(c[4].replace(/,/g, ''))
      if (Number.isFinite(t) && close > 0) rows[new Date(t).toISOString().slice(0, 10)] = close
    }
    log.push(`table rows read: ${Object.keys(rows).length}`)
    let marketCap: string | null = null
    if (one(req.query.quote)) {
      await page.goto(`https://finance.yahoo.com/quote/${encodeURIComponent(ticker)}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await consent()
      marketCap = await page.evaluate(() => {
        const li = Array.from(document.querySelectorAll('li, tr')).find((e) => /^Market Cap/i.test((e.textContent || '').trim()))
        return li ? (li.textContent || '').replace(/^Market Cap\s*(\(intraday\))?/i, '').trim().slice(0, 30) : null
      })
      log.push(`quote page market cap (current): ${marketCap}`)
    }
    let stored = 0
    const ts = Date.now()
    if (Object.keys(rows).length) stored = (await storePrices(ticker, rows)).length
    tm.storeMs = Date.now() - ts
    return res.status(200).json({ ok: Object.keys(rows).length > 0, title, closes: rows, stored, currentMarketCap: marketCap, log, ms: Date.now() - t0, timings: tm, ...(Object.keys(rows).length ? {} : { empty: true, note: 'Yahoo showed no prices for this ticker and these dates (delisted, renamed or not listed there).' }) })
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e).slice(0, 300), log, ms: Date.now() - t0 })
  } finally {
    await browser?.close().catch(() => undefined)
  }
}
