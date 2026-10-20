import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from '../api'
import { errorRow, rowFor, type Row } from '../batch/columns'
import { getBatch, getLive, getPart, isLive, isResumable, remember, resumeBatch, stopBatch, type BatchMeta, type PartEntry } from '../batchApi'
import ResultSheet from '../components/ResultSheet'
import { fmtSecs } from '../hooks'

const POLL_MS = 8000
const LIVE_MS = 4000

interface LogLine {
  t: number
  text: string
  tone: 'good' | 'bad' | 'warn' | ''
}

const ago = (ms: number) => fmtSecs(Math.max(0, Math.round(ms / 1000)))

/** The line the activity log gets for the state seen on this check, or null when nothing is worth saying. */
function describe(m: BatchMeta, prev: BatchMeta | null, lastLogAt: number): LogLine | null {
  const now = Date.now()
  const pct = m.total ? Math.round((m.done / m.total) * 100) : 0
  const count = `${m.done.toLocaleString()} of ${m.total.toLocaleString()} filings analyzed (${pct}%)`
  const errs = m.errors ? `, ${m.errors} could not be read` : ''
  if (!prev) {
    if (isLive(m.status)) {
      return m.status === 'collecting'
        ? { t: now, tone: 'warn', text: `You opened this while it is still running (started ${ago(now - m.createdAt)} ago). It is still collecting the list of filings${m.total ? `: ${m.total.toLocaleString()} found so far` : ''}.` }
        : { t: now, tone: 'warn', text: `You opened this while it is still running (started ${ago(now - m.createdAt)} ago): ${count}${errs}.` }
    }
    if (m.status === 'done') return { t: now, tone: 'good', text: `Finished: ${count}${errs}.` }
    if (m.status === 'stopped') return { t: now, tone: 'warn', text: `Stopped: ${count}${errs}. Press Resume to do the rest.` }
    if (m.status === 'interrupted') return { t: now, tone: 'bad', text: `Paused because the server stopped: ${count}${errs}. Turn the AI model on, then press Resume.` }
    return { t: now, tone: 'bad', text: `Stopped by a problem: ${count}${errs}. ${m.message ?? ''}`.trim() }
  }
  if (prev.status !== m.status) {
    if (m.status === 'done') return { t: now, tone: 'good', text: `Finished: ${count}${errs}.` }
    if (m.status === 'stopped') return { t: now, tone: 'warn', text: `Stopped: ${count}${errs}.` }
    if (m.status === 'interrupted') return { t: now, tone: 'bad', text: `Paused because the server stopped: ${count}${errs}.` }
    if (m.status === 'error') return { t: now, tone: 'bad', text: `Problem: ${m.message ?? 'something went wrong'}` }
    if (m.status === 'running') return { t: now, tone: 'warn', text: `Analyzing now: ${count}.` }
  }
  if (isLive(m.status) && m.status === 'running' && (m.done !== prev.done || now - lastLogAt > 30000)) {
    return { t: now, tone: '', text: `Still running: ${count}${errs}${m.live ? '' : ` (last news from the server ${ago(now - m.updatedAt)} ago)`}.` }
  }
  return null
}

const STATUS: Record<BatchMeta['status'], { label: string; tone: string }> = {
  queued: { label: 'Starting', tone: 'warn' },
  collecting: { label: 'Collecting filings', tone: 'warn' },
  running: { label: 'Running', tone: 'warn' },
  done: { label: 'Finished', tone: 'good' },
  stopped: { label: 'Stopped', tone: 'warn' },
  interrupted: { label: 'Paused: server stopped', tone: 'bad' },
  error: { label: 'Problem', tone: 'bad' },
}

export default function Analysis({ id }: { id: string }) {
  const [meta, setMeta] = useState<BatchMeta | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [copied, setCopied] = useState(false)
  const [tick, setTick] = useState(0)
  const entries = useRef(new Map<string, PartEntry>())
  const tail = useRef(new Map<string, PartEntry>()) // finished filings the server has not stored yet
  const have = useRef(0) // stored parts already downloaded
  const samples = useRef<{ t: number; done: number }[]>([])
  const [version, setVersion] = useState(0)
  const [log, setLog] = useState<LogLine[]>([])
  const prevMeta = useRef<BatchMeta | null>(null)
  const lastLogAt = useRef(0)
  const [kick, setKick] = useState(0) // restarts the polling loop after Resume

  const poll = useCallback(async () => {
    try {
      const prev = prevMeta.current
      let m: BatchMeta
      let fresh: PartEntry[] = []
      if (prev && isLive(prev.status)) {
        // running: ask the model server directly, which also hands over the filings that are not stored yet
        const r = await getLive(id)
        if ('tail' in r) {
          const { tail, ...rest } = r
          m = { ...prev, ...rest }
          fresh = tail
          // it just finished: read the stored copy so the very last parts are included
          if (!isLive(m.status)) {
            m = await getBatch(id)
            fresh = []
          }
        } else {
          m = r
        }
      } else {
        m = await getBatch(id)
      }
      setErr('')
      setMeta(m)
      const line = describe(m, prev, lastLogAt.current)
      prevMeta.current = m
      if (line) {
        lastLogAt.current = line.t
        setLog((l) => [line, ...l].slice(0, 14))
      }
      remember({ id, title: m.title, createdAt: m.createdAt })
      const s = samples.current
      if (isLive(m.status)) {
        if (!s.length || s[s.length - 1].done !== m.done) s.push({ t: Date.now(), done: m.done })
        if (s.length > 12) s.shift()
      } else {
        s.length = 0
      }
      let changed = false
      while (have.current < m.parts) {
        try {
          for (const e of await getPart(id, have.current)) entries.current.set(e.filing.accession, e) // a later part replaces an earlier one (retries)
        } catch {
          break // not stored yet; the next check picks it up
        }
        have.current++
        changed = true
      }
      if (changed || fresh.length !== tail.current.size) {
        tail.current = new Map(fresh.map((e) => [e.filing.accession, e]))
        changed = true
      }
      if (changed) setVersion((v) => v + 1)
      return m
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not reach the website. Retrying…')
      return null
    }
  }, [id])

  useEffect(() => {
    entries.current = new Map()
    tail.current = new Map()
    have.current = 0
    samples.current = []
    prevMeta.current = null
    lastLogAt.current = 0
    setMeta(null)
    setLog([])
    setVersion(0)
  }, [id])

  useEffect(() => {
    let stop = false
    let timer = 0
    const loop = async () => {
      const m = await poll()
      if (stop) return
      if (m && !isLive(m.status)) return // nothing more will change until Resume is pressed
      timer = window.setTimeout(() => void loop(), document.hidden ? POLL_MS * 4 : prevMeta.current?.live ? LIVE_MS : POLL_MS)
    }
    void loop()
    const onVis = () => {
      if (!document.hidden) {
        window.clearTimeout(timer)
        void loop()
      }
    }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      stop = true
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [id, poll, kick])

  useEffect(() => {
    if (!meta || !isLive(meta.status)) return
    const t = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [meta])

  const rows: Row[] = useMemo(() => {
    void version
    return [...new Map([...entries.current, ...tail.current]).values()].map((e) => (e.result ? rowFor(e.filing, e.result) : errorRow(e.filing, e.error ?? 'failed')))
  }, [version])

  const act = async (what: 'stop' | 'resume') => {
    if (what === 'stop' && !window.confirm('Stop this analysis?\n\nWhat is finished so far stays here, and you can press Resume later to do the rest.')) return
    setBusy(what)
    setErr('')
    try {
      await (what === 'stop' ? stopBatch(id) : resumeBatch(id))
      setKick((k) => k + 1)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'That did not work.')
    } finally {
      setBusy('')
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt('Copy this link:', window.location.href)
    }
  }

  void tick
  if (!meta) {
    return (
      <section className="page">
        <h1>Analysis</h1>
        {err ? <p className="explain bad" role="alert">{err}</p> : <p className="muted">Loading this analysis…</p>}
        <p><a className="btn" href="#/analyses">All my analyses</a></p>
      </section>
    )
  }

  const live = isLive(meta.status)
  const st = STATUS[meta.status]
  const pct = meta.total ? Math.min(100, Math.round((meta.done / meta.total) * 100)) : 0
  const s = samples.current
  const rate = s.length >= 2 && s[s.length - 1].t - s[0].t > 15000 && s[s.length - 1].done > s[0].done ? (s[s.length - 1].done - s[0].done) / ((s[s.length - 1].t - s[0].t) / 1000) : 0
  const eta = rate && meta.total > meta.done ? (meta.total - meta.done) / rate : null
  const age = Math.max(0, Math.round((Date.now() - meta.updatedAt) / 1000))
  const fileBase = `filinglens_analysis_${id.slice(0, 6)}_${rows.length}filings`
  const withEvents = rows.filter((r) => Number(r['Events found']) > 0).length
  const about: [string, string][] = [
    ['Created by', 'FilingLens (SEC 8-K event detector)'],
    ['Analysis', meta.title],
    ['Started', new Date(meta.createdAt).toLocaleString()],
    ['Filings analyzed', String(rows.length)],
    ['Filings with at least one event', String(withEvents)],
    ['Status', `${st.label}${meta.total ? ` (${meta.done} of ${meta.total})` : ''}`],
    ['How to read this', 'Each row is one SEC filing. Event columns show what the AI found, the person or detail, and in [brackets] how sure it is. Blank means nothing found for that event type.'],
    ['Caveats', 'AI output with imperfect accuracy; check the evidence sentence and the SEC link. Experimental detectors (CFO, acquisitions, agreements, equity sales, guidance, restructuring) have thinner testing.'],
  ]

  return (
    <section className="page analysis">
      <p className="crumbs"><a href="#/search">← Search filings</a> · <a href="#/analyses">All my analyses</a></p>
      <div className="analysis-head">
        <div>
          <h1>{meta.title}</h1>
          <p className="muted small">Started {new Date(meta.createdAt).toLocaleString()}</p>
        </div>
        <span className={`pill-status ${st.tone}`}>{st.label}</span>
      </div>

      <div className="card analysis-card">
        {meta.status === 'collecting' ? (
          <p>Collecting every filing that matches the search… {meta.total ? `${meta.total.toLocaleString()} found so far` : ''}</p>
        ) : (
          <>
            <div className="meter big" aria-hidden="true"><i style={{ width: `${Math.max(meta.status === 'done' ? 100 : 2, pct)}%` }} /></div>
            <p>
              <b>{meta.done.toLocaleString()}</b> of <b>{meta.total.toLocaleString()}</b> filings analyzed ({pct}%)
              {meta.errors ? <> · <b className="bad-text">{meta.errors}</b> could not be read</> : null}
              {live && eta != null ? <> · about {fmtSecs(eta)} left</> : null}
              {live && eta == null ? <> · working out the time left…</> : null}
            </p>
          </>
        )}

        {live && (
          <p className="explain good">
            <b>You can close this page.</b> It keeps running. Come back to this link any time: <button type="button" className="linklike" onClick={() => void copy()}>{copied ? 'copied ✓' : 'copy link'}</button>
            {meta.live ? <span className="muted"> · live, updated {age <= 2 ? 'just now' : `${age}s ago`}</span> : <span className="muted"> · last news from the server {fmtSecs(age)} ago</span>}
          </p>
        )}
        {meta.status === 'interrupted' && <p className="explain bad" role="alert">The server stopped. What finished is kept below. Turn the AI on, then press Resume.</p>}
        {meta.status === 'stopped' && <p className="explain warn">Stopped. {meta.done.toLocaleString()} done. Press Resume for the rest.</p>}
        {meta.status === 'error' && <p className="explain bad" role="alert">{meta.message || 'Something went wrong.'}</p>}
        {meta.status === 'done' && <p className="explain good">Finished{meta.errors ? `, but ${meta.errors} filing${meta.errors === 1 ? '' : 's'} could not be read (marked “Error” in the sheet)` : ''}. Download the sheet below.</p>}
        {err && <p className="explain bad" role="alert">{err}</p>}

        {log.length > 0 && (
          <div className="alog" aria-live="polite">
            <h4>Activity log</h4>
            <ul>
              {log.map((l, i) => (
                <li key={`${l.t}-${i}`} className={l.tone}><time>{new Date(l.t).toLocaleTimeString()}</time> {l.text}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="boot-actions">
          {live && <button type="button" className="btn" onClick={() => void act('stop')} disabled={!!busy}>{busy === 'stop' ? 'Stopping…' : 'Stop analysis'}</button>}
          {isResumable(meta.status) && (meta.done < meta.total || meta.total === 0 || meta.status === 'error') && <button type="button" className="btn primary" onClick={() => void act('resume')} disabled={!!busy}>{busy === 'resume' ? 'Resuming…' : 'Resume'}</button>}
          {!live && <button type="button" className="btn" onClick={() => void copy()}>{copied ? 'Link copied ✓' : 'Copy link'}</button>}
        </div>
      </div>

      {live && <p className="explain good">{rows.length.toLocaleString()} {rows.length === 1 ? 'row' : 'rows'} so far. You can download it now.</p>}
      {rows.length > 0 ? <ResultSheet rows={rows} fileBase={fileBase} about={about} /> : live && <p className="muted">Waiting for the first filings to finish…</p>}
    </section>
  )
}
