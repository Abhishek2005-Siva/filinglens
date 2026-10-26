import type { VercelRequest, VercelResponse } from '@vercel/node'
import { authConfigured, checkPassword, clearCookies, ipOf, newSessionId, noteFail, sessionOf, setAuthCookie, tooManyFails } from './_auth.js'

// POST {password} -> signs in (sets the cookie).  POST {logout:true} -> signs out.  GET -> who am I.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method === 'GET') {
    const s = sessionOf(req)
    return res.status(200).json({ auth: s.auth, located: s.located })
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' })
  const body = (req.body ?? {}) as { password?: string; logout?: boolean }
  if (body.logout) {
    clearCookies(res)
    return res.status(200).json({ ok: true })
  }
  if (!authConfigured()) return res.status(503).json({ error: 'not_configured', message: 'Sign-in is not set up yet. The site owner needs to add SITE_PASSWORD_HASH to the site settings.' })
  const ip = ipOf(req)
  if (tooManyFails(ip)) return res.status(429).json({ error: 'slow_down', message: 'Too many wrong passwords. Wait a few minutes and try again.' })
  if (!checkPassword(String(body.password ?? ''))) {
    noteFail(ip)
    return res.status(401).json({ error: 'wrong_password', message: 'That password is not right.' })
  }
  setAuthCookie(res, sessionOf(req).id ?? newSessionId())
  return res.status(200).json({ ok: true })
}
