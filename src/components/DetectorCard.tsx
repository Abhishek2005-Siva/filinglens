import Highlight from './Highlight'
import type { DetectorEvent, DetectorResult } from '../types'
import { fmtDate, pct, whenText } from '../utils'

export const ICON: Record<string, string> = {
  bankruptcy: '⚖', delisting: '⇩', auditor: '✎', votes: '☑', cfo: '👔', acquisition: '🤝', agreements: '📄', equity: '📈', guidance: '📊', restructuring: '🏭',
}
export const TONE: Record<string, string> = {
  bankruptcy: 'red', delisting: 'amber', auditor: 'violet', votes: 'blue', cfo: 'green', acquisition: 'blue', agreements: 'violet', equity: 'amber', guidance: 'blue', restructuring: 'red',
}

const nice = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
const show = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v))

function Event({ e }: { e: DetectorEvent }) {
  return (
    <div className={`devent ${e.kind ? `person-event k-${e.kind}` : ''}`}>
      <div className="devent-head">
        {e.kind && <span className={`kind k-${e.kind}`} aria-hidden="true">{e.kind === 'appointed' ? '＋' : '−'}</span>}
        <b>{e.title}</b>
        {e.confidence != null && <span className="pill v-correct">{pct(e.confidence, 1)} sure</span>}
        {e.flag === 'likely_wrong' && <span className="pill warn">Probably wrong</span>}
        {e.flag === 'review' && <span className="pill review">Needs review</span>}
        {e.source && <span className="pill src">{e.source}</span>}
      </div>
      {e.kind && (
        <dl className="facts">
          <div><dt>Person</dt><dd>{e.name || 'Not named in the sentence'}{e.interim ? ' (interim)' : ''}</dd></div>
          {whenText(e) && <div><dt>Effective</dt><dd>{whenText(e)}</dd></div>}
          {e.decided && <div><dt>{e.kind === 'resigned' ? 'Announced / notice' : 'Decided'}</dt><dd>{fmtDate(e.decided)}</dd></div>}
        </dl>
      )}
      {e.detail && <p className="devent-detail">{e.detail}</p>}
      {e.evidence && (
        <blockquote>
          <Highlight text={e.evidence} names={[]} />
        </blockquote>
      )}
      {e.readers && e.readers.length > 0 && (
        <ul className="votes compact">
          {e.readers.map((r) => (
            <li key={r.reader} className="yes">
              <span aria-hidden="true">✓</span>
              <span>{r.reader}</span>
              <b>{pct(r.probability, 1)}</b>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function DetectorCard({ d }: { d: DetectorResult }) {
  const fields = Object.entries(d.fields ?? {}).filter(([, v]) => v !== null && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0))
  return (
    <div className={`card dcard tone-${TONE[d.key] ?? 'blue'} ${d.found ? 'found' : 'none'} ${d.voteRows && d.voteRows.length > 0 ? 'wide' : ''}`}>
      <div className="extract-head">
        <span className={`dicon t-${TONE[d.key] ?? 'blue'}`} aria-hidden="true">{ICON[d.key] ?? '•'}</span>
        <div>
          <h3>{d.title}</h3>
          <p className="muted small">Form 8-K Item {d.item}{d.seconds != null ? ` · checked in ${d.seconds}s` : ''}</p>
        </div>
      </div>
      {d.experimental && d.found && <p className="caveat"><b>Note:</b> {d.experimental}</p>}
      {d.error && <p className="explain warn">This detector hit an error: {d.error}</p>}
      {d.note && <p className="muted small">{d.note}</p>}
      {d.events.map((e) => <Event key={e.label} e={e} />)}
      {fields.length > 0 && (
        <>
          <h4>Details pulled from the text</h4>
          <dl className="facts">
            {fields.map(([k, v]) => (
              <div key={k}><dt>{nice(k)}</dt><dd>{show(v)}</dd></div>
            ))}
          </dl>
        </>
      )}
      {d.voteRows && d.voteRows.length > 0 && (
        <>
          <h4>Vote results</h4>
          <div className="table-wrap vtable">
            <table className="data">
              <thead>
                <tr>{[...new Set(d.voteRows.flatMap((r) => Object.keys(r)))].map((c) => <th key={c} scope="col">{c}</th>)}</tr>
              </thead>
              <tbody>
                {d.voteRows.map((row, j) => (
                  <tr key={j}>
                    {[...new Set(d.voteRows!.flatMap((r) => Object.keys(r)))].map((c) => (
                      <td key={c}>{typeof row[c] === 'number' ? (row[c] as number).toLocaleString('en-US') : row[c] === undefined ? '' : String(row[c])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {!d.found && !d.error && <p className="muted small">Checked this section. Nothing newly reported.</p>}
      {d.readerNames && d.readerNames.length > 0 && <p className="muted small foot-readers">Read by: {d.readerNames.join(' · ')}</p>}
    </div>
  )
}
