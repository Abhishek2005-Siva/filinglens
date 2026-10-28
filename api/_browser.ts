import type { Browser } from 'puppeteer-core'

// Opens the headless browser that reads Yahoo Finance. On Vercel it is a Chromium packed for serverless functions; on Cloudflare the worker puts its own
// launcher (Browser Rendering) in `globalThis.__FL_LAUNCH__`.
export async function launchBrowser(): Promise<Browser> {
  const own = (globalThis as { __FL_LAUNCH__?: () => Promise<Browser> }).__FL_LAUNCH__
  if (own) return own()
  const [{ default: puppeteer }, { default: chromium }] = await Promise.all([import('puppeteer-core'), import('@sparticuz/chromium')])
  return puppeteer.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: 'shell', defaultViewport: { width: 1280, height: 900 } })
}
