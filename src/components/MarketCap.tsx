import { useCallback, useEffect, useState } from 'react'

interface Price { price?: number; priceDate?: string; daysOld?: number; trades?: number; accession?: string; marketCap: number | null; error?: string; source?: string }
interface Cap {
  ticker: string
  shares: { value: number; classes: number; asOf: string; filed: string; form: string; accession: string } | null
  sec: Price
  market: Price
  differencePct: number | null
}

const money = (v: number) => (v >= 1e12 ? `$${(v / 1e12).toFixed(2)} trillion` : v >= 1e9 ? `$${(v / 1e9).toFixed(2)} billion` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)} million` : `$${v.toLocaleString()}`)
const num = (v: number) => v.toLocaleString('en-US')

/** Market value of the company on the filing date, worked out two ways so they can be compared. */
export default function MarketCap({ cik, date }: { cik: string; date: string }) {
  const [d, setD] = useState<Cap | null>(null)
  const [err, setErr] = useState('')
  const [tick, setTick] = useState(0)
  const [note, setNote] = useState('')
  useEffect(() => {
    let gone = false
    setD(null); setErr('')
    fetch(`/api/marketcap?cik=${cik}&date=${date}`)
      .then(async (r) => { const b = await r.json(); if (!r.ok) throw new Error(b.message ?? 'failed'); if (!gone) setD(b) })
      .catch((e) => { if (!gone) setErr(e instanceof Error ? e.message : 'Could not load.') })
    return () => { gone = true }
  }, [cik, date, tick])
  const upload = useCallback(async (file: File | undefined) => {
    if (!file || !d?.ticker) return
    setNote('Reading the file…')
    const r = await fetch('/api/prices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticker: d.ticker, csv: await file.text() }) })
    const b = await r.json().catch(() => ({}))
    setNote(r.ok ? `Saved ${b.added} days for ${b.ticker} (${b.first} to ${b.last}).` : b.message ?? 'Could not save that file.')
    if (r.ok) setTick((n) => n + 1)
  }, [d?.ticker])
  return (
    <section className="card mcap" aria-label="Market value">
      <h3>Market value on the filing date{d?.ticker ? ` (${d.ticker})` : ''}</h3>
      {err && <p className="muted small">Not available: {err}</p>}
      {!d && !err && <p className="muted small">Working it out from SEC filings and a price feed…</p>}
      {d && (
        <>
          <p className="muted small">
            Shares: {d.shares ? `${num(d.shares.value)} on the cover of the ${d.shares.form} filed ${d.shares.filed}${d.shares.classes > 1 ? ` (${d.shares.classes} share classes added up)` : ''}` : 'not found in SEC data'}
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
                  <td><b>Closing price</b><div className="muted small">{d.market.source ?? 'price feed'}</div></td>
                  <td>{d.market.price != null ? `$${d.market.price}` : '—'}</td>
                  <td>{d.market.priceDate ?? <span className="muted small">{d.market.error}</span>}</td>
                  <td>{d.market.marketCap ? <b>{money(d.market.marketCap)}</b> : '—'}</td>
                </tr>
              </tbody>
            </table>
          </div>
          {d.market.price == null && d.ticker && (
            <p className="muted small">
              Yahoo does not let the site fetch prices itself. Download the daily history for {d.ticker} from Yahoo Finance (Historical data → Download) and add it here:{' '}
              <input type="file" accept=".csv,text/csv" onChange={(e) => void upload(e.target.files?.[0])} aria-label={`Yahoo price file for ${d.ticker}`} />
            </p>
          )}
          {note && <p className="muted small" role="status">{note}</p>}
          {d.differencePct != null && <p className="muted small">The SEC-only value is {d.differencePct > 0 ? '+' : ''}{d.differencePct}% from the closing-price value. Both use the same share count, so the gap is only the price.</p>}
        </>
      )}
    </section>
  )
}
