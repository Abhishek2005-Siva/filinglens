import type { VercelRequest, VercelResponse } from '@vercel/node'
import { backend } from './_backend.js'
import { requireAccess } from './_auth.js'
import { ACCOUNTS, DATASET_SLUG, EXTRA_DATASETS, KERNEL_SLUG, type AccountDef } from './_accounts.js'
import { datasetsApi, kaggle, KaggleError, kernelsApi, seconds } from './_kaggle.js'
import { modelUrl, setModelUrl, tunnelDown } from './_model.js'

// Control of where the model server runs (which Kaggle account's GPU) and when it is on. Open to every visitor of the site.
//   POST {action:'accounts'}                         -> GPU hours left per account (exhausted accounts are reported separately)
//   POST {action:'start', account, runHours?}        -> starts the server on that account ('auto' = best available)
//   POST {action:'stop'}                             -> stops the running server
//   POST {action:'status'}                           -> which account is running, and how
// Guard rails instead of a login: start refuses while a server is already running, and repeated start/stop calls from one
// visitor are limited (best effort: the counters live in the function instance's memory).

const MIN_HOURS = 1          // an account with less than this left is treated as out of GPU time
const DEFAULT_RUN_HOURS = 3  // how long one start may run (Kaggle reserves this much quota up front)
const IDLE_MINUTES = 7

// best-effort limiter: at most LIMIT start/stop calls per visitor per window
const hits = new Map<string, number[]>()
const WINDOW_MS = 10 * 60 * 1000
const LIMIT = 6
const tooMany = (ip: string): boolean => {
  const now = Date.now()
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS)
  if (recent.length >= LIMIT) {
    hits.set(ip, recent)
    return true
  }
  hits.set(ip, [...recent, now])
  if (hits.size > 500) for (const [k, v] of hits) if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k)
  return false
}

const tokenOf = (a: AccountDef) => process.env[a.env] || ''

interface AccountInfo {
  id: string
  label: string
  main: boolean
  configured: boolean
  adaptersReady: boolean
  authFailed?: boolean // Kaggle rejected this account's token (expired or revoked)
  extras: string[] // optional datasets that are ready on this account
  usedHours: number
  reservedHours: number
  totalHours: number
  remainingHours: number
  refreshTime: string
  kernel: 'RUNNING' | 'QUEUED' | 'COMPLETE' | 'ERROR' | 'CANCELLED' | 'NONE'
  failureMessage?: string
  error?: string
  unverified?: boolean // Kaggle was too busy to say how many GPU hours are left; remainingHours is a guess
  partial?: boolean // Kaggle could not answer part of the questions (too many requests); the numbers may be missing, not zero
}

const slowCache = new Map<string, { t: number; v: unknown }>()

async function inspect(a: AccountDef): Promise<AccountInfo> {
  const base: AccountInfo = {
    id: a.id, label: a.label, main: !!a.main, configured: !!tokenOf(a), adaptersReady: false, extras: [],
    usedHours: 0, reservedHours: 0, totalHours: 30, remainingHours: 0, refreshTime: '', kernel: 'NONE',
  }
  const token = tokenOf(a)
  if (!token) return { ...base, error: 'No Kaggle token configured for this account.' }
  // dataset status and GPU quota change slowly, and they are most of the questions Kaggle gets (8 datasets per account): ask rarely, and keep the last
  // good answer when Kaggle says 'too many requests'
  const slow = <X,>(key: string, ttl: number, fn: () => Promise<X>): Promise<X> => {
    const hit = slowCache.get(key)
    if (hit && Date.now() - hit.t < ttl) return Promise.resolve(hit.v as X)
    return fn().then((v) => { slowCache.set(key, { t: Date.now(), v }); return v }, (e) => { if (hit) return hit.v as X; throw e })
  }
  const [quota, ds, ker, ...ex] = await Promise.allSettled([
    slow(`q:${a.id}`, 60_000, () => kaggle(token, kernelsApi, 'GetAcceleratorQuotaStatistics', {})) as Promise<{ gpuQuota?: Record<string, string | undefined>; quotaRefreshTime?: string }>,
    slow(`d:${a.id}:${DATASET_SLUG}`, 10 * 60_000, () => kaggle(token, datasetsApi, 'GetDatasetStatus', { ownerSlug: a.id, datasetSlug: DATASET_SLUG })) as Promise<{ status?: string }>,
    kaggle(token, kernelsApi, 'GetKernelSessionStatus', { userName: a.id, kernelSlug: KERNEL_SLUG }),
    ...EXTRA_DATASETS.map((slug) => slow(`d:${a.id}:${slug}`, 10 * 60_000, () => kaggle(token, datasetsApi, 'GetDatasetStatus', { ownerSlug: a.id, datasetSlug: slug }))),
  ])
  const out = { ...base }
  if (quota.status === 'fulfilled') {
    const g = quota.value.gpuQuota ?? {}
    out.usedHours = seconds(g.timeUsed) / 3600
    out.reservedHours = seconds(g.timeReserved) / 3600
    out.totalHours = seconds(g.totalTimeAllowed) / 3600 || 30
    out.remainingHours = Math.max(0, out.totalHours - out.usedHours - out.reservedHours)
    out.refreshTime = quota.value.quotaRefreshTime ?? ''
  } else {
    out.error = `Could not read the GPU quota: ${quota.reason?.message ?? 'unknown error'}`
  }
  out.adaptersReady = ds.status === 'fulfilled' && ds.value.status === 'READY'
  // a rejected token makes every Kaggle call fail the same way; say so instead of blaming the model files
  const denied = [quota, ds, ker].some((r) => r.status === 'rejected' && (/unauthenticated/i.test(String(r.reason?.message)) || r.reason?.status === 401 || r.reason?.status === 'UNAUTHENTICATED'))
  if (denied) {
    out.authFailed = true
    out.error = 'Kaggle rejected this account’s token (it has probably expired).'
  }
  // Kaggle limits how often it can be asked ('429 Too Many Requests'); a refused question is not the same as 'no GPU hours left' or 'files not uploaded'
  // Kaggle answers 'permission denied' (403) or 'not found' for a private dataset that does not exist on the account yet: that is 'files not uploaded', not a limit
  const noFiles = ds.status === 'rejected' && (ds.reason?.status === 403 || ds.reason?.status === 404 || /permission.*denied|not.?found/i.test(String(ds.reason?.message)))
  if (!denied && [quota, ds].some((r) => r.status === 'rejected' && !(r === ds && noFiles))) out.partial = true
  // When Kaggle only said 'too many requests', we do not know the numbers, which is different from 'no hours left': let the person try, and Kaggle itself
  // will refuse a start that has no quota or no files.
  const busy = (r: PromiseSettledResult<unknown>) => r.status === 'rejected' && /429|too many|resource.?exhausted/i.test(String((r.reason as { message?: string; status?: unknown })?.message ?? '') + String((r.reason as { status?: unknown })?.status ?? ''))
  if (!denied && busy(ds)) out.adaptersReady = true
  if (!denied && busy(quota)) { out.remainingHours = out.totalHours; out.error = undefined; out.unverified = true }
  // A dataset whose status Kaggle refused to give ('too many requests') is attached anyway: leaving it out silently starts the server without those models
  // (the cyber reader, the filing readers for agreements and equity, the date finder, the result checker, ...), which is far worse than trying.
  out.extras = EXTRA_DATASETS.filter((_, i) => (ex[i]?.status === 'fulfilled' && (ex[i] as PromiseFulfilledResult<{ status?: string }>).value.status === 'READY') || (!denied && busy(ex[i])))
  if (ker.status === 'fulfilled') {
    // An empty answer means the first state of the enum, QUEUED (proto3 leaves the default value out): the run is waiting for a free GPU.
    out.kernel = (ker.value.status as AccountInfo['kernel']) ?? 'QUEUED'
    out.failureMessage = ker.value.failureMessage || undefined
  }
  return out
}

// Every open page asks the site about the server, and the site asks Kaggle: remember the answers for a short while so many visitors cost Kaggle one
// question, and when Kaggle refuses (429) keep showing the last good answer instead of claiming nothing is available.
const seen = new Map<string, { t: number; info: AccountInfo; good: AccountInfo | null }>()
const FRESH_MS = 30_000
const STALE_MS = 15 * 60_000
async function inspectCached(a: AccountDef, maxAge = FRESH_MS): Promise<AccountInfo> {
  const hit = seen.get(a.id)
  if (hit && Date.now() - hit.t < maxAge) return hit.info
  const info = await inspect(a)
  const good = info.partial || info.authFailed || !info.configured ? hit?.good ?? null : info
  const usable = info.partial && good && Date.now() - (hit?.t ?? 0) < STALE_MS ? { ...good, kernel: info.kernel, failureMessage: info.failureMessage } : info
  seen.set(a.id, { t: Date.now(), info: usable, good })
  return usable
}

/** Only the question "is a server queued or running, and where?": one cheap Kaggle call per account, cached for 10 seconds. */
async function runningOn(): Promise<string | null> {
  const states = await Promise.all(ACCOUNTS.map(async (a) => {
    const token = tokenOf(a)
    if (!token) return null
    const hit = seen.get(`run:${a.id}`)
    if (hit && Date.now() - hit.t < 10_000) return hit.info.kernel === 'RUNNING' || hit.info.kernel === 'QUEUED' ? a.id : null
    let kernel: AccountInfo['kernel'] = 'NONE'
    try {
      const st = await kaggle<{ status?: string }>(token, kernelsApi, 'GetKernelSessionStatus', { userName: a.id, kernelSlug: KERNEL_SLUG })
      kernel = (st.status as AccountInfo['kernel']) ?? 'QUEUED'
    } catch {
      const old = seen.get(`run:${a.id}`)
      kernel = old?.info.kernel ?? 'NONE' // Kaggle refused or failed: keep the last known state
    }
    seen.set(`run:${a.id}`, { t: Date.now(), info: { kernel } as AccountInfo, good: null })
    return kernel === 'RUNNING' || kernel === 'QUEUED' ? a.id : null
  }))
  return states.find(Boolean) ?? null
}

/** The kernel script with the app code and secrets filled in (never logged or returned). */
function buildScript(runHours: number, site: string): string {
  const { appZipB64: zip, template } = backend()
  const need = (k: string) => {
    const v = process.env[k]
    if (!v) throw new Error(`The server setting ${k} is missing.`)
    return v
  }
  let s = template
  const rep: Record<string, string> = {
    __APP_B64__: zip,
    __API_KEY__: need('MODEL_API_KEY'),
    __SEC_UA__: need('SEC_USER_AGENT'),
    __NGROK_TOKEN__: need('NGROK_AUTHTOKEN'),
    __NGROK_DOMAIN__: need('NGROK_DOMAIN'),
    __SITE_URL__: process.env.SITE_URL || site,
    __RUN_HOURS__: String(runHours),
    __IDLE_MINUTES__: String(IDLE_MINUTES),
  }
  for (const [k, v] of Object.entries(rep)) s = s.split(k).join(v)
  return s
}

async function pushKernel(a: AccountDef, runHours: number, site: string, extras: string[] = []) {
  return kaggle<{ url?: string; versionNumber?: number; error?: string }>(tokenOf(a), kernelsApi, 'SaveKernel', {
    slug: `${a.id}/${KERNEL_SLUG}`,
    newTitle: KERNEL_SLUG,
    text: buildScript(runHours, site),
    language: 'python',
    kernelType: 'script',
    isPrivate: true,
    enableGpu: true,
    enableTpu: false,
    enableInternet: true,
    datasetDataSources: [`${a.id}/${DATASET_SLUG}`, ...extras.map((slug) => `${a.id}/${slug}`)],
    competitionDataSources: [],
    kernelDataSources: [],
    modelDataSources: [],
    categoryIds: [],
    sessionTimeoutSeconds: Math.round(runHours * 3600 + 900),
  })
}

/** Stops the server on the given accounts. Kaggle only reports a kernel's latest run, so an older session can still be
 *  running when the status says COMPLETE; deleting the kernel ends every session it has, so do that whenever it exists. */
async function stopRunning(infos: AccountInfo[], only?: string) {
  const stopped: string[] = []
  const targets = infos.filter((i) => i.kernel !== 'NONE' && (!only || i.id === only))
  const url = await modelUrl()
  if (url && targets.length) {
    // Ask the server to stop itself first (newer versions understand this); deleting the kernel below ends it either way.
    const r = await fetch(`${url}/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.MODEL_API_KEY || ''}`, 'ngrok-skip-browser-warning': '1', 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(6000) })
      .then((x) => (x.ok ? (x.json() as Promise<{ batches?: number }>) : null))
      .catch(() => null)
    // an analysis is running and is being forced to stop: give it a moment to hand over what it has finished
    if (r && Number(r.batches) > 0) await new Promise((ok) => setTimeout(ok, 15000))
  }
  for (const i of targets) {
    const def = ACCOUNTS.find((a) => a.id === i.id)!
    try {
      await kaggle(tokenOf(def), kernelsApi, 'DeleteKernel', { userName: i.id, kernelSlug: KERNEL_SLUG })
      stopped.push(i.id)
    } catch { /* already gone */ }
  }
  return stopped
}

const eligible = (i: AccountInfo) => i.configured && i.adaptersReady && i.kernel !== 'RUNNING' && i.kernel !== 'QUEUED' && i.remainingHours >= MIN_HOURS

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'method', message: 'Use POST.' })
  const site = `https://${String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost')}`
  const body = (req.body ?? {}) as { action?: string; account?: string; runHours?: number; dryRun?: boolean; except?: string; cancel?: boolean; force?: boolean }
  if (body.action !== 'register' && !requireAccess(req, res)) return // the model server itself announces its address with the shared API key instead of a sign-in
  try {
    if (body.action === 'progress') {
      // light check used every few seconds while the server boots: just the Kaggle run status of one account
      const def = ACCOUNTS.find((a) => a.id === body.account)
      if (!def || !tokenOf(def)) return res.status(400).json({ error: 'bad_request', message: 'Unknown account.' })
      try {
        const st = await kaggle<{ status?: string; failureMessage?: string }>(tokenOf(def), kernelsApi, 'GetKernelSessionStatus', { userName: def.id, kernelSlug: KERNEL_SLUG })
        return res.status(200).json({ account: def.id, status: st.status ?? 'QUEUED', failureMessage: st.failureMessage || undefined, kaggleUrl: `https://www.kaggle.com/code/${def.id}/${KERNEL_SLUG}` })
      } catch {
        return res.status(200).json({ account: def.id, status: 'NONE', kaggleUrl: `https://www.kaggle.com/code/${def.id}/${KERNEL_SLUG}` })
      }
    }
    if (body.action === 'register') {
      // the model server announces its public address when it starts (it proves itself with the shared API key)
      const key = process.env.MODEL_API_KEY || ''
      if (!key || String(req.headers.authorization || '') !== `Bearer ${key}`) return res.status(401).json({ error: 'unauthorized' })
      const url = String((body as { url?: string }).url || '').replace(/\/$/, '')
      if (/^https:\/\/api\.trycloudflare\.com$/.test(url) || !/^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.(trycloudflare\.com|ngrok-free\.dev|ngrok-free\.app|ngrok\.app)$/.test(url)) return res.status(400).json({ error: 'bad_request', message: 'Not an accepted tunnel address.' })
      await setModelUrl(url)
      return res.status(200).json({ ok: true })
    }
    if (body.action === 'running') return res.status(200).json({ running: await runningOn() })
    const infos = await Promise.all(ACCOUNTS.map((a) => inspectCached(a, body.action === 'start' || body.action === 'stop' ? 0 : FRESH_MS)))

    if (body.action === 'accounts' || body.action === 'status') {
      const mu = await modelUrl()
      return res.status(200).json({
        modelHost: mu ? mu.replace(/^https:\/\//, '') : null, // which tunnel address the site is using (a public address, not a secret)
        accounts: infos.filter((i) => i.configured && (eligible(i) || i.kernel === 'RUNNING' || i.kernel === 'QUEUED')),
        hidden: infos
          .filter((i) => !(i.configured && (eligible(i) || i.kernel === 'RUNNING' || i.kernel === 'QUEUED')))
          .map((i) => ({ id: i.id, label: i.label, reason: !i.configured ? 'not configured' : i.authFailed ? 'its Kaggle token was rejected (probably expired): make a new token on Kaggle and update it on the site' : i.partial ? 'Kaggle is limiting how often it can be asked right now (too many requests); wait a minute and try again' : !i.adaptersReady ? 'model files not uploaded to this account yet' : i.remainingHours < MIN_HOURS ? 'out of GPU hours' : 'unavailable', remainingHours: i.remainingHours, refreshTime: i.refreshTime })),
        running: infos.find((i) => i.kernel === 'RUNNING' || i.kernel === 'QUEUED')?.id ?? null,
        defaultAccount: ACCOUNTS.find((a) => a.main)?.id ?? ACCOUNTS[0].id,
      })
    }

    if (body.action === 'start' || body.action === 'stop') {
      const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim()
      if (!body.dryRun && tooMany(ip)) return res.status(429).json({ error: 'slow_down', message: 'Too many start/stop requests in a short time. Please wait a few minutes.' })
    }

    if (body.action === 'stop') {
      const url = await modelUrl()
      const ask = (path: string, payload: unknown) =>
        fetch(`${url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.MODEL_API_KEY || ''}`, 'ngrok-skip-browser-warning': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000) })
          .then(async (r) => (r.ok && !tunnelDown(r) ? ((await r.json().catch(() => ({}))) as Record<string, unknown>) : null))
          .catch(() => null)
      if (body.cancel) {
        // take back a turn-off that was waiting for an analysis to finish
        if (url) await ask('/shutdown/cancel', {})
        return res.status(200).json({ ok: true, cancelled: true })
      }
      if (url && !body.force) {
        // if an analysis is running the server queues the turn-off and keeps going until it is done
        const r = await ask('/shutdown', { queue: true })
        if (r?.queued) return res.status(200).json({ ok: true, queued: true, batches: r.batches, message: String(r.message ?? '') })
      }
      const stopped = await stopRunning(infos.filter((i) => i.id !== body.except), body.account && body.account !== 'all' ? body.account : undefined)
      return res.status(200).json({ ok: true, stopped })
    }

    if (body.action === 'start') {
      const alreadyOn = infos.find((i) => i.kernel === 'RUNNING' || i.kernel === 'QUEUED')
      if (alreadyOn && !body.dryRun) {
        return res.status(409).json({ error: 'already_running', message: `A server is already running on ${alreadyOn.label}. If it is not reachable yet it is still booting. To use a different account, turn it off first.`, account: alreadyOn.id })
      }
      // Only the account the person chose is ever used. There is no automatic fallback to another account.
      const wanted = body.account && body.account !== 'auto' ? body.account : ''
      if (!wanted) return res.status(400).json({ error: 'choose_account', message: 'Choose which Kaggle account to start the model on.' })
      const info = infos.find((i) => i.id === wanted)
      const def = ACCOUNTS.find((a) => a.id === wanted)
      if (!info || !def) return res.status(400).json({ error: 'bad_request', message: 'Unknown account.' })
      if (!eligible(info)) {
        const why = !info.configured ? 'it has no Kaggle token set up on the site' : info.authFailed ? 'its Kaggle token was rejected (probably expired)' : info.partial ? 'Kaggle is limiting how often it can be asked right now (too many requests), so its GPU hours and files could not be read; wait a minute and try again' : !info.adaptersReady ? 'the model files are not uploaded to it yet' : info.kernel === 'RUNNING' || info.kernel === 'QUEUED' ? 'a server is already running on it' : 'it is out of GPU hours'
        return res.status(409).json({ error: 'account_unavailable', message: `${info.label} cannot start the server right now: ${why}. Pick another account.`, account: wanted })
      }
      const runHours = Math.max(1, Math.min(Number(body.runHours) || DEFAULT_RUN_HOURS, Math.floor(info.remainingHours - 0.25)))
      if (body.dryRun) {
        const script = buildScript(runHours, site) // proves the app code and secrets are all available; nothing is pushed or stopped
        return res.status(200).json({ ok: true, dryRun: true, account: wanted, runHours, scriptKB: Math.round(script.length / 1024), remainingHours: info.remainingHours })
      }
      // leftovers on other accounts (finished or older runs) are cleared so only one server can hold the public address
      await stopRunning(infos.filter((i) => i.id !== wanted))
      try {
        const r = await pushKernel(def, runHours, site, info.extras)
        if (r.error) throw new KaggleError(400, r.error)
        return res.status(200).json({ ok: true, account: wanted, runHours, url: r.url, remainingHours: info.remainingHours, skipped: [], bootMinutes: 3 })
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'failed'
        const friendly = /Maximum batch GPU session count/i.test(msg)
          ? 'Kaggle allows only 2 GPU notebooks at a time on an account and this one already has 2 running (probably training runs).'
          : /quota/i.test(msg) ? 'it is out of GPU hours' : msg.slice(0, 160)
        return res.status(409).json({ error: 'account_unavailable', message: `${info.label} could not start the server: ${friendly} Pick another account.`, account: wanted })
      }
    }

    return res.status(400).json({ error: 'bad_request', message: 'Unknown action.' })
  } catch (e) {
    return res.status(502).json({ error: 'kaggle_error', message: e instanceof Error ? e.message : 'Could not reach Kaggle.' })
  }
}
