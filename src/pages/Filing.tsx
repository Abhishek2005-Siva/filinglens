import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, pollJob, startAnalysis } from '../api'
import WaitLoader from '../components/WaitLoader'
import { useNow } from '../hooks'
import DetectorCard from '../components/DetectorCard'
import Highlight from '../components/Highlight'
import { clearStarting, coldEstimate, markReady, markStarting, recordCold } from '../modelState'
import { memory } from '../searchState'
import type { AnalysisResult, Extraction, JobStatus } from '../types'
import { fmtDate, pct, whenText } from '../utils'

function Panel({ kind, ex }: { kind: 'appointed' | 'resigned'; ex: Extraction }) {
  const title = kind === 'appointed' ? 'New CEO named' : 'Steps down as CEO'
  return (
    <div className={`card extract ${ex.found ? `found k-${kind}` : 'none'}`}>
      <div className="extract-head">
        <span className={`kind k-${kind}`}>{kind === 'appointed' ? '＋' : '−'}</span>
        <div>
          <h3>{title}</h3>
          {ex.found && ex.check?.state === 'review' && <span className="pill review">Needs review</span>}
          {ex.found && ex.check?.state === 'likely_wrong' && <span className="pill warn">Probably wrong</span>}
          <p className="muted small">{ex.found ? (ex.readers && ex.readers.length > 1 ? `${ex.votesFor} of ${ex.readers.length} readers agreed` : 'Found by the AI reader') : 'Not found in this filing'}</p>
        </div>
      </div>
      {ex.found && (
        <>
          <dl className="facts">
            <div><dt>{ex.names && ex.names.length > 1 ? 'People' : 'Person'}</dt><dd>{ex.names && ex.names.length > 1 ? ex.names.join(', ') : ex.name || 'Not named in the sentence'}</dd></div>
            {(ex.staysAs || ex.staysKind) && (
              <div><dt>Stays with the company</dt><dd>{ex.staysAs ? `As ${ex.staysAs}` : ex.staysKind === 'board' ? 'Yes, on the board' : 'Yes, in another role (for example chair, advisor or employee)'}</dd></div>
            )}
            {ex.coCeo && <div><dt>Role</dt><dd>Co-CEO</dd></div>}
            {whenText(ex) && <div><dt>Effective</dt><dd>{whenText(ex)}</dd></div>}
            {ex.decided && <div><dt>{kind === 'resigned' ? 'Announced / notice' : 'Decided'}</dt><dd>{fmtDate(ex.decided)}</dd></div>}
            <div><dt>Confidence</dt><dd>{ex.confidence != null ? pct(ex.confidence, 2) : '—'}</dd></div>
            {ex.check?.score != null && <div><dt>Checker</dt><dd>{pct(ex.check.score, 1)}</dd></div>}
          </dl>
          {(ex.check?.state === 'review' || ex.check?.state === 'likely_wrong') && <p className="explain warn">{ex.check.reason || 'The checker is not sure about this one.'} Please read the sentence below.</p>}
          {ex.check?.repointed && <p className="muted small">The checker moved to a better sentence of the same section.</p>}
          <h4>Sentence the AI relied on</h4>
          <blockquote><Highlight text={ex.sentence ?? ''} names={[ex.name ?? '']} /></blockquote>
          <h4>{ex.readers && ex.readers.length > 1 ? 'How each reader voted' : 'How sure the reader was'}</h4>
          <ul className="votes">
            {ex.readers?.map((r) => (
              <li key={r.reader} className={r.voted ? 'yes' : 'no'}>
                <span aria-hidden="true">{r.voted ? '✓' : '–'}</span>
                <span>{r.reader}</span>
                <b>{r.voted && r.confidence != null ? pct(r.confidence, 1) : 'not sure enough'}</b>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function Result({ r }: { r: AnalysisResult }) {
  const [showAll, setShowAll] = useState(false)
  const [copied, setCopied] = useState(false)
  const data = useMemo(
    () => ({
      company: r.filing.company,
      cik: r.filing.cik,
      accession_number: r.filing.accession,
      form: r.filing.form,
      filing_date: r.filing.filed,
      item_502_present: r.item502Found,
      ceo_appointed: r.appointed.found,
      appointed_name: r.appointed.name ?? '',
      appointed_sentence: r.appointed.sentence ?? '',
      appointed_confidence: r.appointed.confidence ?? null,
      ceo_resigned: r.resigned.found,
      resigned_name: r.resigned.name ?? '',
      resigned_sentence: r.resigned.sentence ?? '',
      resigned_confidence: r.resigned.confidence ?? null,
      source_url: r.filing.url,
      other_events: (r.detectors ?? []).filter((d) => d.applicable).map((d) => ({ detector: d.key, item: d.item, found: d.found, events: d.events.map((e) => ({ event: e.title, confidence: e.confidence ?? null, detail: e.detail ?? '', evidence: e.evidence ?? '' })), fields: d.fields ?? {} })),
    }),
    [r],
  )

  const dets = r.detectors ?? []
  const foundDets = dets.filter((d) => d.applicable && d.found)
  const quietDets = dets.filter((d) => d.applicable && !d.found)
  const absentDets = dets.filter((d) => !d.applicable)
  const ceoCount = (r.appointed.found ? 1 : 0) + (r.resigned.found ? 1 : 0)
  const eventCount = ceoCount + foundDets.reduce((n, d) => n + d.events.length, 0)
  const titles = [
    ...(r.appointed.found ? ['New CEO named'] : []),
    ...(r.resigned.found ? ['Steps down as CEO'] : []),
    ...foundDets.flatMap((d) => d.events.map((e) => e.title)),
  ]
  const tone: 'good' | 'neutral' = eventCount > 0 ? 'good' : 'neutral'
  const headline =
    eventCount > 0
      ? `${eventCount} event${eventCount === 1 ? '' : 's'} found in this filing`
      : dets.some((d) => d.applicable) || r.item502Found
        ? 'Checked, and none of the events we track were reported'
        : 'This filing does not report any event we track'

  const rows = showAll ? r.sentences : r.sentences.filter((s) => s.readers.some((x) => x.label !== 'NONE'))

  return (
    <>
      <div className={`banner ${tone}`}>
        <b>{headline}</b>
        <span>
          {titles.length > 0 ? `${titles.join(' · ')} · ` : ''}Analyzed in {r.seconds}s
        </span>
      </div>

      {eventCount > 0 && <h2 className="sec-h">What happened</h2>}
      <div className="grid-2 tight">
        {r.appointed.found && <Panel kind="appointed" ex={r.appointed} />}
        {r.resigned.found && <Panel kind="resigned" ex={r.resigned} />}
        {foundDets.map((d) => <DetectorCard key={d.key} d={d} />)}
      </div>

      {(quietDets.length > 0 || (r.item502Found && ceoCount === 0)) && (
        <section>
          <h2 className="sec-h">Checked, nothing reported</h2>
          <ul className="quiet">
            {r.item502Found && ceoCount === 0 && <li><b>CEO change</b><small>Item 5.02</small></li>}
            {quietDets.map((d) => (
              <li key={d.key} title={d.note ?? 'Checked this section. Nothing newly reported.'}>
                <b>{d.title}</b>
                <small>Item {d.item}</small>
                {d.error && <em className="bad-text">error</em>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {absentDets.length > 0 && (
        <p className="muted small absent">
          Not in this filing: {[...(r.item502Found ? [] : ['Leadership change (Item 5.02)']), ...absentDets.map((d) => `${d.title} (Item ${d.item})`)].join(' · ')}.
        </p>
      )}

      {r.skippedModel && (
        <p className="explain good">
          <b>{r.skippedModel}</b>
        </p>
      )}

      {r.item502Found && !r.skippedModel && (
        <section>
          <h2>Everything the AI read for the CEO check</h2>
          <p className="muted">Each sentence, and how the AI labeled it.</p>
          <div className="seg" role="group" aria-label="Which sentences">
            <button type="button" className={!showAll ? 'on' : ''} aria-pressed={!showAll} onClick={() => setShowAll(false)}>Flagged by any reader</button>
            <button type="button" className={showAll ? 'on' : ''} aria-pressed={showAll} onClick={() => setShowAll(true)}>All {r.sentences.length}</button>
          </div>
          <div className="sentences">
            {rows.length === 0 && <p className="empty">No sentence looked like a CEO appointment or departure to any reader.</p>}
            {rows.map((s, i) => (
              <div key={i} className="card sent">
                <p><Highlight text={s.text} names={[r.appointed.name ?? '', r.resigned.name ?? '']} /></p>
                <div className="chips">
                  {s.readers.map((x) => (
                    <span key={x.reader} className={`rchip l-${x.label.toLowerCase()} ${x.counts ? 'counts' : ''}`} title={`${x.reader}: ${x.label} ${pct(x.confidence, 1)}`}>
                      {x.reader.split(' · ')[0]}: {x.label === 'NONE' ? 'no CEO change' : x.label === 'APPOINTED' ? 'new CEO' : 'CEO leaving'} · {pct(x.confidence, 0)}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2>Extracted data</h2>
        <div className="card">
          <div className="code-head">
            <span className="muted small">Structured result, ready to copy</span>
            <button
              type="button"
              className="btn small"
              onClick={() => navigator.clipboard.writeText(JSON.stringify(data, null, 2)).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1500) })}
            >
              {copied ? 'Copied ✓' : 'Copy JSON'}
            </button>
          </div>
          <pre className="code">{JSON.stringify(data, null, 2)}</pre>
        </div>
      </section>
    </>
  )
}

export default function Filing({ cik, accession }: { cik: string; accession: string }) {
  const [job, setJob] = useState<JobStatus | null>(null)
  const [err, setErr] = useState<{ code: string; message: string } | null>(null)
  const cancelled = useRef(false)
  const [wakeStart, setWakeStart] = useState<number | null>(null)
  const [wasAsleep, setWasAsleep] = useState(false)
  const now = useNow(250)

  const sel = memory.selected?.accession === accession ? memory.selected : null
  const meta = job?.result?.filing ?? job?.filing

  useEffect(() => {
    cancelled.current = false
    setJob(null)
    setErr(null)
    setWakeStart(null)
    setWasAsleep(false)
    let timer: number
    const tick = async (id: string) => {
      try {
        const j = await pollJob(id)
        if (cancelled.current) return
        setJob(j)
        markReady()
        if (j.stage === 'error') return setErr({ code: 'job', message: j.error ?? 'The analysis failed.' })
        if (j.stage !== 'done') timer = window.setTimeout(() => void tick(id), 1000)
      } catch (e) {
        if (cancelled.current) return
        setErr({ code: e instanceof ApiError ? e.code : 'error', message: e instanceof Error ? e.message : 'Lost connection' })
      }
    }
    // The model service sleeps when idle; keep retrying while it wakes up (up to ~4 minutes).
    let wakeT0: number | null = null
    const start = async (attempt: number): Promise<void> => {
      try {
        const id = await startAnalysis(cik, accession)
        if (wakeT0 !== null) recordCold((performance.now() - wakeT0) / 1000)
        if (!cancelled.current) void tick(id)
      } catch (e) {
        if (cancelled.current) return
        const code = e instanceof ApiError ? e.code : 'error'
        if ((code === 'model_unavailable' || code === 'model_unreachable') && attempt < 60) {
          if (wakeT0 === null) {
            wakeT0 = performance.now()
            setWakeStart(wakeT0)
            setWasAsleep(true)
            markStarting()
          }
          timer = window.setTimeout(() => void start(attempt + 1), 2000)
          return
        }
        clearStarting()
        setErr({ code, message: e instanceof Error ? e.message : 'Could not start' })
      }
    }
    void start(0)
    return () => {
      cancelled.current = true
      window.clearTimeout(timer)
    }
  }, [cik, accession])

  const company = meta?.company || sel?.company || `CIK ${cik}`
  const form = meta?.form || sel?.form || '8-K'
  const filed = meta?.filed || sel?.date || ''
  const secUrl = sel?.indexUrl ?? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/${accession}-index.htm`

  return (
    <>
      <p className="crumb"><a href="#/search">← Back to search results</a></p>
      <section className="filing-head">
        <span className="eyebrow">{form} filing</span>
        <h1>{company}</h1>
        <p className="muted">
          {filed && `Filed ${fmtDate(filed)} · `}Accession {accession} · CIK {cik}
          {(meta?.items?.length ?? sel?.items.length) ? ` · Items ${(meta?.items?.length ? meta.items : sel?.items ?? []).join(', ')}` : ''}
        </p>
        <a className="btn" href={secUrl} target="_blank" rel="noreferrer">View on SEC.gov ↗</a>
      </section>

      {err ? (
        <div className="card err-card" role="alert">
          <h3>{err.code === 'model_offline' ? 'The model server is off' : err.code === 'model_host' ? 'The model host has paused the model server' : err.code === 'not_configured' ? 'The model backend isn’t connected yet' : err.code === 'model_unreachable' || err.code === 'model_unavailable' ? 'The model is waking up' : 'We couldn’t analyze this filing'}</h3>
          <p>{err.message}</p>
          <button type="button" className="btn primary" onClick={() => window.location.reload()}>Try again</button>
        </div>
      ) : job?.stage === 'done' && job.result ? (
        <Result r={job.result} />
      ) : (
        <WaitLoader job={job} waking={!job && wakeStart !== null ? { elapsed: (now - wakeStart) / 1000, estimate: coldEstimate() } : null} wasAsleep={wasAsleep} />
      )}
    </>
  )
}
