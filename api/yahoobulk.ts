import chromium from '@sparticuz/chromium'
import puppeteer, { type Browser } from 'puppeteer-core'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAccess } from './_auth.js'
import { storePrices } from './prices.js'

// Several companies in one call: one browser, a few tabs working through the list side by side. Each tab opens one company's public Yahoo Finance
// history page (pictures, fonts and video are not downloaded), reads the table and stores the closes.
//   POST {items:[{ticker:'AAPL', from:'2025-02-01', to:'2025-02-12'}, …], tabs?: 1–5}
// It stops starting new companies after about 45 seconds (the function limit is 60) and returns the ones it did not reach in `remaining`, so the caller
// can send them again. If Yahoo shows an error or a challenge page it stops at once and says so; it does not try to get around it.
interface Item { ticker: string; from: string; to: string }
const ok = (i: Item) => /^[A-Z0-9.-]{1,10}$/.test(i.ticker) && /^\d{4}-\d{2}-\d{2}$/.test(i.from) && /^\d{4}-\d{2}-\d{2}$/.test(i.to)

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (!requireAccess(req, res)) return
  if (req.method !== 'POST') return res.status(405).json({ error: 'method', message: 'Use POST.' })
  const body = (req.body ?? {}) as { items?: Item[]; tabs?: number }
  const items = (body.items ?? []).map((i) => ({ ticker: String(i.ticker || '').toUpperCase(), from: String(i.from), to: String(i.to) })).filter(ok).slice(0, 40)
  if (!items.length) return res.status(400).json({ error: 'bad_request', message: 'Send {items:[{ticker, from, to}]}.' })
  const tabs = Math.max(1, Math.min(5, Math.floor(body.tabs ?? 3)))
  const t0 = Date.now()
  const out: { ticker: string; to: string; ok: boolean; days: number; ms: number; error?: string }[] = []
  let next = 0
  let blocked = ''
  let browser: Browser | null = null
  try {
    browser = await puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: 'shell', defaultViewport: { width: 1280, height: 900 } })
    const launchMs = Date.now() - t0
    const worker = async (n: number) => {
      await new Promise((r) => setTimeout(r, n * 500)) // the tabs do not all start in the same instant
      while (!blocked && next < items.length && Date.now() - t0 < 45_000) {
        const it = items[next++]
        const ts = Date.now()
        const page = await browser!.newPage()
        try {
          await page.setRequestInterception(true)
          page.on('request', (r) => { ['image', 'media', 'font'].includes(r.resourceType()) ? void r.abort() : void r.continue() })
          const p1 = Math.floor(Date.parse(it.from) / 1000), p2 = Math.floor(Date.parse(it.to) / 1000) + 86_400
          await page.goto(`https://finance.yahoo.com/quote/${encodeURIComponent(it.ticker)}/history/?period1=${p1}&period2=${p2}&frequency=1d`, { waitUntil: 'domcontentloaded', timeout: 30000 })
          const btn = (await page.$('button[name="agree"]')) || (await page.$('button.accept-all'))
          if (btn) { await btn.click(); await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => undefined) }
          const head = `${await page.title()} ${(await page.evaluate(() => document.body?.innerText || '')).slice(0, 200)}`
          if (/too many requests|unusual traffic|captcha|access denied|robot/i.test(head)) { blocked = head.slice(0, 120); out.push({ ticker: it.ticker, to: it.to, ok: false, days: 0, ms: Date.now() - ts, error: 'blocked' }); break }
          await page.waitForSelector('table tbody tr', { timeout: 20000 }).catch(() => undefined)
          const cells: string[][] = await page.$$eval('table tbody tr', (trs) => trs.map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent || '').trim())))
          const rows: Record<string, number> = {}
          for (const c of cells) {
            if (c.length < 6) continue
            const t = Date.parse(`${c[0]} UTC`), close = Number(c[4].replace(/,/g, ''))
            if (Number.isFinite(t) && close > 0) rows[new Date(t).toISOString().slice(0, 10)] = close
          }
          const days = Object.keys(rows).length
          if (days) await storePrices(it.ticker, rows)
          out.push({ ticker: it.ticker, to: it.to, ok: days > 0, days, ms: Date.now() - ts, ...(days ? {} : { error: 'no prices shown (delisted, renamed or not listed)' }) })
        } catch (e) {
          out.push({ ticker: it.ticker, to: it.to, ok: false, days: 0, ms: Date.now() - ts, error: String(e).slice(0, 100) })
        } finally {
          await page.close().catch(() => undefined)
        }
      }
    }
    await Promise.all(Array.from({ length: tabs }, (_, n) => worker(n)))
    const done = new Set(out.map((o) => o.ticker + o.to))
    return res.status(200).json({
      tabs, requested: items.length, finished: out.length, read: out.filter((o) => o.ok).length, results: out,
      remaining: items.filter((i) => !done.has(i.ticker + i.to)), blocked: blocked || undefined,
      timings: { launchMs, totalMs: Date.now() - t0, perCompanyMs: out.length ? Math.round((Date.now() - t0 - launchMs) / out.length) : null },
    })
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e).slice(0, 200), results: out, ms: Date.now() - t0 })
  } finally {
    await browser?.close().catch(() => undefined)
  }
}
