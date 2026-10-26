import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { askLocation, heartbeat, readSession, reportLocation, signIn, watchAuthLoss } from '../auth'

type Stage = 'checking' | 'login' | 'location' | 'ok'
let patched = false

const whyBlocked = (code: number) =>
  code === 1 ? 'Location is blocked for this site. Click the lock icon next to the address, set Location to Allow, then press Try again.'
    : code === 2 ? 'Your device could not work out where you are. Check that location services are on, then press Try again.'
      : code === 3 ? 'Finding your location took too long. Press Try again.'
        : 'This browser cannot share a location, so the site cannot be used here.'

export default function Gate({ children }: { children: ReactNode }) {
  const [stage, setStage] = useState<Stage>('checking')
  const [pw, setPw] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const check = useCallback(async () => {
    const s = await readSession()
    setStage(!s.auth ? 'login' : !s.located ? 'location' : 'ok')
  }, [])

  useEffect(() => {
    if (!patched) { patched = true; watchAuthLoss() }
    void check()
    const lost = () => { void check() }
    window.addEventListener('fl-auth-lost', lost)
    return () => window.removeEventListener('fl-auth-lost', lost)
  }, [check])

  const share = useCallback(async () => {
    setBusy(true)
    setMsg('')
    try {
      const p = await askLocation()
      if (await reportLocation(p)) setStage('ok')
      else { setMsg('The site could not save your location. Try again.'); void check() }
    } catch (e) {
      setMsg(whyBlocked((e as { code?: number }).code ?? 0))
    } finally {
      setBusy(false)
    }
  }, [check])

  // A visitor who already allowed location in this browser is let straight through.
  useEffect(() => {
    if (stage !== 'location') return
    navigator.permissions?.query({ name: 'geolocation' as PermissionName }).then((r) => { if (r.state === 'granted') void share() }).catch(() => undefined)
  }, [stage, share])

  // While the site is open, say so now and then (this is what "online now" is made of).
  useEffect(() => {
    if (stage !== 'ok') return
    const id = window.setInterval(() => { void heartbeat() }, 60_000)
    void heartbeat()
    return () => window.clearInterval(id)
  }, [stage])

  if (stage === 'ok') return <>{children}</>
  if (stage === 'checking') return <div className="gate"><div className="gate-card"><p className="muted">Loading…</p></div></div>

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setMsg('')
    const r = await signIn(pw)
    setBusy(false)
    if (r.ok) { setPw(''); void check() } else setMsg(r.message ?? 'Could not sign in.')
  }

  return (
    <div className="gate">
      <div className="gate-card">
        <div className="gate-mark" aria-hidden="true">{stage === 'login' ? '🔒' : '📍'}</div>
        <h1>FilingLens</h1>
        {stage === 'login' ? (
          <form onSubmit={submit}>
            <p className="muted">Enter the password to continue.</p>
            <label className="sr-only" htmlFor="pw">Password</label>
            <input id="pw" type="password" autoFocus autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" />
            <button className="btn primary" type="submit" disabled={busy || !pw}>{busy ? 'Checking…' : 'Sign in'}</button>
            {msg && <p className="gate-msg" role="alert">{msg}</p>}
          </form>
        ) : (
          <div>
            <p>To use the site, allow it to see your location.</p>
            <p className="muted small">Your browser will ask. The place you are using the site from is shown to the person who runs it (a map point and your approximate city). Nothing else is collected. If you do not allow it, the site stays locked.</p>
            <button className="btn primary" type="button" onClick={() => void share()} disabled={busy}>{busy ? 'Waiting for your browser…' : msg ? 'Try again' : 'Allow location'}</button>
            {msg && <p className="gate-msg" role="alert">{msg}</p>}
          </div>
        )}
      </div>
    </div>
  )
}
