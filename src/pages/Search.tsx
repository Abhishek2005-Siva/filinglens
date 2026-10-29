import { useCallback, useEffect, useState } from 'react'
import { searchFilings, type SearchParams } from '../api'
import BatchPanel from '../components/BatchPanel'
import CompanyPicker from '../components/CompanyPicker'
import { memory } from '../searchState'
import type { Company, FilingRow, SearchResponse } from '../types'
import { fmtDate, num } from '../utils'

const FORMS = [
  ['8-K', '8-K (current reports, not amendments)'],
  ['8-K/A', '8-K/A (amendments)'],
  ['8-K,8-K/A', '8-K and 8-K/A'],
  ['10-K', '10-K (annual reports)'],
  ['10-Q', '10-Q (quarterly reports)'],
]

const iso = (d: Date) => d.toISOString().slice(0, 10)
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86400000))

const PRESETS: [string, string, () => [string, string]][] = [
  ['30d', 'Last 30 days', () => [daysAgo(30), iso(new Date())]],
  ['90d', 'Last 90 days', () => [daysAgo(90), iso(new Date())]],
  ['365d', 'Last 12 months', () => [daysAgo(365), iso(new Date())]],
  ['mar25', 'March 2025 (test month)', () => ['2025-03-01', '2025-03-31']],
]

const EVENT_TYPES: [string, string][] = [
  ['', 'Any filing'],
  ['5.02', 'Leadership changes (CEO, CFO, directors)'],
  ['1.01', 'Material agreement entered'],
  ['1.02', 'Material agreement ended'],
  ['1.03', 'Bankruptcy or receivership'],
  ['2.01', 'Acquisition or sale of assets completed'],
  ['2.02', 'Earnings results and guidance'],
  ['2.05', 'Restructuring or exit costs'],
  ['2.06', 'Material impairment'],
  ['3.01', 'Delisting or listing notice'],
  ['3.02', 'Unregistered equity sales'],
  ['4.01', 'Change of auditor'],
  ['5.07', 'Shareholder vote results'],
]

const PAGE = 100

export default function Search() {
  const saved = memory.search
  const [preset, setPreset] = useState('30d')
  const [params, setParams] = useState<SearchParams>(
    saved?.params ?? { q: '', forms: '8-K', start: daysAgo(30), end: iso(new Date()), cik: '', item: '', from: 0 },
  )
  const [company, setCompany] = useState<Company | null>(saved?.company ?? null)
  const [resp, setResp] = useState<SearchResponse | null>(saved?.response ?? null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [searchId, setSearchId] = useState(0)

  const run = useCallback(async (p: SearchParams, c: Company | null) => {
    setLoading(true)
    setErr('')
    try {
      const r = await searchFilings({ ...p, cik: c?.cik ?? '' })
      setResp(r)
      memory.search = { params: p, company: c, response: r }
      memory.batch = null
      setSearchId((n) => n + 1)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Search failed')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!saved) void run(params, company)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    void run({ ...params, from: 0 }, company)
  }

  const page = (from: number) => {
    const p = { ...params, from }
    setParams(p)
    void run(p, company)
    window.scrollTo({ top: 0 })
  }

  const open = (f: FilingRow) => {
    memory.selected = f
    window.location.hash = `#/filing/${f.cik}/${f.accession}`
  }

  const pickPreset = (id: string) => {
    setPreset(id)
    const fn = PRESETS.find((p) => p[0] === id)?.[2]
    if (fn) {
      const [start, end] = fn()
      setParams((p) => ({ ...p, start, end }))
    }
  }

  const total = resp?.total ?? 0
  const from = resp?.from ?? 0
  const isCompanyBrowse = !!company && !params.q.trim()

  return (
    <>
      <section className="hero compact">
        <h1>Search SEC filings</h1>
        <p className="lead">Pick a filing to analyze it, or analyze every result at once.</p>
      </section>

      <form className="card sform" onSubmit={submit}>
        <div className="sform-grid">
          <label className="field wide">
            <span>Keywords or phrase</span>
            <input type="search" placeholder={'e.g. "going concern", "Chief Financial Officer" or a company name'} value={params.q} onChange={(e) => setParams({ ...params, q: e.target.value })} />
          </label>
          <div className="field">
            <span>Company</span>
            <CompanyPicker value={company} onChange={setCompany} />
          </div>
          <label className="field">
            <span>Form type</span>
            <select value={params.forms} onChange={(e) => setParams({ ...params, forms: e.target.value })}>
              {FORMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Date range</span>
            <select value={preset} onChange={(e) => pickPreset(e.target.value)}>
              {PRESETS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              <option value="custom">Custom…</option>
            </select>
          </label>
          <label className="field">
            <span>From</span>
            <input type="date" value={params.start} onChange={(e) => { setPreset('custom'); setParams({ ...params, start: e.target.value }) }} />
          </label>
          <label className="field">
            <span>To</span>
            <input type="date" value={params.end} onChange={(e) => { setPreset('custom'); setParams({ ...params, end: e.target.value }) }} />
          </label>
        </div>
        <div className="sform-foot">
          <label className="field inline">
            <span>Type of event</span>
            <select value={params.item} onChange={(e) => setParams({ ...params, item: e.target.value })}>
              {EVENT_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <button type="submit" className="btn primary" disabled={loading}>{loading ? 'Searching…' : 'Search'}</button>
        </div>
      </form>

      {err && <p className="explain bad" role="alert">{err}</p>}

      {resp && resp.filings.length > 0 && (
        <BatchPanel key={searchId} filings={resp.filings} total={resp.total} params={memory.search?.params ?? params} company={memory.search?.company ?? company} />
      )}

      {resp && (
        <section aria-live="polite">
          <p className="results-count">
            <b>{num(total)}</b> {total === 1 ? 'filing' : 'filings'} found
            {isCompanyBrowse && resp.company ? ` for ${resp.company.name}` : ''}
            {!isCompanyBrowse && total > resp.filings.length + from ? ` · showing ${from + 1}–${from + resp.pageSize}` : ''}
          </p>
          <div className="card table-card">
            <div className="table-wrap" tabIndex={0} role="region" aria-label="Search results">
              <table className="data results">
                <thead>
                  <tr><th scope="col">Filed</th><th scope="col">Form &amp; description</th><th scope="col">Company</th><th scope="col">Items</th><th scope="col">Located</th><th scope="col"><span className="sr-only">Action</span></th></tr>
                </thead>
                <tbody>
                  {resp.filings.length === 0 && <tr><td colSpan={6} className="empty">No filings match. Try a wider date range or fewer filters.</td></tr>}
                  {resp.filings.map((f) => (
                    <tr key={f.accession} className="clickable" onClick={() => open(f)}>
                      <td className="nowrap">{fmtDate(f.date)}</td>
                      <td>
                        <button type="button" className="linklike" onClick={(e) => { e.stopPropagation(); open(f) }}>{f.form}</button>
                        <small className="block muted">{f.description}</small>
                      </td>
                      <td><b>{f.company}</b><small className="block muted">{f.ticker ? `${f.ticker} · ` : ''}CIK {f.cik}</small></td>
                      <td>{f.items.map((i) => <span key={i} className={`item-tag ${i === '5.02' ? 'hot' : ''}`}>{i}</span>)}</td>
                      <td className="muted">{f.location}</td>
                      <td className="nowrap"><span className="btn small">Analyze →</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {!isCompanyBrowse && total > PAGE && (
            <div className="pager">
              <button type="button" className="btn" disabled={from === 0 || loading} onClick={() => page(Math.max(0, from - PAGE))}>← Previous</button>
              <span className="muted">Page {Math.floor(from / PAGE) + 1} of {Math.ceil(Math.min(total, 10000) / PAGE)}</span>
              <button type="button" className="btn" disabled={from + PAGE >= Math.min(total, 10000) || loading} onClick={() => page(from + PAGE)}>Next →</button>
            </div>
          )}
        </section>
      )}
    </>
  )
}
