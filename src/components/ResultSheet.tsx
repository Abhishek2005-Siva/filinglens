import { useMemo, useState } from 'react'
import { COLUMNS, type Row } from '../batch/columns'
import { downloadCsv, downloadXlsx } from '../batch/export'

type SortKey = 'Filed' | 'Company' | 'Events found'

const STICKY = new Set(['Company'])
// the columns that hold one kind of event each (CEO / CFO changes, then the other detectors)
const EVENT_COLS: string[] = COLUMNS.slice(8, 21)

/** The on-screen spreadsheet with filter, sort and CSV / Excel download. */
export default function ResultSheet({ rows, fileBase, about }: { rows: Row[]; fileBase: string; about: [string, string][] }) {
  const [filter, setFilter] = useState('')
  const [onlyEvents, setOnlyEvents] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'Events found', dir: -1 })
  const [exporting, setExporting] = useState(false)
  const [message, setMessage] = useState('')
  const [limit, setLimit] = useState(300)
  const [picked, setPicked] = useState<Set<string>>(new Set()) // event types to show; none picked = all filings
  const [match, setMatch] = useState<'any' | 'all'>('any')
  const [check, setCheck] = useState<'all' | 'flagged' | 'clean'>('all')

  const counts = useMemo(() => Object.fromEntries(EVENT_COLS.map((c) => [c, rows.filter((r) => !!r[c]).length])), [rows])
  const togglePick = (c: string) => setPicked((p) => { const n = new Set(p); if (n.has(c)) n.delete(c); else n.add(c); return n })
  const shownCols = picked.size ? COLUMNS.filter((c) => !EVENT_COLS.includes(c) || picked.has(c)) : COLUMNS

  const shown = useMemo(() => {
    const t = filter.trim().toLowerCase()
    const sel = [...picked]
    const out = rows.filter((r) =>
      (!onlyEvents || Number(r['Events found']) > 0) &&
      (!sel.length || (match === 'all' ? sel.every((c) => !!r[c]) : sel.some((c) => !!r[c]))) &&
      (check === 'all' || (check === 'flagged') === !!r['Needs review']) &&
      (!t || Object.values(r).some((v) => String(v).toLowerCase().includes(t))))
    return out.sort((a, b) => {
      const x = a[sort.key], y = b[sort.key]
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
      return c * sort.dir || String(a.Company).localeCompare(String(b.Company))
    })
  }, [rows, filter, onlyEvents, sort, picked, match, check])

  const withEvents = rows.filter((r) => Number(r['Events found']) > 0).length
  const errors = rows.filter((r) => String(r.Status).startsWith('Error')).length

  const exportXlsx = async () => {
    setExporting(true)
    setMessage('')
    try {
      await downloadXlsx(shown, `${fileBase}.xlsx`, about)
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Could not build the Excel file.')
    } finally {
      setExporting(false)
    }
  }

  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: (-s.dir as 1 | -1) } : { key, dir: key === 'Events found' ? -1 : 1 }))
  const open = (r: Row) => (window.location.hash = `#/filing/${r.CIK}/${r.Accession}`)

  return (
    <>
      <div className="sheet-bar">
        <div className="sheet-stats"><b>{rows.length}</b> filings · <b>{withEvents}</b> with events{errors ? <> · <b className="bad-text">{errors}</b> errors</> : null}</div>
        <input type="search" placeholder="Filter the sheet…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter the sheet" />
        <label className="check-line"><input type="checkbox" checked={onlyEvents} onChange={(e) => setOnlyEvents(e.target.checked)} /> <span>Only filings with events</span></label>
        <div className="sheet-actions">
          <button type="button" className="btn small" onClick={() => downloadCsv(shown, `${fileBase}.csv`)}>Download CSV</button>
          <button type="button" className="btn small primary" onClick={() => void exportXlsx()} disabled={exporting}>{exporting ? 'Building…' : 'Download Excel (.xlsx)'}</button>
        </div>
      </div>
      <div className="event-filter" role="group" aria-label="Show only these events">
        <div className="event-filter-head">
          <b>Show only filings with:</b>
          <button type="button" className={`chip ${picked.size === 0 ? 'on' : ''}`} onClick={() => setPicked(new Set())} aria-pressed={picked.size === 0}>All filings</button>
          {picked.size > 1 && (
            <span className="seg" role="group" aria-label="Match any or all of the chosen events">
              <button type="button" className={match === 'any' ? 'on' : ''} onClick={() => setMatch('any')} aria-pressed={match === 'any'}>any of them</button>
              <button type="button" className={match === 'all' ? 'on' : ''} onClick={() => setMatch('all')} aria-pressed={match === 'all'}>all of them</button>
            </span>
          )}
          <label className="check-select">Answer check
            <select value={check} onChange={(e) => setCheck(e.target.value as 'all' | 'flagged' | 'clean')}>
              <option value="all">Show everything</option>
              <option value="flagged">Only answers that need a look</option>
              <option value="clean">Only answers with no flag</option>
            </select>
          </label>
        </div>
        <div className="chips">
          {EVENT_COLS.map((c) => (
            <button type="button" key={c} className={`chip ${picked.has(c) ? 'on' : ''}`} onClick={() => togglePick(c)} aria-pressed={picked.has(c)} disabled={!counts[c] && !picked.has(c)}>
              {c} <small>{counts[c]}</small>
            </button>
          ))}
        </div>
      </div>
      {message && <p className="explain bad" role="alert">{message}</p>}
      <p className="muted small">Showing {shown.length} row{shown.length === 1 ? '' : 's'}. Downloads include exactly the rows shown{picked.size ? ' (all columns)' : ''}. Click a company to open its full analysis; click Filed, Company or Events found to sort.</p>
      <div className="sheet-wrap" tabIndex={0} role="region" aria-label="Analysis spreadsheet">
        <table className="sheet">
          <thead>
            <tr>
              <th className="rownum" aria-hidden="true">#</th>
              {shownCols.map((c) => {
                const sortable = c === 'Filed' || c === 'Company' || c === 'Events found'
                return (
                  <th key={c} className={STICKY.has(c) ? 'sticky' : ''} scope="col" aria-sort={sortable && sort.key === c ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
                    {sortable ? <button type="button" className="th-btn" onClick={() => sortBy(c as SortKey)}>{c}{sort.key === c ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}</button> : c}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, limit).map((r, i) => (
              <tr key={String(r.Accession)}>
                <td className="rownum">{i + 1}</td>
                {shownCols.map((c) => {
                  const v = r[c] ?? ''
                  if (c === 'Company') return <td key={c} className="sticky"><button type="button" className="linklike" onClick={() => open(r)}>{v}</button></td>
                  if (c === 'SEC link') return <td key={c}>{v ? <a href={String(v)} target="_blank" rel="noreferrer">Open ↗</a> : ''}</td>
                  const isEvent = c !== 'Events found' && COLUMNS.indexOf(c) >= 8 && COLUMNS.indexOf(c) <= 20 && !!v
                  return <td key={c} className={`${isEvent ? 'hit' : ''} ${c === 'Events found' || c === 'Top confidence' ? 'num' : ''} ${String(v).startsWith('Error') ? 'err' : ''}`} title={String(v)}>{v}</td>
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown.length > limit && (
        <p className="sheet-more">
          <span className="muted small">Showing the first {limit} of {shown.length} rows on screen. Downloads include all {shown.length}.</span>{' '}
          <button type="button" className="btn small" onClick={() => setLimit((n) => n + 500)}>Show 500 more</button>
        </p>
      )}
    </>
  )
}
