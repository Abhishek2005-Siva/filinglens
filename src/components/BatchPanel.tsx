import { useState } from 'react'
import type { SearchParams } from '../api'
import { createBatch, loadMine, remember } from '../batchApi'
import type { Company, FilingRow } from '../types'

interface Props {
  filings: FilingRow[]
  total: number
  params: SearchParams
  company: Company | null
}

const mins = (n: number) => {
  const lo = Math.max(1, Math.round((n * 1.2) / 60))
  const hi = Math.max(lo + 1, Math.round((n * 3) / 60))
  return hi >= 120 ? `${Math.round(lo / 6) / 10}–${Math.round(hi / 6) / 10} hours` : `${lo}–${hi} minutes`
}

/** Starts a background analysis of the search results. The work runs on the model server, not in this browser tab. */
export default function BatchPanel({ filings, total, params, company }: Props) {
  const [scope, setScope] = useState<'page' | 'all'>(total > filings.length ? 'all' : 'page')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const more = total > filings.length
  const count = scope === 'all' ? total : filings.length
  const mine = loadMine().length

  const start = async () => {
    setBusy(true)
    setError('')
    const title = `${params.item ? `Item ${params.item}` : 'All filings'} · ${params.start || 'all dates'} to ${params.end || 'today'}${company ? ` · ${company.name}` : ''}${params.q ? ` · “${params.q}”` : ''}`
    try {
      const { id } = await createBatch(
        scope === 'all'
          ? { title, search: { q: params.q, forms: params.forms, start: params.start, end: params.end, cik: company?.cik ?? params.cik, item: params.item } }
          : { title: `${title} (this page)`, filings },
      )
      remember({ id, title, createdAt: Date.now() })
      window.location.hash = `#/analysis/${id}`
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start the analysis.')
      setBusy(false)
    }
  }

  return (
    <section className="batch card" aria-labelledby="h-batch">
      <div className="batch-head">
        <div>
          <h2 id="h-batch">Analyze all results</h2>
          <p className="muted small">One spreadsheet for all results. It keeps running if you close the page.</p>
        </div>
        <button type="button" className="btn primary" onClick={() => void start()} disabled={busy || !filings.length}>
          {busy ? 'Starting…' : `Analyze ${count.toLocaleString()} filing${count === 1 ? '' : 's'}`}
        </button>
      </div>

      {more && (
        <fieldset className="scope">
          <legend className="sr-only">Which results to analyze</legend>
          <label><input type="radio" name="scope" checked={scope === 'page'} onChange={() => setScope('page')} /> Only the {filings.length} results on this page</label>
          <label><input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} /> Everything this search found ({total.toLocaleString()} results)</label>
        </fieldset>
      )}
      <p className="muted small">About {mins(count)}. Turn the AI on first (top right).{mine ? <> <a href="#/analyses">My analyses ({mine})</a></> : null}</p>
      {error && <p className="explain bad" role="alert">{error}</p>}
    </section>
  )
}
