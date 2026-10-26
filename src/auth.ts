// Sign-in (one shared password) and location sharing. The server keeps two signed cookies; this file only talks to it.
export interface SessionInfo { auth: boolean; located: boolean }

export async function readSession(): Promise<SessionInfo> {
  try {
    const r = await fetch('/api/login')
    return r.ok ? await r.json() : { auth: false, located: false }
  } catch {
    return { auth: false, located: false }
  }
}

export async function signIn(password: string): Promise<{ ok: boolean; message?: string }> {
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) })
  const b = await r.json().catch(() => ({}))
  return r.ok ? { ok: true } : { ok: false, message: b.message ?? 'Could not sign in.' }
}

export async function signOut() {
  await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ logout: true }) }).catch(() => undefined)
  lastPos = null
  window.dispatchEvent(new Event('fl-auth-lost'))
}

export interface Pos { lat: number; lon: number; accuracy: number }
let lastPos: Pos | null = null

export function askLocation(): Promise<Pos> {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(Object.assign(new Error('This browser cannot share a location.'), { code: 0 }))
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(Object.assign(new Error(e.message), { code: e.code })),
      { enableHighAccuracy: false, timeout: 25_000, maximumAge: 10 * 60_000 },
    )
  })
}

/** Tells the server where this visitor is (this also unlocks the site for them) and keeps "online now" fresh. */
export async function reportLocation(p: Pos): Promise<boolean> {
  const r = await fetch('/api/presence', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) })
  if (r.ok) lastPos = p
  return r.ok
}

export const heartbeat = () => (lastPos ? reportLocation(lastPos) : Promise.resolve(false))

// If the server says the sign-in or the location is no longer valid, every page goes back to the gate.
export function watchAuthLoss() {
  const orig = window.fetch.bind(window)
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const r = await orig(...args)
    if (r.status === 401 || r.status === 403) {
      const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof Request ? args[0].url : String(args[0])
      if (url.includes('/api/') && !url.includes('/api/login')) {
        const b = await r.clone().json().catch(() => ({}))
        if (b.error === 'auth_required' || b.error === 'location_required') window.dispatchEvent(new Event('fl-auth-lost'))
      }
    }
    return r
  }
}
