import { useEffect, useRef } from 'react'
import { fmtSecs, useNow } from '../hooks'
import type { JobStatus } from '../types'

interface Props {
  job: JobStatus | null
  /** Set while we are waiting for the sleeping model server to start (before the job exists). */
  waking: { elapsed: number; estimate: number } | null
  /** True if this filing needed the model server to be started first. */
  wasAsleep: boolean
}

const STEPS = [
  { id: 'wake', label: 'Start the AI model', hint: 'Only needed when it has been idle' },
  { id: 'fetching', label: 'Download the filing from the SEC', hint: '' },
  { id: 'locating', label: 'Find the Items in the filing (5.02, 1.03, 2.02 …)', hint: '' },
  { id: 'reading', label: 'AI readers check for CEO changes', hint: '' },
  { id: 'detectors', label: 'Check every other event type (CFO, bankruptcy, delisting, auditor, votes, deals, agreements, equity, earnings, restructuring)', hint: '' },
] as const

const rank: Record<string, number> = { queued: 1, fetching: 1, locating: 2, splitting: 3, reading: 3, detectors: 4, done: 5 }

export default function WaitLoader({ job, waking, wasAsleep }: Props) {
  const now = useNow(200)

  // When did the latest server update arrive? Used to count down smoothly between polls.
  const sync = useRef({ at: performance.now(), eta: 0, elapsed: 0 })
  useEffect(() => {
    if (job) sync.current = { at: performance.now(), eta: job.etaSeconds ?? 0, elapsed: job.elapsed ?? 0 }
  }, [job])

  let step = 0
  let pct = 0
  let eta = 0
  let elapsed = 0
  let detail = ''
  let late = false

  if (!job && waking) {
    step = 0
    elapsed = waking.elapsed
    eta = waking.estimate - waking.elapsed
    late = eta <= 0
    pct = Math.min(0.9, waking.elapsed / waking.estimate) * 0.25
    detail = 'Loading the AI readers into memory…'
  } else if (job) {
    step = rank[job.stage] ?? 1
    const since = (now - sync.current.at) / 1000
    elapsed = sync.current.elapsed + since
    eta = sync.current.eta - since
    late = eta <= 0 && job.stage !== 'done'
    pct = 0.25 + 0.75 * (job.progress ?? 0)
    if (job.stage === 'detectors') detail = job.detail ?? 'Checking for other events…'
    else if (job.stage === 'reading' && job.unitsTotal) {
      detail = `Reading the leadership section (${job.sentenceCount ?? '…'} sentences)`
    } else if (job.stage === 'fetching' || job.stage === 'queued') detail = 'Contacting sec.gov…'
    else if (job.stage === 'locating') detail = 'Searching the filing for Item 5.02…'
    else if (job.stage === 'splitting') detail = `Found ${job.sentenceCount ?? '…'} sentences to read`
  }

  const visible = STEPS.filter((s) => s.id !== 'wake' || wasAsleep)
  const activeIdx = step - (wasAsleep ? 0 : 1)
  const percent = Math.max(2, Math.min(99, Math.round(pct * 100)))
  const etaText = late ? 'Finishing up…' : `about ${fmtSecs(eta)} left`

  return (
    <div className="card wait" role="status" aria-live="polite" aria-label={`Analyzing. ${percent} percent. ${etaText}`}>
      <div className="wait-top">
        <div className="wait-pct" aria-hidden="true">{percent}<small>%</small></div>
        <div className="wait-times">
          <div className="wait-eta">{etaText}</div>
          <div className="muted small">{fmtSecs(elapsed)} elapsed{!job && waking ? ' · waking the server' : ''}</div>
        </div>
      </div>

      <div className="meter big" aria-hidden="true">
        <i style={{ width: `${percent}%` }} />
      </div>
      <p className="wait-detail">{detail}</p>

      <ol className="psteps">
        {visible.map((s, i) => {
          const state = i < activeIdx ? 'done' : i === activeIdx ? 'active' : 'todo'
          return (
            <li key={s.id} className={state}>
              <span className="pdot">{state === 'done' ? '✓' : i + 1}</span>
              <span>
                {s.label}
                {state === 'active' && s.hint && <small className="block muted">{s.hint}</small>}
              </span>
            </li>
          )
        })}
      </ol>
      <p className="muted small wait-foot">
        Most filings take 3–10 seconds{wasAsleep ? `, plus about ${Math.round(waking?.estimate ?? 15)} seconds because the AI model was asleep` : ''}. The estimate corrects itself as the work progresses.
      </p>
    </div>
  )
}
