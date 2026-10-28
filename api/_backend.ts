import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { zipSync } from 'fflate'

// The AI-server code that is pushed to Kaggle: the Python app (zipped) and the notebook template. On Vercel they are read from the deployed files; on
// Cloudflare there is no disk, so the worker puts them in `globalThis.__FL_BACKEND__` at start-up (built by scripts/gen-backend.mjs).
export interface Backend { appZipB64: string; template: string }

const listFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (n === '__pycache__' || n.endsWith('.pyc')) return []
    return statSync(p).isDirectory() ? listFiles(p) : [p]
  })

export function backend(): Backend {
  const given = (globalThis as { __FL_BACKEND__?: Backend }).__FL_BACKEND__
  if (given) return given
  const root = join(process.cwd(), 'backend')
  const files: Record<string, Uint8Array> = {}
  for (const f of listFiles(join(root, 'app'))) files[relative(root, f).split('\\').join('/')] = new Uint8Array(readFileSync(f))
  return { appZipB64: Buffer.from(zipSync(files, { level: 6 })).toString('base64'), template: readFileSync(join(root, 'kaggle', 'server_template.py'), 'utf8') }
}
