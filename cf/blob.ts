// A stand-in for @vercel/blob that keeps the same calls (get, put, list, del) but stores the files as rows of a Cloudflare D1 database (free, no payment
// method needed). The site's functions are shared between Vercel and Cloudflare, so wrangler.jsonc points the import "@vercel/blob" here.
import { env } from 'cloudflare:workers'

interface Stmt { bind(...v: unknown[]): Stmt; first<T = Record<string, unknown>>(): Promise<T | null>; all<T = Record<string, unknown>>(): Promise<{ results: T[] }>; run(): Promise<unknown> }
interface Db { prepare(sql: string): Stmt; exec(sql: string): Promise<unknown>; batch(s: Stmt[]): Promise<unknown> }
const db = (): Db => (env as unknown as { DB: Db }).DB

let ready: Promise<unknown> | null = null
const init = () => (ready ??= db().exec('CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, body TEXT NOT NULL, type TEXT, updated INTEGER)'))

export async function get(pathname: string, _opts?: unknown) {
  await init()
  const row = await db().prepare('SELECT body, updated FROM files WHERE path = ?').bind(pathname).first<{ body: string; updated: number }>()
  if (!row) return null
  return { statusCode: 200 as const, stream: new Response(row.body).body as ReadableStream, blob: { pathname, size: row.body.length, uploadedAt: new Date(row.updated) } }
}

export async function put(pathname: string, body: string | ArrayBuffer, opts: { contentType?: string } = {}) {
  await init()
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body)
  await db().prepare('INSERT INTO files (path, body, type, updated) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(path) DO UPDATE SET body = ?2, type = ?3, updated = ?4')
    .bind(pathname, text, opts.contentType ?? 'application/json', Date.now()).run()
  return { pathname, url: '' }
}

export async function list(opts: { prefix?: string; limit?: number; cursor?: string } = {}) {
  await init()
  const limit = opts.limit ?? 1000
  const offset = Number(opts.cursor) || 0
  const prefix = opts.prefix ?? ''
  // a range on the primary key, so only the matching rows are read (D1 counts every row it scans against the daily allowance)
  const upper = prefix ? prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1) : '\uffff'
  const { results } = await db().prepare('SELECT path, length(body) AS size, updated FROM files WHERE path >= ?1 AND path < ?2 ORDER BY path LIMIT ?3 OFFSET ?4')
    .bind(prefix, upper, limit + 1, offset).all<{ path: string; size: number; updated: number }>()
  const more = results.length > limit
  return { blobs: results.slice(0, limit).map((r) => ({ pathname: r.path, size: r.size, uploadedAt: new Date(r.updated) })), cursor: more ? String(offset + limit) : undefined, hasMore: more }
}

export async function del(pathname: string | string[]) {
  await init()
  const paths = Array.isArray(pathname) ? pathname : [pathname]
  for (let i = 0; i < paths.length; i += 50) await db().batch(paths.slice(i, i + 50).map((p) => db().prepare('DELETE FROM files WHERE path = ?').bind(p)))
}
