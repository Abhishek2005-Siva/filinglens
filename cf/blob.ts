// A stand-in for @vercel/blob that keeps the same calls (get, put, list, del) but stores the files in a Cloudflare R2 bucket. The site's functions are
// shared between Vercel and Cloudflare, so wrangler.jsonc points the import "@vercel/blob" here.
import { env } from 'cloudflare:workers'

interface Bucket {
  get(key: string): Promise<{ body: ReadableStream; size: number; uploaded: Date } | null>
  put(key: string, value: string | ArrayBuffer | ReadableStream, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>
  delete(keys: string | string[]): Promise<void>
  list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<{ objects: { key: string; size: number; uploaded: Date }[]; truncated: boolean; cursor?: string }>
}
const bucket = (): Bucket => (env as unknown as { BUCKET: Bucket }).BUCKET

export async function get(pathname: string, _opts?: unknown) {
  const o = await bucket().get(pathname)
  if (!o) return null
  return { statusCode: 200 as const, stream: o.body, blob: { pathname, size: o.size, uploadedAt: o.uploaded } }
}

export async function put(pathname: string, body: string | ArrayBuffer, opts: { contentType?: string } = {}) {
  await bucket().put(pathname, body, { httpMetadata: { contentType: opts.contentType ?? 'application/octet-stream' } })
  return { pathname, url: '' }
}

export async function list(opts: { prefix?: string; limit?: number; cursor?: string } = {}) {
  const r = await bucket().list({ prefix: opts.prefix, limit: opts.limit ?? 1000, cursor: opts.cursor })
  return { blobs: r.objects.map((o) => ({ pathname: o.key, size: o.size, uploadedAt: o.uploaded })), cursor: r.truncated ? r.cursor : undefined, hasMore: r.truncated }
}

export async function del(pathname: string | string[]) {
  await bucket().delete(pathname)
}
