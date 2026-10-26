import { ApiError } from './api'

export interface HostAccount {
  id: string
  label: string
  main: boolean
  usedHours: number
  reservedHours: number
  totalHours: number
  remainingHours: number
  refreshTime: string
  kernel: 'RUNNING' | 'QUEUED' | 'COMPLETE' | 'ERROR' | 'CANCELLED' | 'NONE'
  failureMessage?: string
  unverified?: boolean
}

export interface HostHidden {
  id: string
  label: string
  reason: string
  remainingHours: number
  refreshTime: string
}

export interface HostAccounts {
  accounts: HostAccount[]
  hidden: HostHidden[]
  running: string | null
  defaultAccount: string
}

export interface StartResult {
  ok: boolean
  account: string
  runHours: number
  remainingHours: number
  bootMinutes: number
  skipped: { account: string; reason: string }[]
}

/** Calls that decide where the model server runs (which Kaggle account) and whether it is on. Open to every visitor. */
export async function hostCall<T>(action: 'accounts' | 'start' | 'stop' | 'status' | 'progress' | 'running', extra: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch('/api/host', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...extra }) })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(body.error ?? 'error', body.message ?? `The request failed (${r.status}).`)
  return body as T
}

export interface StopResult {
  ok: boolean
  stopped?: string[]
  queued?: boolean // an analysis is running: the server turns off when it finishes
  cancelled?: boolean
  message?: string
}

export interface BootProgress {
  account: string
  status: string // QUEUED | RUNNING | COMPLETE | ERROR | CANCEL_* | NONE
  failureMessage?: string
  kaggleUrl: string
}
