import { useEffect, useState } from 'react'

interface Visitor { id: string; firstSeen: string; lastSeen: string; lat: number; lon: number; accuracy: number | null; ipCity: string; ipRegion: string; ipCountry: string; device: string; online: boolean }

const ago = (iso: string, now: number) => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`
}

export default function Users() {
  const [rows, setRows] = useState<Visitor[] | null>(null)
  const [me, setMe] = useState('')
  const [now, setNow] = useState(Date.now())
  const [err, setErr] = useState('')
  useEffect(() => {
    let gone = false
    const load = async () => {
      try {
        const r = await fetch('/api/presence')
        const b = await r.json()
        if (gone) return
        if (!r.ok) throw new Error(b.message ?? 'Could not load.')
        setRows(b.visitors); setMe(b.me); setNow(Date.parse(b.now)); setErr('')
      } catch (e) { if (!gone) setErr(e instanceof Error ? e.message : 'Could not load.') }
    }
    void load()
    const id = window.setInterval(() => { if (!document.hidden) void load() }, 20_000)
    return () => { gone = true; window.clearInterval(id) }
  }, [])
  const online = (rows ?? []).filter((v) => v.online)
  const earlier = (rows ?? []).filter((v) => !v.online)
  const table = (list: Visitor[]) => (
    <div className="table-wrap">
      <table className="grid">
        <thead><tr><th>Where (from the network)</th><th>Place the browser shared</th><th>Device</th><th>Last seen</th><th>First seen</th></tr></thead>
        <tbody>
          {list.map((v) => (
            <tr key={v.id}>
              <td>{[v.ipCity, v.ipRegion, v.ipCountry].filter(Boolean).join(', ') || '—'}{v.id === me && <span className="pill"> you</span>}</td>
              <td><a href={`https://www.openstreetmap.org/?mlat=${v.lat}&mlon=${v.lon}#map=14/${v.lat}/${v.lon}`} target="_blank" rel="noreferrer">{v.lat.toFixed(4)}, {v.lon.toFixed(4)}</a>{v.accuracy != null && <span className="muted small"> (±{v.accuracy} m)</span>}</td>
              <td>{v.device}</td>
              <td>{v.online ? <b>online now</b> : ago(v.lastSeen, now)}</td>
              <td className="muted small">{ago(v.firstSeen, now)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
  return (
    <>
      <section className="hero compact">
        <span className="eyebrow">Visitors</span>
        <h1>Who is using the site</h1>
        <p className="lead">Everyone who signed in and allowed their location. "Online now" means seen in the last 2½ minutes.</p>
      </section>
      {err && <p className="explain bad">{err}</p>}
      {rows === null && !err && <p className="muted">Loading…</p>}
      {rows && (
        <>
          <h2>Online now ({online.length})</h2>
          {online.length ? table(online) : <p className="muted">Nobody right now.</p>}
          {earlier.length > 0 && (<><h2>Earlier ({earlier.length})</h2>{table(earlier)}</>)}
        </>
      )}
    </>
  )
}
