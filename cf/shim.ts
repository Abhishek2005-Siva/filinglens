// Lets the site's functions, written for Vercel (req.query, req.body, res.status().json() ...), run inside a Cloudflare Worker unchanged.
type Hdrs = Record<string, string>

export interface FakeReq {
  method: string
  url: string
  query: Record<string, string | string[]>
  headers: Hdrs
  body: unknown
  socket: { remoteAddress?: string }
}

export async function toReq(request: Request): Promise<FakeReq> {
  const url = new URL(request.url)
  const query: Record<string, string | string[]> = {}
  for (const [k, v] of url.searchParams) query[k] = k in query ? ([] as string[]).concat(query[k], v) : v
  const headers: Hdrs = {}
  request.headers.forEach((v, k) => { headers[k.toLowerCase()] = v })
  const ip = headers['cf-connecting-ip']
  if (ip && !headers['x-forwarded-for']) headers['x-forwarded-for'] = ip
  const cf = (request as unknown as { cf?: { city?: string; region?: string; country?: string } }).cf
  if (cf) {
    if (cf.city) headers['x-vercel-ip-city'] = encodeURIComponent(cf.city)
    if (cf.region) headers['x-vercel-ip-country-region'] = cf.region
    if (cf.country) headers['x-vercel-ip-country'] = cf.country
  }
  let body: unknown = undefined
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const text = await request.text()
    if (text) {
      try { body = (headers['content-type'] || '').includes('json') ? JSON.parse(text) : text } catch { body = undefined }
    }
  }
  return { method: request.method, url: url.pathname + url.search, query, headers, body, socket: { remoteAddress: ip } }
}

export class FakeRes {
  statusCode = 200
  headersSent = false
  writableEnded = false
  private raw = new Map<string, string | string[]>()
  private payload: string | null = null
  private finish!: (r: Response) => void
  readonly done = new Promise<Response>((ok) => { this.finish = ok })

  status(n: number) { this.statusCode = n; return this }
  setHeader(name: string, value: string | number | string[]) { this.raw.set(name.toLowerCase(), Array.isArray(value) ? value.map(String) : String(value)); return this }
  getHeader(name: string) { return this.raw.get(name.toLowerCase()) }
  json(o: unknown) { this.setHeader('Content-Type', 'application/json; charset=utf-8'); return this.send(JSON.stringify(o)) }
  send(b?: string) { this.payload = b ?? ''; return this.end() }
  end(b?: string) {
    if (this.writableEnded) return this
    if (b !== undefined) this.payload = b
    this.writableEnded = this.headersSent = true
    const h = new Headers()
    for (const [k, v] of this.raw) for (const one of Array.isArray(v) ? v : [v]) h.append(k, one)
    const empty = this.statusCode === 204 || this.statusCode === 304
    this.finish(new Response(empty ? null : this.payload ?? '', { status: this.statusCode, headers: h }))
    return this
  }
}
