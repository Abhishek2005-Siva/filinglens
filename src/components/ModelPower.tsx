import { useEffect, useRef, useState } from 'react'
import { ApiError, modelHealth } from '../api'
import { clearStarting, bootEstimate, getStartingAt, markOff, markReady, markStarting, readyUntil, recordBoot, setStartingEstimate } from '../modelState'
import { fmtSecs } from '../hooks'
import { hostCall, type BootProgress, type StartResult, type StopResult } from '../host'
import ModelStatusPanel, { DEMO, DEMO_MODELS, summarize } from './ModelStatusPanel'
import StartPanel from './StartPanel'
import StartProgress, { finished, type BootEvent, type BootState, type Tunnel } from './StartProgress'

type State = 'off' | 'starting' | 'on' | 'error' | 'missing'

const KAGGLE_LABEL: Record<string, string> = {
  QUEUED: 'waiting in Kaggle’s queue',
  RUNNING: 'the session is running',
  COMPLETE: 'the session ended',
  ERROR: 'the session crashed',
  NONE: 'no session found',
}

type Live = Omit<BootState, 'elapsed' | 'checkedAgo'> & { t0: number; checkedAt: number }

export default function ModelPower() {
  const [state, setState] = useState<State>(() => (DEMO ? 'on' : getStartingAt() !== null ? 'starting' : readyUntil() > Date.now() ? 'on' : 'off'))
  const [msg, setMsg] = useState('')
  const [panel, setPanel] = useState(DEMO)
  const [picker, setPicker] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [sum, setSum] = useState<ReturnType<typeof summarize> | null>(DEMO ? summarize(DEMO_MODELS) : null)
  const [boot, setBoot] = useState<BootState | null>(null)
  const [bootOpen, setBootOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const [queued, setQueued] = useState(false) // a turn-off is waiting for a running analysis to finish
  const [running, setRunning] = useState(0) // analyses running on the server
  const run = useRef(0) // bumped to cancel an older watch loop
  const live = useRef<Live>()

  // Keep the badge honest: it turns "off" when the server has probably shut itself down.
  useEffect(() => {
    const tick = () => {
      if (DEMO) return
      const left = readyUntil() - Date.now()
      setState((s) => {
        if (s === 'off' && left > 0) return 'on'
        // another page (a filing waking the server) finished without us tracking it
        if (s === 'starting' && !live.current && getStartingAt() === null) return left > 0 ? 'on' : 'off'
        return s
      })
    }
    const id = window.setInterval(tick, 2000)
    const onStarting = () => setState((s) => (s === 'on' ? s : 'starting'))
    window.addEventListener('model-ready', tick)
    window.addEventListener('model-starting', onStarting)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('model-ready', tick)
      window.removeEventListener('model-starting', onStarting)
    }
  }, [])

  // The server may be on without this tab having started it (a background analysis keeps it busy), or may have shut
  // itself down. Ask now and then; asking is only a status check and does not keep it awake.
  useEffect(() => {
    if (DEMO) return
    const verify = async () => {
      if (document.hidden || live.current) return
      try {
        const h = await modelHealth()
        if (h.ok) {
          if (h.models) setSum(summarize(h.models))
          setQueued(!!h.shutdownQueued)
          setRunning(h.batches ?? 0)
          markReady()
          setState((s) => (s === 'off' || s === 'error' ? 'on' : s))
        } else if (h.hostError || h.hostKind) {
          if (readyUntil() > 0) markOff()
          setState((s) => (s === 'on' ? 'off' : s))
        }
      } catch { /* leave the badge as it is */ }
    }
    void verify()
    const id = window.setInterval(() => void verify(), 60000)
    return () => window.clearInterval(id)
  }, [])

  // A start that is already under way (begun here earlier, in another tab, or by someone else) is followed, not restarted:
  // this only attaches to a server Kaggle already has queued or running. It never starts one.
  useEffect(() => {
    if (DEMO) return
    let gone = false
    hostCall<{ running: string | null }>('status')
      .then(async (d) => {
        if (gone || !d.running || live.current) return
        const h = await modelHealth().catch(() => null)
        if (gone || live.current || !h || h.ok) return // already reachable: the status check above handles that
        void watch(d.running, bootEstimate())
      })
      .catch(() => undefined)
    return () => { gone = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // While starting, refresh the tracker's clocks every second.
  useEffect(() => {
    if (state !== 'starting') return
    const id = window.setInterval(() => {
      const l = live.current
      if (!l) return
      const since = (Date.now() - l.checkedAt) / 1000
      setBoot({ ...l, runningFor: l.runningFor === null ? null : Math.round(l.runningFor + since), elapsed: Math.round((performance.now() - l.t0) / 1000), checkedAgo: Math.round(since) })
    }, 1000)
    return () => window.clearInterval(id)
  }, [state])

  useEffect(() => () => { run.current++ }, [])

  // The server is already awake (we saw it ready moments ago): fetch the status once so the sign can show counts.
  useEffect(() => {
    if (DEMO || state !== 'on' || sum) return
    modelHealth().then((h) => h.models && setSum(summarize(h.models))).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  const turnOff = async (force = false) => {
    const text = force
      ? 'Turn the server off right now?\n\nThe analysis that is running will pause. What is finished is kept, and you can press Resume on it later.'
      : running > 0
        ? `An analysis is running (${running}).\n\nThe server will turn off as soon as it has finished, so nothing is lost. Until then it stays on. Queue the turn-off?`
        : 'Turn the model server off?\n\nThis stops the Kaggle GPU session for everyone using the site and frees the GPU hours. Starting it again takes a few minutes.'
    if (!window.confirm(text)) return
    setStopping(true)
    try {
      run.current++
      const r = await hostCall<StopResult>('stop', force ? { force: true } : {})
      if (r.queued) {
        setQueued(true)
        return
      }
      markOff()
      setPanel(false)
      setMsg('')
      setBoot(null)
      setQueued(false)
      setRunning(0)
      live.current = undefined
      setState('off')
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Could not stop the server.')
    } finally {
      setStopping(false)
    }
  }

  const cancelOff = async () => {
    try {
      await hostCall('stop', { cancel: true })
      setQueued(false)
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Could not cancel the turn-off.')
    }
  }

  /** Follows a server that is booting on Kaggle until it is ready, or reports exactly what went wrong. */
  const watch = async (account: string, estimate: number) => {
    const me = ++run.current
    const alive = () => run.current === me
    setPicker(false)
    setMsg('')
    setStartingEstimate(estimate)
    markStarting()
    setState('starting')
    setBootOpen(true)
    const t0 = performance.now()
    const events: BootEvent[] = []
    const at = () => Math.round((performance.now() - t0) / 1000)
    const log = (text: string, tone?: BootEvent['tone']) => events.push({ at: at(), text, tone })
    let kaggle = ''
    let kaggleUrl = `https://www.kaggle.com/code/${account}/filinglens-server`
    let tunnel: Tunnel = 'unknown'
    let serverUp = false
    let models: BootState['models'] = null
    let failure = ''
    let lastReady = -1
    let runningAt: number | null = null // seconds into the wait when Kaggle gave us a GPU
    const publish = () => {
      const runningFor = runningAt === null ? null : at() - runningAt
      live.current = { account, estimate, kaggle, kaggleUrl, tunnel, serverUp, models, events: [...events], failure: failure || undefined, runningFor, t0, checkedAt: Date.now() }
      setBoot({ ...live.current, elapsed: at(), checkedAgo: 0 })
    }
    log(`Asked Kaggle to start the server on ${account}`)
    publish()

    // Waiting in Kaggle's queue has no fixed length, so there is no timeout while it is queued (only a very long cap).
    // The countdown and the "did not come up" check only start once Kaggle says the run is RUNNING.
    for (let i = 0; alive(); i++) {
      if (at() > 4 * 3600) {
        failure = 'Kaggle has not given a GPU in 4 hours. Stop this and try another account, or try again later.'
        log(failure, 'bad')
        break
      }
      if (runningAt !== null && !serverUp && at() - runningAt > 20 * 60) {
        failure = 'Kaggle started the run over 20 minutes ago but the server has not appeared. Open the Kaggle log to see where it is stuck.'
        log(failure, 'bad')
        break
      }
      const queuedNow = runningAt === null
      // 1) what does Kaggle say about the run? (every check while booting; every other check while queued)
      if (!queuedNow || i % 2 === 0) {
        try {
          const p = await hostCall<BootProgress>('progress', { account })
          kaggleUrl = p.kaggleUrl
          if (p.status !== kaggle) {
            log(`Kaggle: ${KAGGLE_LABEL[p.status] ?? p.status.toLowerCase()}`, p.status === 'ERROR' ? 'bad' : p.status === 'RUNNING' ? 'good' : undefined)
            kaggle = p.status
            if (p.status === 'RUNNING' && runningAt === null) runningAt = at()
          }
          if (finished(kaggle) && !serverUp) {
            failure = p.failureMessage || `Kaggle ended the run (${kaggle.toLowerCase()}) before the server came up.`
            log(failure, 'bad')
            break
          }
        } catch { /* a missed status check is not fatal */ }
      }
      // 2) how far has the server itself got?
      try {
        const h = await modelHealth()
        if (!alive()) return
        if (h.hostError) {
          if (h.hostKind === 'blocked') {
            failure = h.hostError
            log(failure, 'bad')
            break
          }
          // ngrok 3200 means the public address is not open yet; any other code means it is open but the server is not up
          const closed = !h.hostCode || h.hostCode === 'ERR_NGROK_3200'
          if (closed && tunnel !== 'closed') { tunnel = 'closed'; log('Installing software; the public address is not open yet') }
          if (!closed && tunnel !== 'open') { tunnel = 'open'; log('Public address is open; the server is starting', 'good') }
        } else {
          if (tunnel !== 'open') { tunnel = 'open'; log('Public address is open', 'good') }
          if (!serverUp) { serverUp = true; log('Server is up; loading the models', 'good') }
          models = h.models ?? models
          const ready = models ? models.filter((m) => m.state === 'ready').length : 0
          const bad = models ? models.filter((m) => m.state === 'error') : []
          if (ready !== lastReady) { lastReady = ready; log(`${ready} of ${models?.length ?? 11} models ready`) }
          bad.forEach((m) => { if (!events.some((e) => e.text.startsWith(m.title))) log(`${m.title} failed to load: ${m.error ?? 'unknown error'}`, 'bad') })
          const settled = !!models && models.every((m) => m.state === 'ready' || m.state === 'error')
          if (h.ok && settled) {
            recordBoot(runningAt === null ? at() : at() - runningAt)
            if (models) setSum(summarize(models))
            log(bad.length ? `Ready, but ${bad.length} model${bad.length === 1 ? '' : 's'} failed to load` : 'Ready: all models are on', bad.length ? 'warn' : 'good')
            publish()
            setStartingEstimate(null)
            markReady()
            setState('on')
            window.setTimeout(() => { if (run.current === me) setBootOpen(false) }, 4000)
            return
          }
        }
      } catch (e) {
        if (e instanceof ApiError && e.code === 'not_configured') {
          setState('missing')
          clearStarting()
          return
        }
      }
      publish()
      await new Promise((r) => setTimeout(r, runningAt === null ? 8000 : 3000)) // queued: no need to ask every few seconds
    }
    if (!alive()) return
    if (!failure) {
      failure = 'The server did not come up. Open the Kaggle log to see why.'
      log(failure, 'bad')
    }
    publish()
    clearStarting()
    setMsg(failure)
    setState('error')
  }

  /** Cancels a start that is still booting or waiting in Kaggle's queue, then lets the person pick another account. */
  const switchAccount = async () => {
    const account = live.current?.account
    setSwitching(true)
    run.current++ // stop following this start
    try {
      await hostCall('stop', { force: true, ...(account ? { account } : {}) })
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Could not stop that start. Try again.')
      setSwitching(false)
      if (account) void watch(account, bootEstimate()) // keep following it
      return
    }
    setSwitching(false)
    markOff()
    clearStarting()
    setBoot(null)
    live.current = undefined
    setBootOpen(false)
    setMsg('')
    setState('off')
    setPicker(true)
  }

  const retry = () => {
    run.current++
    setBoot(null)
    live.current = undefined
    setBootOpen(false)
    clearStarting()
    setMsg('')
    setState('off')
    setPicker(true)
  }

  const progressPanel = bootOpen && boot && <StartProgress b={boot} onRetry={retry} onClose={() => setBootOpen(false)} onSwitch={() => void switchAccount()} switching={switching} />

  if (state === 'on') {
    const bad = !!sum && sum.problems > 0
    const warming = !!sum && sum.loading > 0 && !bad
    return (
      <div className="power-wrap">
        <button type="button" className={`power on btn-like ${bad ? 'bad' : warming ? 'warm' : ''}`} onClick={() => setPanel((v) => !v)} aria-expanded={panel} aria-haspopup="dialog">
          <span className="power-dot" />
          {bad ? `${sum!.problems} model${sum!.problems === 1 ? '' : 's'} with a problem` : sum ? `AI models on · ${sum.ready}/${sum.total} ready` : 'AI models on'}
          <small>{panel ? 'hide' : 'details'} ▾</small>
        </button>
        {panel && <ModelStatusPanel onClose={() => setPanel(false)} onSummary={setSum} />}
        {progressPanel}
        {queued ? (
          <span className="power-queued" role="status">
            Turning off when the analysis finishes
            <button type="button" className="linklike" onClick={() => void cancelOff()}>cancel</button>
            <button type="button" className="linklike" onClick={() => void turnOff(true)}>turn off now</button>
          </span>
        ) : (
          <button type="button" className="power-off" onClick={() => void turnOff()} disabled={stopping || DEMO} title={running > 0 ? 'An analysis is running: the turn-off will wait for it to finish' : 'Stop the Kaggle GPU session'}>
            {stopping ? 'Stopping…' : running > 0 ? 'Turn off after analysis' : 'Turn off'}
          </button>
        )}
      </div>
    )
  }
  if (state === 'starting') {
    const e = boot?.elapsed ?? 0
    const est = boot?.estimate ?? bootEstimate()
    const inQueue = !!boot && boot.runningFor === null && !boot.serverUp
    return (
      <div className="power-wrap">
        <button type="button" className="power starting btn-like" onClick={() => boot && setBootOpen((v) => !v)} aria-expanded={bootOpen} aria-haspopup="dialog">
          <span className="power-dot" /> Starting{boot ? ` on ${boot.account}` : ' the model'}… {fmtSecs(e)}
          <small>{boot ? `${inQueue ? 'waiting in Kaggle’s queue' : (boot.runningFor ?? 0) < est ? `about ${fmtSecs(est - (boot.runningFor ?? 0))} left` : 'almost there…'} · ${bootOpen ? 'hide' : 'live progress'} ▾` : 'please wait'}</small>
        </button>
        {progressPanel}
      </div>
    )
  }
  if (state === 'missing') {
    return <div className="power error" role="status">Model not connected</div>
  }
  const failed = state === 'error'
  return (
    <div className="power-wrap">
      <button
        type="button"
        className={`power-btn ${failed ? 'error' : ''}`}
        onClick={() => (failed && boot ? setBootOpen((v) => !v) : setPicker((v) => !v))}
        aria-expanded={picker || bootOpen}
        aria-haspopup="dialog"
        title={msg || 'Choose a Kaggle account and start the model server'}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
          <path d="M12 3v9" />
          <path d="M6.4 6.6a8 8 0 1 0 11.2 0" />
        </svg>
        {failed ? 'Server did not start: see why' : 'Turn on AI model'}
      </button>
      {picker && <StartPanel onClose={() => setPicker(false)} onStarted={(r: StartResult) => void watch(r.account, bootEstimate())} onAlreadyRunning={(account) => void watch(account, bootEstimate())} />}
      {failed && !boot && msg && !picker && (
        <div className="mstatus" role="alert">
          <p className="explain bad"><b>The model server could not start.</b> {msg}</p>
        </div>
      )}
      {failed && progressPanel}
    </div>
  )
}
