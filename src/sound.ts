// A short chime (made with the browser's audio, no sound file) that says "the AI model is on".
// Browsers only allow sound after the person has touched the page, so the audio is unlocked by any click or key press.
const KEY = 'filinglensSound'
let ctx: AudioContext | null = null

export const soundEnabled = (): boolean => {
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true
  }
}

export const setSoundEnabled = (on: boolean) => {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch { /* storage unavailable */ }
}

export function unlockAudio() {
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    ctx = ctx ?? new AC()
    if (ctx.state === 'suspended') void ctx.resume()
  } catch { /* no audio available */ }
}

/** Plays the chime now (also used by the "test sound" link). */
export function playChime(force = false) {
  if (!force && !soundEnabled()) return
  unlockAudio()
  const c = ctx
  if (!c) return
  const start = c.currentTime + 0.02
  ;[659.25, 783.99, 1046.5].forEach((hz, i) => {
    const o = c.createOscillator()
    const g = c.createGain()
    o.type = 'sine'
    o.frequency.value = hz
    const t = start + i * 0.17
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.03)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7)
    o.connect(g).connect(c.destination)
    o.start(t)
    o.stop(t + 0.75)
  })
}

let restoreTitle: number | undefined
/** Chime plus a tab-title note, so it is noticed even when the tab is in the background. */
export function announceReady() {
  playChime()
  const original = document.title.replace(/^✅ AI model is on · /, '')
  document.title = `✅ AI model is on · ${original}`
  window.clearTimeout(restoreTitle)
  const back = () => { document.title = original }
  window.addEventListener('focus', back, { once: true })
  restoreTitle = window.setTimeout(back, 30000)
}
