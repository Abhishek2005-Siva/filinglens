import { useEffect, useRef, useState } from 'react'
import type { Row } from './columns'
import { todayCapsByCik, type Cap } from './marketcap'

const hasEvents = (r: Row) => Number(r['Events found']) > 0
const KEEP_MS = 6 * 3600_000 // a company's market cap read from Yahoo is reused for 6 hours (in this browser) instead of asking again
const MAX_TRIES = 3
const ROUND = 60 // companies per round: the rounds repeat until nobody is left, so the first rows of a long run fill in first

const cached = (cik: string): Cap | null => {
  try {
    const x = JSON.parse(localStorage.getItem(`fl-cap:${cik}`) || 'null') as { cap: number; note: string; t: number } | null
    return x && Date.now() - x.t < KEEP_MS ? { cap: x.cap, note: x.note } : null
  } catch { return null }
}
const keep = (cik: string, c: Cap) => {
  try { if (c.cap) localStorage.setItem(`fl-cap:${cik}`, JSON.stringify({ ...c, t: Date.now() })) } catch { /* storage unavailable: just ask again next time */ }
}

/** Today's market cap for every company that has a filing with events, read from Yahoo Finance by itself while the analysis runs: each time new rows arrive, the
 *  companies not read yet are picked up. Returns the answers by CIK, and how many companies are done / in total. */
export function useTodayCaps(rows: Row[]) {
  const [caps, setCaps] = useState<Record<string, Cap>>({})
  const latest = useRef(rows)
  latest.current = rows
  const done = useRef(new Set<string>())
  const tries = useRef(new Map<string, number>())
  const running = useRef(false)
  const gone = useRef(false)

  useEffect(() => {
    gone.current = false
    return () => { gone.current = true }
  }, [])

  useEffect(() => {
    if (running.current) return // the running loop looks at the newest rows each round
    running.current = true
    void (async () => {
      try {
        while (!gone.current) {
          const first = new Map<string, Row>()
          for (const r of latest.current) if (hasEvents(r) && r.CIK && r.Filed && !String(r.Status).startsWith('Error') && !done.current.has(String(r.CIK)) && !first.has(String(r.CIK))) first.set(String(r.CIK), r)
          if (!first.size) break
          const give = (m: Record<string, Cap>) => { for (const k of Object.keys(m)) done.current.add(k); setCaps((c) => ({ ...c, ...m })) }
          const batch = [...first.keys()].slice(0, ROUND)
          const fromCache: Record<string, Cap> = {}
          const ask: string[] = []
          for (const k of batch) {
            const c = cached(k)
            if (c) fromCache[k] = c
            else if ((tries.current.get(k) ?? 0) >= MAX_TRIES) fromCache[k] = { cap: null, note: 'Could not be read from Yahoo Finance' }
            else ask.push(k)
          }
          if (Object.keys(fromCache).length) give(fromCache)
          if (!ask.length) continue
          for (const k of ask) tries.current.set(k, (tries.current.get(k) ?? 0) + 1)
          const got = await todayCapsByCik(ask.map((k) => first.get(k)!), () => gone.current)
          for (const [k, c] of Object.entries(got)) keep(k, c)
          if (!gone.current) give(got)
          if (ask.some((k) => !(k in got)) && !gone.current) await new Promise((r) => window.setTimeout(r, 1500)) // Yahoo did not answer for some: a short pause, then they are asked again
        }
      } finally {
        running.current = false
      }
    })()
  }, [rows])

  const wanted = new Set(rows.filter(hasEvents).map((r) => String(r.CIK)))
  const read = [...wanted].filter((c) => c in caps).length
  return { caps, read, total: wanted.size }
}
