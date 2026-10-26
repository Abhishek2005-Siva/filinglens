import { useCallback, useEffect, useRef, useState } from 'react'

interface Price { price?: number; priceDate?: string; daysOld?: number; trades?: number; accession?: string; marketCap: number | null; error?: string; source?: string }
interface Cap {
  ticker: string
  shares: { value: number; classes: number; asOf: string; filed: string; form: string; accession: string } | null
  sec: Price
  market: Price
  differencePct: number | null
  manual?: { price: boolean; shares: boolean }
  timings?: { sharesMs: number; secMs: number; priceLookupMs: number; totalMs: number }
}

const money = (v: number) => (v >= 1e12 ? `$${(v / 1e12).toFixed(2)} trillion` : v >= 1e9 ? `$${(v / 1e9).toFixed(2)} billion` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)} million` : `$${v.toLocaleString()}`)
const num = (v: number) => v.toLocaleString('en-US')
const secs = (ms?: number) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`)
const skipKey = (cik: string, date: string) => `mcap-skip:${cik}:${date}`
const wasSkipped = (cik: string, date: string) => { try { return localStorage.getItem(skipKey(cik, date)) === '1' } catch { return false } }

type Stage = 'loading' | 'yahoo' | 'done'

/** Market value of the company on the filing date. If nothing is stored for the price, the site reads Yahoo Finance's public page once;
 *  if that finds nothing the person can type the value in, or leave it empty. */
export default function MarketCap({ cik, date }: { cik: string; date: string }) {
  const [d, setD] = useState<Cap | null>(null)
  const [err, setErr] = useState('')
  const [stage, setStage] = useState<Stage>('loading')
  const [yahooMs, setYahooMs] = useState<number | null>(null)
  const [yahooEmpty, setYahooEmpty] = useState('')
  const [skipped, setSkipped] = useState(() => wasSkipped(cik, date))
  const [price, setPrice] = useState('')
  const [shares, setShares] = useState('')
  const [note, setNote] = useState('')
  const asked = useRef('')

  const load = useCallback(async (): Promise<Cap | null> => {
    const ask = async (extra: string) => {
      const r = await fetch(`/api/marketcap?cik=${cik}&date=${date}${extra}`)
      const text = await r.text()
      let b: (Cap & { message?: string }) | null = null
      try { b = JSON.parse(text) } catch { /* the server answered with an error page, not data (for example a time-out) */ }
      if (!r.ok || !b) throw new Error(b?.message ?? 'the lookup took too long')
      return b
    }
    let b: Cap
    try {
      b = await ask('')
    } catch {
      // the full lookup (which also searches insider trades) failed or timed out: the quick version still gives the Yahoo-based value
      b = await ask('&light=1')
      b.sec = { marketCap: null, error: 'The insider-trade search could not be completed.' }
    }
    setD(b)
    return b
  }, [cik, date])

  useEffect(() => {
    let gone = false
    setD(null); setErr(''); setStage('loading'); setYahooMs(null); setYahooEmpty(''); setSkipped(wasSkipped(cik, date)); asked.current = ''
    ;(async () => {
      try {
        const first = await load()
        if (gone || !first) return
        // no price stored for this company: read Yahoo's public history page once (about 15–30 seconds)
        if (!first.market.price && first.ticker && !first.manual?.price && asked.current !== first.ticker) {
          asked.current = first.ticker
          setStage('yahoo')
          const from = new Date(Date.parse(date) - 10 * 86_400_000).toISOString().slice(0, 10)
          const t0 = performance.now()
          const y = await fetch(`/api/yahoo?ticker=${encodeURIComponent(first.ticker)}&from=${from}&to=${date}`).then((r) => r.json()).catch(() => ({}))
          if (gone) return
          setYahooMs(Math.round(performance.now() - t0))
          if (y.ok) await load()
          else setYahooEmpty(y.blocked ? 'Yahoo would not show the page.' : y.note ?? y.error ?? 'Yahoo returned nothing.')
        }
      } catch (e) {
        if (!gone) setErr(e instanceof Error ? e.message : 'Could not load.')
      } finally {
        if (!gone) setStage('done')
      }
    })()
    return () => { gone = true }
  }, [cik, date, load])

  const save = async () => {
    const body: Record<string, unknown> = { cik, date }
    if (price.trim()) body.price = Number(price.replace(/,/g, ''))
    if (shares.trim()) body.shares = Number(shares.replace(/,/g, ''))
    if (!('price' in body) && !('shares' in body)) { setNote('Type a value first.'); return }
    const r = await fetch('/api/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const b = await r.json().catch(() => ({}))
    if (!r.ok) { setNote(b.message ?? 'Could not save.'); return }
    setNote('Saved.'); setPrice(''); setShares(''); setSkipped(false)
    try { localStorage.removeItem(skipKey(cik, date)) } catch { /* storage unavailable */ }
    await load()
  }
  const keepEmpty = () => {
    try { localStorage.setItem(skipKey(cik, date), '1') } catch { /* storage unavailable */ }
    setSkipped(true)
  }
  const clearManual = async () => {
    await fetch('/api/manual', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cik, date, price: null, shares: null }) })
    await load()
  }

  const missingPrice = !!d && d.market.price == null
  const missingShares = !!d && !d.shares
  const needsHelp = stage === 'done' && (missingPrice || missingShares)

  return (
    <section className="card mcap" aria-label="Market value">
      <h3>Market value on the filing date{d?.ticker ? ` (${d.ticker})` : ''}</h3>
      {err && <p className="muted small">Not available: {err}</p>}
      {!d && !err && <p className="muted small">Looking up SEC filings…</p>}
      {stage === 'yahoo' && <p className="muted small" role="status">No stored price for {d?.ticker}. Reading Yahoo Finance’s public page, usually 15–30 seconds…</p>}
      {d && (
        <>
          <p className="muted small">
            Shares: {d.shares ? `${num(d.shares.value)} ${d.shares.form === 'entered by hand' ? '(entered by hand)' : `on the cover of the ${d.shares.form} filed ${d.shares.filed}${d.shares.classes > 1 ? ` (${d.shares.classes} share classes added up)` : ''}`}` : 'not found in SEC data'}
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th scope="col">Method</th><th scope="col">Price</th><th scope="col">Price date</th><th scope="col">Market value</th></tr></thead>
              <tbody>
                <tr>
                  <td><b>SEC only</b><div className="muted small">latest insider trade (Form 4)</div></td>
                  <td>{d.sec.price != null ? `$${d.sec.price}` : '—'}</td>
                  <td>{d.sec.priceDate ? `${d.sec.priceDate} (${d.sec.daysOld} days before)` : <span className="muted small">{d.sec.error}</span>}</td>
                  <td>{d.sec.marketCap ? <b>{money(d.sec.marketCap)}</b> : '—'}</td>
                </tr>
                <tr>
                  <td><b>Closing price</b><div className="muted small">{d.market.source ?? 'Yahoo Finance'}</div></td>
                  <td>{d.market.price != null ? `$${d.market.price}` : '—'}</td>
                  <td>{d.market.priceDate ?? <span className="muted small">{skipped ? 'left empty' : d.market.error}</span>}</td>
                  <td>{d.market.marketCap ? <b>{money(d.market.marketCap)}</b> : '—'}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {d.differencePct != null && <p className="muted small">The SEC-only value is {d.differencePct > 0 ? '+' : ''}{d.differencePct}% from the closing-price value. Both use the same share count, so the gap is only the price.</p>}
          {d.market.source === 'Yahoo Finance' && <p className="muted small">Yahoo’s closing prices are adjusted for later stock splits, so for a company that split afterwards this price is not the one paid on that day. Stored prices are used for 7 days (6 hours for the last 3 days), then read again.</p>}
          {needsHelp && !skipped && (
            <div className="mcap-manual" role="group" aria-label="Add the missing value">
              <p className="small"><b>Nothing found{missingPrice && yahooEmpty ? `: ${yahooEmpty}` : ''}.</b> You can type in the missing value, or leave it empty.</p>
              <div className="mcap-fields">
                {missingPrice && <label>Closing price on {date} ($)<input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="e.g. 227.65" /></label>}
                {missingShares && <label>Shares outstanding<input inputMode="numeric" value={shares} onChange={(e) => setShares(e.target.value)} placeholder="e.g. 15,000,000" /></label>}
              </div>
              <div className="mcap-actions">
                <button type="button" className="btn primary small" onClick={() => void save()}>Save value</button>
                <button type="button" className="btn small" onClick={keepEmpty}>Leave empty</button>
              </div>
            </div>
          )}
          {needsHelp && skipped && <p className="muted small">Left empty. <button type="button" className="linklike" onClick={() => setSkipped(false)}>Add a value</button></p>}
          {(d.manual?.price || d.manual?.shares) && <p className="muted small">A value was entered by hand. <button type="button" className="linklike" onClick={() => void clearManual()}>Remove it</button></p>}
          {note && <p className="muted small" role="status">{note}</p>}
          {d.timings && (
            <p className="muted small mcap-time">
              Took: SEC data {secs(Math.max(d.timings.sharesMs, d.timings.secMs))} · price lookup {secs(d.timings.priceLookupMs)}{yahooMs != null ? ` · Yahoo page ${secs(yahooMs)}` : ''}
            </p>
          )}
        </>
      )}
    </section>
  )
}
