import { useEffect, useState } from 'react'
import { hostCall, type HostAccounts, type StartResult } from '../host'

interface Props {
  onClose: () => void
  onStarted: (r: StartResult) => void
  onAlreadyRunning: (account: string) => void
}

const when = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? 'the weekly reset' : d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

export default function StartPanel({ onClose, onStarted, onAlreadyRunning }: Props) {
  const [data, setData] = useState<HostAccounts | null>(null)
  const [pick, setPick] = useState('')
  const [hours, setHours] = useState(3)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    hostCall<HostAccounts>('accounts')
      .then((d) => {
        if (!alive) return
        setData(d)
        const free = d.accounts.filter((a) => a.kernel !== 'RUNNING' && a.kernel !== 'QUEUED')
        setPick(free.find((a) => a.id === d.defaultAccount)?.id ?? free[0]?.id ?? '')
        setErr('')
      })
      .catch((e) => {
        if (!alive) return
        setErr(e instanceof Error ? e.message : 'Could not load the accounts.')
      })
    return () => { alive = false }
  }, [])

  const start = async () => {
    setBusy(true)
    setErr('')
    try {
      if (!pick) throw new Error('Choose an account first.')
      onStarted(await hostCall<StartResult>('start', { account: pick, runHours: hours }))
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not start the server.')
    } finally {
      setBusy(false)
    }
  }

  const free = data?.accounts.filter((a) => a.kernel !== 'RUNNING' && a.kernel !== 'QUEUED') ?? []
  const chosen = free.find((a) => a.id === pick)
  const maxHours = chosen ? Math.max(1, Math.min(6, Math.floor(chosen.remainingHours - 0.25))) : 3

  return (
    <div className="mstatus startpanel" role="dialog" aria-label="Start the model server">
      <div className="mstatus-head">
        <div>
          <b>Start the model server</b>
          <small className="muted block">Runs on a free Kaggle GPU. Pick the account to use. Anyone using the site can start or stop it.</small>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">×</button>
      </div>

      {(
        <>
          {!data && !err && <p className="muted small">Checking each account’s GPU hours…</p>}

          {data?.running && (
            <p className="explain good">
              A server is already running on <b>{data.running}</b>. If the site cannot reach it yet, it is probably still booting.
              <button type="button" className="btn small" onClick={() => onAlreadyRunning(data.running!)}>Watch it start</button>
            </p>
          )}

          {data && free.length > 0 && (
            <ul className="acct-list">
              {free.map((a) => {
                const pctUsed = Math.min(100, Math.round(((a.usedHours + a.reservedHours) / a.totalHours) * 100))
                return (
                  <li key={a.id}>
                    <label className={`acct ${pick === a.id ? 'on' : ''}`}>
                      <input type="radio" name="acct" checked={pick === a.id} onChange={() => setPick(a.id)} />
                      <span className="acct-main">
                        <b>{a.label}</b>
                        <small>{a.remainingHours.toFixed(1)} of {a.totalHours.toFixed(0)} GPU hours left this week</small>
                        <span className="acct-bar" aria-hidden="true"><i style={{ width: `${pctUsed}%` }} /></span>
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}

          {data && free.length === 0 && !data.running && <p className="explain bad">No account has GPU time left right now.</p>}

          {data && data.hidden.length > 0 && (
            <p className="muted small hidden-note">
              Not shown: {data.hidden.map((h) => `${h.label} (${h.reason}${h.reason === 'out of GPU hours' ? `, back ${when(h.refreshTime)}` : ''})`).join('; ')}.
            </p>
          )}

          {data && free.length > 0 && (
            <div className="start-foot">
              <label className="hours">
                <span>Run for</span>
                <select value={Math.min(hours, maxHours)} onChange={(e) => setHours(Number(e.target.value))}>
                  {Array.from({ length: maxHours }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{h} hour{h === 1 ? '' : 's'}</option>)}
                </select>
              </label>
              <button type="button" className="btn primary" onClick={() => void start()} disabled={busy || !pick}>{busy ? 'Starting…' : 'Start server'}</button>
              <small className="muted">It also stops by itself after 7 minutes with no use. Booting takes about 12 minutes.</small>
            </div>
          )}
        </>
      )}

      {err && <p className="explain bad" role="alert">{err}</p>}
    </div>
  )
}
