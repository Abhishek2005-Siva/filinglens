import { get, put } from '@vercel/blob'

// Where the model server is reachable. Each time the server starts it opens a free Cloudflare tunnel (a new address every time) and
// registers that address here (POST /api/host {action:'register'}); the MODEL_URL setting (the old fixed ngrok address) is the fallback.
const ENV_URL = (process.env.MODEL_URL || '').replace(/\/$/, '')
const PATH = 'model/url.json'
let cache = { url: '', t: 0 }

export async function modelUrl(): Promise<string> {
  if (cache.t && Date.now() - cache.t < 8000) return cache.url
  let url = ''
  try {
    const r = await get(PATH, { access: 'private', useCache: false })
    if (r && r.statusCode === 200) url = String((JSON.parse(await new Response(r.stream).text()) as { url?: string }).url || '')
  } catch { /* nothing registered yet */ }
  cache = { url: (url || ENV_URL).replace(/\/$/, ''), t: Date.now() }
  return cache.url
}

export async function setModelUrl(url: string): Promise<void> {
  await put(PATH, JSON.stringify({ url, t: Date.now() }), { access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json', cacheControlMaxAge: 60 })
  cache = { url, t: Date.now() }
}

/** True when the tunnel is there but no model server answers behind it (ngrok error header, or Cloudflare's 5xx for a closed tunnel). */
export const tunnelDown = (r: Response): boolean =>
  !!r.headers.get('ngrok-error-code') || ((r.headers.get('server') || '').toLowerCase() === 'cloudflare' && [502, 503, 504, 530].includes(r.status))
