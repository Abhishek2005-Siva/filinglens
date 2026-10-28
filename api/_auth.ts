import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { VercelRequest, VercelResponse } from '@vercel/node'

// One shared password for the whole site, and a location check on top. This repository is public, so nothing secret is kept in
// the code: the salted password hash comes from the SITE_PASSWORD_HASH environment variable, and the cookies are signed with a
// key taken from AUTH_SECRET (or, if that is not set, from the MODEL_API_KEY the site already has). Without them the site stays locked.
// A visitor who knows the password gets the `fl_auth` cookie; one who also lets the browser share its location gets `fl_loc`.
// Both cookies carry the same random session id and a signature, so neither can be copied to another session or made up.
// Scripts (not browsers) can send the password in the `x-fl-pass` header instead.
const SALT = 'filinglens-login-v1'
const MAX_AGE = 30 * 24 * 3600
const passwordHash = () => process.env.SITE_PASSWORD_HASH || ''
// A quicker check for hosts that allow only a few milliseconds of processor time per request (Cloudflare's free plan): HMAC-SHA256 of the password
// with a fixed key, kept in SITE_PASSWORD_HMAC (made by cf/make-secret.mjs). It lives in the environment, never in the code.
const passwordHmac = () => process.env.SITE_PASSWORD_HMAC || ''
const secret = () => (process.env.AUTH_SECRET || process.env.MODEL_API_KEY || '')

/** False until the site owner has set SITE_PASSWORD_HASH and a signing key in the environment. */
export const authConfigured = () => (!!passwordHash() || !!passwordHmac()) && !!secret()

export const checkPassword = (p: string): boolean => {
  if (!authConfigured()) return false
  try {
    if (passwordHmac()) return timingSafeEqual(createHmac('sha256', SALT).update(String(p)).digest(), Buffer.from(passwordHmac(), 'hex'))
    return timingSafeEqual(scryptSync(String(p), SALT, 32), Buffer.from(passwordHash(), 'hex'))
  } catch {
    return false
  }
}

const sign = (id: string, kind: 'auth' | 'loc') => createHmac('sha256', secret()).update(`${kind}:${id}`).digest('hex').slice(0, 40)

const cookies = (req: VercelRequest): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

const valid = (value: string | undefined, kind: 'auth' | 'loc'): string | null => {
  const [id, sig] = String(value || '').split('.')
  if (!id || !sig || !/^[0-9a-f]{16}$/.test(id)) return null
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(sign(id, kind))) ? id : null
  } catch {
    return null
  }
}

export const newSessionId = () => randomBytes(8).toString('hex')

const cookie = (name: string, value: string, maxAge: number) => `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`

export const setAuthCookie = (res: VercelResponse, id: string) => res.setHeader('Set-Cookie', [cookie('fl_auth', `${id}.${sign(id, 'auth')}`, MAX_AGE)])
export const setLocCookie = (res: VercelResponse, id: string) => {
  const prev = res.getHeader('Set-Cookie')
  const list = Array.isArray(prev) ? prev.map(String) : prev ? [String(prev)] : []
  res.setHeader('Set-Cookie', [...list, cookie('fl_loc', `${id}.${sign(id, 'loc')}`, MAX_AGE)])
}
export const clearCookies = (res: VercelResponse) => res.setHeader('Set-Cookie', [cookie('fl_auth', '', 0), cookie('fl_loc', '', 0)])

export interface Session {
  id: string | null
  auth: boolean
  located: boolean
}

/** The model server saves the results of a long analysis back to the site with the shared API key; that is a program, not a visitor, so no cookies. */
const isModelServer = (req: VercelRequest): boolean => {
  const key = process.env.MODEL_API_KEY || ''
  const got = String(req.headers.authorization || '')
  if (!key || !got.startsWith('Bearer ')) return false
  try {
    return timingSafeEqual(Buffer.from(got.slice(7)), Buffer.from(key))
  } catch {
    return false
  }
}

export function sessionOf(req: VercelRequest): Session {
  if (isModelServer(req)) return { id: null, auth: true, located: true }
  if (!authConfigured()) return { id: null, auth: false, located: false }
  if (req.headers['x-fl-pass'] && checkPassword(String(req.headers['x-fl-pass']))) return { id: null, auth: true, located: true }
  const c = cookies(req)
  const id = valid(c.fl_auth, 'auth')
  return { id, auth: !!id, located: !!id && valid(c.fl_loc, 'loc') === id }
}

/** True when the visitor may use the API; otherwise answers 401 (no password) or 403 (no location) and returns false. */
export function requireAccess(req: VercelRequest, res: VercelResponse, opts: { location?: boolean } = {}): boolean {
  const s = sessionOf(req)
  res.setHeader('Cache-Control', 'no-store') // never let the CDN keep an answer that is behind the sign-in
  if (!s.auth) {
    res.status(401).json({ error: 'auth_required', message: 'Please sign in.' })
    return false
  }
  if ((opts.location ?? true) && !s.located) {
    res.status(403).json({ error: 'location_required', message: 'Please allow your location to use the site.' })
    return false
  }
  return true
}

// wrong-password limiter (best effort: lives in the function instance)
const fails = new Map<string, number[]>()
export const tooManyFails = (ip: string): boolean => {
  const now = Date.now()
  const recent = (fails.get(ip) ?? []).filter((t) => now - t < 10 * 60 * 1000)
  fails.set(ip, recent)
  return recent.length >= 8
}
export const noteFail = (ip: string) => fails.set(ip, [...(fails.get(ip) ?? []), Date.now()])
export const ipOf = (req: VercelRequest) => String(req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim()
