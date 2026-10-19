import { fmtSecs } from '../hooks'
import type { ModelStatus } from '../types'

export type Tunnel = 'unknown' | 'closed' | 'open'

export interface BootEvent {
  at: number // seconds since the start was requested
  text: string
  tone?: 'good' | 'bad' | 'warn'
}

export interface BootState {
  account: string
  elapsed: number
  estimate: number
  kaggle: string // QUEUED | RUNNING | COMPLETE | ERROR | CANCEL* | NONE | ''
  kaggleUrl: string
  tunnel: Tunnel
  serverUp: boolean
  models: ModelStatus[] | null
  checkedAgo: number
  events: BootEvent[]
  failure?: string
}

type StepState = 'done' | 'active' | 'todo' | 'failed'

const finished = (k: string) => k === 'COMPLETE' || k === 'ERROR' || k.startsWith('CANCEL')

export function stepsFor(b: BootState): { label: string; detail: string; state: StepState }[] {
  const failed = !!b.failure
  const running = b.kaggle === 'RUNNING' || b.tunnel === 'open' || b.serverUp
  const ready = b.models ? b.models.filter((m) => m.state === 'ready').length : 0
  const total = b.models?.length || 11
  const allReady = b.serverUp && ready >= total
  const st = (done: boolean, active: boolean): StepState => (done ? 'done' : failed && active ? 'failed' : active ? 'active' : 'todo')
  return [
    { label: 'Asked Kaggle to start the server', detail: `on the ${b.account} account`, state: 'done' },
    { label: 'Kaggle gives us a GPU', detail: b.kaggle === 'QUEUED' ? 'waiting in Kaggle’s queue' : running ? 'session is running' : 'waiting for Kaggle', state: st(running, !running) },
    { label: 'Installing software and opening the public address', detail: b.tunnel === 'open' || b.serverUp ? 'public address is open' : 'usually 4–8 minutes', state: st(b.tunnel === 'open' || b.serverUp, running && b.tunnel !== 'open' && !b.serverUp) },
    { label: `Loading the ${total} AI models onto the GPUs`, detail: b.serverUp ? `${ready} of ${total} ready` : 'starts once the address is open', state: st(allReady, (b.tunnel === 'open' || b.serverUp) && !allReady) },
    { label: 'Ready to analyze filings', detail: allReady ? 'all models are on' : 'last step', state: allReady ? 'done' : 'todo' },
  ]
}

const ICON: Record<StepState, string> = { done: '✓', active: '…', todo: '', failed: '✕' }

export default function StartProgress({ b, onRetry, onClose, onSwitch, switching }: { b: BootState; onRetry: () => void; onClose: () => void; onSwitch?: () => void; switching?: boolean }) {
  const steps = stepsFor(b)
  const left = Math.max(0, b.estimate - b.elapsed)
  const slow = b.elapsed > b.estimate + 300 && !b.failure && !b.serverUp
  const pct = Math.min(96, Math.round((steps.filter((s) => s.state === 'done').length / steps.length) * 80 + (b.models ? (b.models.filter((m) => m.state === 'ready').length / (b.models.length || 11)) * 20 : 0)))

  return (
    <div className="mstatus bootpanel" role="dialog" aria-label="Server start-up progress" aria-live="polite">
      <div className="mstatus-head">
        <div>
          <b>{b.failure ? 'The server did not start' : `Starting the server on ${b.account}`}</b>
          <small className="muted block">
            {b.failure ? 'See the reason below.' : `${fmtSecs(b.elapsed)} elapsed · ${left > 0 ? `about ${fmtSecs(left)} left` : 'taking a little longer than usual'}`}
          </small>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Hide progress">×</button>
      </div>

      {!b.failure && <div className="meter big" aria-hidden="true"><i style={{ width: `${Math.max(4, pct)}%` }} /></div>}

      <ol className="bsteps">
        {steps.map((s) => (
          <li key={s.label} className={`b-${s.state}`}>
            <span className="bdot" aria-hidden="true">{ICON[s.state]}</span>
            <span>
              <b>{s.label}</b>
              <small className="block">{s.detail}</small>
            </span>
          </li>
        ))}
      </ol>

      {b.models && b.serverUp && (
        <ul className="bmodels">
          {b.models.map((m) => (
            <li key={m.key} className={`s-${m.state}`} title={m.error ?? undefined}><span className="mdot" />{m.title.split(' ')[0]}{m.state === 'error' ? ' ✕' : ''}</li>
          ))}
        </ul>
      )}

      {b.failure && (
        <div className="explain bad" role="alert">
          <b>What went wrong:</b> {b.failure}
          <div className="boot-actions">
            <a className="btn small" href={b.kaggleUrl} target="_blank" rel="noreferrer">Open the Kaggle log ↗</a>
            <button type="button" className="btn small primary" onClick={onRetry}>Try again / pick another account</button>
          </div>
        </div>
      )}
      {slow && (
        <div className="explain warn">
          This is taking much longer than usual. Kaggle says <b>{b.kaggle || 'unknown'}</b>. Open the Kaggle log to see where it is stuck, or start on a different account.
          <div className="boot-actions"><a className="btn small" href={b.kaggleUrl} target="_blank" rel="noreferrer">Open the Kaggle log ↗</a></div>
        </div>
      )}

      {!b.failure && !b.serverUp && onSwitch && (
        <div className="boot-actions">
          <button type="button" className="btn small" onClick={onSwitch} disabled={switching}>{switching ? 'Stopping…' : 'Stop this and use a different account'}</button>
        </div>
      )}

      <div className="bfoot">
        <span className={`live-dot ${b.failure ? 'bad' : ''}`} aria-hidden="true" />
        <small className="muted">Kaggle run status: <b>{b.kaggle || 'checking…'}</b> · updated {b.checkedAgo <= 1 ? 'just now' : `${b.checkedAgo}s ago`}</small>
      </div>

      <h4>What has happened</h4>
      <ul className="bevents">
        {[...b.events].reverse().slice(0, 10).map((e, i) => (
          <li key={`${e.at}-${i}`} className={e.tone ?? ''}><time>{fmtSecs(e.at)}</time> {e.text}</li>
        ))}
      </ul>
    </div>
  )
}

export { finished }
