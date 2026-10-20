import { useMemo, useState } from 'react'
import { march } from '../data/march'
import type { EventRow, Kind, Verdict } from '../types'
import { fmtDate, kindLabel, pct, verdictLabel } from '../utils'
import Highlight from '../components/Highlight'

type KindFilter = 'all' | Kind
type VerdictFilter = 'all' | Verdict

const PAGE = 25

function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: [T, string][]; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" className={v === value ? 'on' : ''} aria-pressed={v === value} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  )
}

function Detail({ e, onClose }: { e: EventRow; onClose: () => void }) {
  const names = [e.aiName, e.truthName]
  return (
    <aside className="drawer" aria-label={`Details for ${e.company}`}>
      <div className="drawer-head">
        <div>
          <span className={`pill v-${e.verdict}`}>{verdictLabel[e.verdict]}</span>
          <h3>{e.company}</h3>
          <p className="muted">{kindLabel[e.kind]} · filed {fmtDate(e.date)}</p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close details">×</button>
      </div>

      {e.verdict === 'correct' && <p className="explain good">The AI flagged this and the independent answer key agrees.</p>}
      {e.verdict === 'false_alarm' && <p className="explain bad">The AI flagged this, but the answer key says it is <b>not</b> a real {e.kind === 'appointed' ? 'CEO appointment' : 'CEO departure'}. Read the sentence below to see why it was confusing.</p>}
      {e.verdict === 'missed' && <p className="explain warn">The answer key says this is real, but the AI did <b>not</b> flag it.</p>}

      {e.aiSentence && (
        <>
          <h4>Sentence the AI relied on</h4>
          <blockquote><Highlight text={e.aiSentence} names={names} /></blockquote>
          {e.confidence !== null && (
            <div className="conf" aria-label={`Confidence ${pct(e.confidence)}`}>
              <span>AI confidence</span>
              <div className="meter"><i style={{ width: `${e.confidence * 100}%` }} /></div>
              <b>{pct(e.confidence)}</b>
            </div>
          )}
        </>
      )}
      {e.truthSentence && (
        <>
          <h4>{e.verdict === 'missed' ? 'Sentence the AI should have caught' : 'Answer key’s sentence'}</h4>
          <blockquote><Highlight text={e.truthSentence} names={names} /></blockquote>
        </>
      )}
      {(e.aiName || e.truthName) && <p><b>Person:</b> {e.truthName || e.aiName}</p>}
      <a className="btn primary" href={e.url} target="_blank" rel="noreferrer">Open original SEC filing ↗</a>
    </aside>
  )
}

export default function Explorer() {
  const [kind, setKind] = useState<KindFilter>('all')
  const [verdict, setVerdict] = useState<VerdictFilter>('all')
  const [q, setQ] = useState('')
  const [shown, setShown] = useState(PAGE)
  const [sel, setSel] = useState<EventRow | null>(null)

  const rows = useMemo(() => {
    const t = q.trim().toLowerCase()
    return march.events.filter(
      (e) =>
        (kind === 'all' || e.kind === kind) &&
        (verdict === 'all' || e.verdict === verdict) &&
        (!t || e.company.toLowerCase().includes(t) || e.aiName.toLowerCase().includes(t) || e.truthName.toLowerCase().includes(t)),
    )
  }, [kind, verdict, q])

  const counts = useMemo(() => {
    const c = { correct: 0, false_alarm: 0, missed: 0 }
    march.events.forEach((e) => c[e.verdict]++)
    return c
  }, [])

  const reset = () => setShown(PAGE)

  return (
    <>
      <section className="hero compact">
        <span className="eyebrow">Real output · {march.period.label}</span>
        <h1>Test results</h1>
        <p className="lead">March 2025 CEO events from the earlier three-reader model: what it flagged and what it missed. Click a row to read the sentence.</p>
      </section>

      <div className="summary-chips">
        <button type="button" className={`chip v-correct ${verdict === 'correct' ? 'on' : ''}`} onClick={() => { setVerdict(verdict === 'correct' ? 'all' : 'correct'); reset() }}>
          <b>{counts.correct}</b> confirmed correct
        </button>
        <button type="button" className={`chip v-false_alarm ${verdict === 'false_alarm' ? 'on' : ''}`} onClick={() => { setVerdict(verdict === 'false_alarm' ? 'all' : 'false_alarm'); reset() }}>
          <b>{counts.false_alarm}</b> false alarms
        </button>
        <button type="button" className={`chip v-missed ${verdict === 'missed' ? 'on' : ''}`} onClick={() => { setVerdict(verdict === 'missed' ? 'all' : 'missed'); reset() }}>
          <b>{counts.missed}</b> missed by the AI
        </button>
      </div>

      <div className="toolbar">
        <label className="search">
          <span className="sr-only">Search company or person</span>
          <input type="search" placeholder="Search company or person…" value={q} onChange={(e) => { setQ(e.target.value); reset() }} />
        </label>
        <Segmented<KindFilter>
          label="Event type"
          value={kind}
          onChange={(v) => { setKind(v); reset() }}
          options={[['all', 'All'], ['appointed', 'New CEO'], ['resigned', 'CEO leaving']]}
        />
      </div>

      <div className={`explorer ${sel ? 'with-drawer' : ''}`}>
        <div className="list" role="list">
          {rows.length === 0 && <p className="empty">No events match these filters.</p>}
          {rows.slice(0, shown).map((e) => (
            <button type="button" role="listitem" key={e.id} className={`row ${sel?.id === e.id ? 'sel' : ''}`} onClick={() => setSel(e)}>
              <span className={`kind k-${e.kind}`}>{e.kind === 'appointed' ? '＋' : '−'}</span>
              <span className="row-main">
                <b>{e.company}</b>
                <small>{kindLabel[e.kind]}{e.aiName || e.truthName ? ` · ${e.truthName || e.aiName}` : ''}</small>
              </span>
              <span className="row-date">{fmtDate(e.date)}</span>
              <span className={`pill v-${e.verdict}`}>{verdictLabel[e.verdict]}</span>
            </button>
          ))}
          {shown < rows.length && (
            <button type="button" className="btn more" onClick={() => setShown(shown + PAGE)}>
              Show more ({rows.length - shown} remaining)
            </button>
          )}
        </div>
        {sel && <Detail e={sel} onClose={() => setSel(null)} />}
      </div>
    </>
  )
}
