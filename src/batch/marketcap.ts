import type { Row } from './columns'

export interface Cap {
  cap: number | null
  note: string
}

interface Light {
  ticker?: string
  shares: { value: number; form: string; filed: string } | null
  market: { price?: number; priceDate?: string; source?: string; marketCap: number | null; error?: string }
  error?: string
}

const day = (iso: string, plus: number) => new Date(Date.parse(iso) + plus * 86_400_000).toISOString().slice(0, 10)

async function pool<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>, stop: () => boolean, tick: () => void): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length && !stop()) {
      const i = next++
      out[i] = await fn(items[i])
      tick()
    }
  }))
  return out
}

const light = (cik: string, date: string, ticker = ''): Promise<Light | null> =>
  fetch(`/api/marketcap?cik=${cik}&date=${date}&light=1${ticker ? `&ticker=${encodeURIComponent(ticker)}` : ''}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)

/** Market cap for every filing of an analysis: shares from the SEC, the closing price from the stored Yahoo reads; companies without a stored price are read from
 *  Yahoo Finance in groups first. Companies where nothing is found stay empty (the filing page lets a person type the value in). */
export async function fillMarketCaps(rows: Row[], onProgress: (text: string) => void, stop: () => boolean): Promise<Record<string, Cap>> {
  const keyOf = (r: Row) => `${String(r.CIK).replace(/^0+/, '')}|${String(r.Filed).slice(0, 10)}`
  const keys = [...new Set(rows.filter((r) => r.CIK && r.Filed && !String(r.Status).startsWith('Error')).map(keyOf))]
  // the ticker the filing itself carried is better than today's (a renamed or delisted company has none today)
  const tickerOfKey = new Map<string, string>()
  for (const r of rows) { const t = String(r.Ticker || '').trim(); if (t && !tickerOfKey.has(keyOf(r))) tickerOfKey.set(keyOf(r), t) }
  const res = new Map<string, Light | null>()
  let n = 0
  onProgress(`Looking up share counts… 0 of ${keys.length}`)
  await pool(keys, 6, async (k) => { const [cik, date] = k.split('|'); res.set(k, await light(cik, date, tickerOfKey.get(k))) }, stop, () => onProgress(`Looking up share counts… ${++n} of ${keys.length}`))

  // companies that have a ticker but no stored price: read Yahoo's history page, a group at a time
  const need = keys.filter((k) => { const r = res.get(k); return r && r.ticker && r.shares && r.market.price == null && !r.market.marketCap })
  let read = 0
  for (let i = 0; i < need.length && !stop(); i += 24) {
    let items = need.slice(i, i + 24).map((k) => ({ ticker: res.get(k)!.ticker!, from: day(k.split('|')[1], -10), to: k.split('|')[1], key: k }))
    for (let attempt = 0; attempt < 3 && items.length && !stop(); attempt++) {
      onProgress(`Reading prices from Yahoo Finance… ${read} of ${need.length}`)
      const d = await fetch('/api/yahoo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: items.map(({ ticker, from, to }) => ({ ticker, from, to })), tabs: 4 }) }).then((r) => r.json()).catch(() => null)
      if (!d || !d.results) break
      read += d.finished
      if (d.blocked) { onProgress('Yahoo stopped showing the pages; the rest are left empty.'); i = need.length; break }
      const left = new Set((d.remaining as { ticker: string; to: string }[]).map((x) => x.ticker + x.to))
      items = items.filter((it) => left.has(it.ticker + it.to))
    }
  }
  if (need.length && !stop()) {
    n = 0
    onProgress(`Calculating… 0 of ${need.length}`)
    await pool(need, 6, async (k) => { const [cik, date] = k.split('|'); res.set(k, await light(cik, date, tickerOfKey.get(k))) }, stop, () => onProgress(`Calculating… ${++n} of ${need.length}`))
  }

  const out: Record<string, Cap> = {}
  for (const r of rows) {
    const x = res.get(keyOf(r))
    const acc = String(r.Accession)
    if (!x) { out[acc] = { cap: null, note: 'Could not be looked up' }; continue }
    if (x.market.marketCap && x.shares) out[acc] = { cap: x.market.marketCap, note: `${x.shares.value.toLocaleString('en-US')} shares (${x.shares.form === 'entered by hand' ? 'entered by hand' : `${x.shares.form} filed ${x.shares.filed}`}) × $${x.market.price} (${x.market.source}, ${x.market.priceDate})` }
    else out[acc] = { cap: null, note: !x.shares ? 'No share count in SEC data' : !x.ticker ? 'No ticker for this company' : 'Yahoo showed no price' }
  }
  return out
}

export const fmtCap = (v: number) => (v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${v.toLocaleString('en-US')}`)
export const UNITS: Record<string, number> = { thousand: 1e3, million: 1e6, billion: 1e9, trillion: 1e12 }
