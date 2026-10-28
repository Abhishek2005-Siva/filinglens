// Cloudflare entry point. Static pages are served by the platform (see "assets" in wrangler.jsonc); only /api/* reaches this code. Each /api/<name> is the
// same function file that Vercel runs, wrapped so it sees the same req/res objects.
import { env } from 'cloudflare:workers'
import puppeteer from '@cloudflare/puppeteer'
import analyze from '../api/analyze.js'
import batch from '../api/batch.js'
import companies from '../api/companies.js'
import filings from '../api/filings.js'
import host from '../api/host.js'
import login from '../api/login.js'
import manual from '../api/manual.js'
import marketcap from '../api/marketcap.js'
import presence from '../api/presence.js'
import prices from '../api/prices.js'
import search from '../api/search.js'
import yahoo from '../api/yahoo.js'
import { appZipB64, template } from './backend_bundle.js'
import { FakeRes, toReq } from './shim.js'

type Handler = (req: never, res: never) => unknown
const routes: Record<string, Handler> = { analyze, batch, companies, filings, host, login, manual, marketcap, presence, prices, search, yahoo } as unknown as Record<string, Handler>

const g = globalThis as Record<string, unknown>
g.__FL_BACKEND__ = { appZipB64, template }
g.__FL_LAUNCH__ = () => puppeteer.launch((env as unknown as { BROWSER: never }).BROWSER)

async function run(handler: Handler, request: Request): Promise<Response> {
  const req = await toReq(request)
  const res = new FakeRes()
  try {
    await Promise.race([Promise.resolve(handler(req as never, res as never)), res.done])
  } catch (e) {
    if (!res.writableEnded) res.status(500).json({ error: 'server_error', message: String(e).slice(0, 200) })
  }
  if (!res.writableEnded) res.status(204).end()
  return res.done
}

export default {
  async fetch(request: Request): Promise<Response> {
    const name = new URL(request.url).pathname.replace(/^\/api\//, '').split('/')[0]
    const handler = routes[name]
    if (!handler) return Response.json({ error: 'not_found' }, { status: 404 })
    return run(handler, request)
  },
  // the daily clean-up of expired Yahoo prices (Vercel's cron used to call this address)
  async scheduled(_event: unknown, _env: unknown, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(run(prices, new Request('https://internal/api/prices?cleanup=1', { headers: { 'user-agent': 'vercel-cron/cloudflare' } })))
  },
}
