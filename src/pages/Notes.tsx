import { useMemo, useState } from 'react'
import { noteGroups } from '../data/notes'

export default function Notes() {
  const [q, setQ] = useState('')
  const t = q.trim().toLowerCase()

  const groups = useMemo(
    () =>
      noteGroups
        .map((g) => ({
          ...g,
          tables: g.tables
            .map((tb) => ({
              ...tb,
              rows: !t || `${tb.title} ${tb.intro ?? ''}`.toLowerCase().includes(t) ? tb.rows : tb.rows.filter((r) => r.join(' ').toLowerCase().includes(t)),
            }))
            .filter((tb) => tb.rows.length > 0),
        }))
        .filter((g) => g.tables.length > 0),
    [t],
  )

  return (
    <>
      <section className="hero compact">
        <span className="eyebrow">Reference notes</span>
        <h1>Every model and metric</h1>
        <p className="lead">P = how often alerts are right · R = how many real events are found · F1 = both in one number.</p>
      </section>

      <div className="notes-layout">
        <nav className="toc" aria-label="Sections">
          <label className="search">
            <span className="sr-only">Search notes</span>
            <input type="search" placeholder="Search e.g. v7, DeBERTa, July…" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <ul>
            {noteGroups.map((g) => (
              <li key={g.id}>
                <a href={`#/notes`} onClick={(e) => { e.preventDefault(); document.getElementById(g.id)?.scrollIntoView({ behavior: 'smooth' }) }}>
                  {g.title}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="notes-body">
          {groups.length === 0 && <p className="empty">Nothing matches “{q}”.</p>}
          {groups.map((g) => (
            <section key={g.id} id={g.id} className="note-group">
              <h2>{g.title}</h2>
              <p className="muted">{g.summary}</p>
              {g.tables.map((tb) => (
                <div key={tb.id} className="card table-card">
                  <h3>{tb.title}</h3>
                  {tb.intro && <p className="muted small">{tb.intro}</p>}
                  <div className="table-wrap" tabIndex={0} role="region" aria-label={tb.title}>
                    <table className="data">
                      <thead>
                        <tr>{tb.columns.map((c, i) => <th key={i} scope="col">{c}</th>)}</tr>
                      </thead>
                      <tbody>
                        {tb.rows.map((r, i) => (
                          <tr key={i}>{r.map((c, j) => (j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j} className={c.length > 38 ? 'long' : undefined}>{c}</td>))}</tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {tb.footnote && <p className="muted small foot">{tb.footnote}</p>}
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </>
  )
}
