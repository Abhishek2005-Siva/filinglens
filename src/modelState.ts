// The model server sleeps after ~3 minutes with no requests. We remember when we last saw it ready
// so the header can show "on" without pinging (a ping would wake it and use free credit).
const KEY = 'modelReadyUntil'
export const IDLE_MS = 170_000

// Shared "the server is starting" flag, so the header button and the filing page agree.
let startingAt: number | null = null
export const getStartingAt = () => startingAt
export const markStarting = () => {
  if (startingAt === null) startingAt = performance.now()
  window.dispatchEvent(new Event('model-starting'))
}

export const markOff = () => {
  startingAt = null
  try {
    localStorage.setItem(KEY, '0')
  } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event('model-ready'))
}

export const clearStarting = () => {
  startingAt = null
  window.dispatchEvent(new Event('model-ready'))
}

export const markReady = () => {
  startingAt = null
  try {
    localStorage.setItem(KEY, String(Date.now() + IDLE_MS))
  } catch { /* storage unavailable */ }
  window.dispatchEvent(new Event('model-ready'))
}

export const readyUntil = (): number => {
  try {
    return Number(localStorage.getItem(KEY) ?? 0)
  } catch {
    return 0
  }
}

// How long a cold start took last times, so the countdown gets more accurate with use.
const COLD_KEY = 'modelColdSeconds'
const DEFAULT_COLD = 15

export const coldEstimate = (): number => {
  try {
    const n = Number(localStorage.getItem(COLD_KEY))
    return n >= 5 && n <= 180 ? n : DEFAULT_COLD
  } catch {
    return DEFAULT_COLD
  }
}

export const recordCold = (seconds: number) => {
  try {
    const blended = Math.round(coldEstimate() * 0.4 + seconds * 0.6)
    localStorage.setItem(COLD_KEY, String(Math.min(180, Math.max(5, blended))))
  } catch { /* storage unavailable */ }
}

// Booting on Kaggle: the time from "Kaggle gave us a GPU" to "all models ready" (about 2 minutes). Waiting in Kaggle's queue is separate and has no estimate.
const BOOT_KEY = 'modelBootSeconds2'
const DEFAULT_BOOT = 150
let startingEstimate: number | null = null
export const setStartingEstimate = (s: number | null) => { startingEstimate = s }
export const getStartingEstimate = () => startingEstimate

export const bootEstimate = (): number => {
  try {
    const n = Number(localStorage.getItem(BOOT_KEY))
    return n >= 60 && n <= 1800 ? n : DEFAULT_BOOT
  } catch {
    return DEFAULT_BOOT
  }
}

export const recordBoot = (seconds: number) => {
  try {
    localStorage.setItem(BOOT_KEY, String(Math.round(bootEstimate() * 0.4 + seconds * 0.6)))
  } catch { /* storage unavailable */ }
}
