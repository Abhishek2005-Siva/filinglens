import { get, list, put } from '@vercel/blob'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { requireAccess, sessionOf, setLocCookie } from './_auth.js'

// Who is using the site, and where (only people who let the browser share their location get in).
//   POST {lat, lon, accuracy}  -> records this visitor's place and unlocks the site for them (sets the location cookie)
//   POST {lat, lon, accuracy, ping:true} -> keeps "online now" fresh
//   GET                        -> the list of visitors, newest first
const header = (req: VercelRequest, name: string) => String(req.headers[name] || '')
const decode = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }
const device = (ua: string) => {
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Other'
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
  return `${br} on ${os}`
}

interface Visitor {
  id: string
  firstSeen: string
  lastSeen: string
  lat: number
  lon: number
  accuracy: number | null
  ipCity: string
  ipRegion: string
  ipCountry: string
  device: string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  const s = sessionOf(req)
  if (req.method === 'POST') {
    if (!s.auth || !s.id) return res.status(401).json({ error: 'auth_required', message: 'Please sign in.' })
    const b = (req.body ?? {}) as { lat?: number; lon?: number; accuracy?: number }
    const lat = Number(b.lat), lon = Number(b.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return res.status(400).json({ error: 'bad_location', message: 'That location is not valid.' })
    const path = `presence/${s.id}.json`
    let first = new Date().toISOString()
    try {
      const prev = await get(path, { access: 'private', useCache: false })
      if (prev && prev.statusCode === 200) first = (JSON.parse(await new Response(prev.stream).text()) as Visitor).firstSeen || first
    } catch { /* first visit */ }
    const v: Visitor = {
      id: s.id, firstSeen: first, lastSeen: new Date().toISOString(), lat, lon,
      accuracy: Number.isFinite(Number(b.accuracy)) ? Math.round(Number(b.accuracy)) : null,
      ipCity: decode(header(req, 'x-vercel-ip-city')), ipRegion: header(req, 'x-vercel-ip-country-region'), ipCountry: header(req, 'x-vercel-ip-country'),
      device: device(header(req, 'user-agent')),
    }
    await put(path, JSON.stringify(v), { access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 0 })
    setLocCookie(res, s.id)
    return res.status(200).json({ ok: true })
  }
  if (req.method !== 'GET') return res.status(405).json({ error: 'method' })
  if (!requireAccess(req, res)) return
  const items = await list({ prefix: 'presence/', limit: 200 })
  const people = (await Promise.all(items.blobs.map(async (b) => {
    try {
      const r = await get(b.pathname, { access: 'private', useCache: false })
      return r && r.statusCode === 200 ? (JSON.parse(await new Response(r.stream).text()) as Visitor) : null
    } catch {
      return null
    }
  }))).filter((x): x is Visitor => !!x)
  const now = Date.now()
  people.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))
  return res.status(200).json({ now: new Date(now).toISOString(), me: s.id, visitors: people.map((p) => ({ ...p, online: now - Date.parse(p.lastSeen) < 150_000 })) })
}
