import type { FilingRow, SlimResult } from '../types'
import { whenText } from '../utils'

export type Row = Record<string, string | number>

export const COLUMNS = [
  'Filed', 'Company', 'Ticker', 'CIK', 'Form', 'Items in filing',
  'Events found', 'Event summary',
  'CEO appointed', 'CEO leaving', 'CFO appointed', 'CFO leaving',
  'Bankruptcy', 'Delisting / listing notice', 'Auditor change', 'Shareholder votes',
  'Acquisition / sale', 'Material agreements', 'Unregistered equity sales', 'Earnings guidance', 'Restructuring / impairment',
  'Market cap',
  'Needs review', 'Top confidence', 'Evidence', 'SEC link', 'Accession', 'Status',
] as const

export type Column = (typeof COLUMNS)[number]

const pct = (x?: number | null) => (x == null ? '' : `${(x * 100).toFixed(1)}%`)

type Det = NonNullable<SlimResult['detectors']>[number]

const det = (r: SlimResult, key: string): Det | undefined => (r.detectors ?? []).find((d) => d.key === key && d.applicable)

const summarize = (d?: Det): string =>
  d && d.found ? d.events.map((e) => e.title + (e.detail ? ` (${e.detail})` : '') + (e.confidence != null ? ` [${pct(e.confidence)}]` : '')).join('; ') : ''

const person = (name: string | null | undefined, conf?: number | null, interim?: boolean, when?: { effective?: string | null; effectiveNote?: string | null }) =>
  `${name || 'Yes (name not stated)'}${interim ? ' (interim)' : ''}${when && whenText(when) ? ` · effective ${when.effective ?? whenText(when).toLowerCase()}` : ''}${conf != null ? ` [${pct(conf)}]` : ''}`

/** One spreadsheet row for a filing that was analyzed. */
export function rowFor(f: FilingRow, r: SlimResult): Row {
  const cfo = det(r, 'cfo')
  const cfoApp = cfo?.events.find((e) => e.kind === 'appointed')
  const cfoRes = cfo?.events.find((e) => e.kind === 'resigned')
  const dets = (r.detectors ?? []).filter((d) => d.applicable && d.found)
  const titles = [
    ...(r.appointed.found ? ['New CEO named'] : []),
    ...(r.resigned.found ? ['CEO leaving'] : []),
    ...dets.flatMap((d) => d.events.map((e) => e.title)),
  ]
  const confs = [r.appointed.confidence, r.resigned.confidence, ...dets.flatMap((d) => d.events.map((e) => e.confidence))].filter((x): x is number => typeof x === 'number')
  const evidence = r.appointed.sentence || r.resigned.sentence || dets.flatMap((d) => d.events).find((e) => e.evidence)?.evidence || ''
  const inFiling = r.item502Found || (r.detectors ?? []).some((d) => d.applicable)
  return {
    'Filed': f.date,
    'Company': f.company,
    'Ticker': f.ticker,
    'CIK': f.cik,
    'Form': f.form,
    'Items in filing': (r.filing.items?.length ? r.filing.items : f.items).join(', '),
    'Events found': titles.length,
    'Event summary': titles.join('; '),
    'CEO appointed': r.appointed.found ? person(r.appointed.names && r.appointed.names.length > 1 ? r.appointed.names.join(', ') : r.appointed.name, r.appointed.confidence, false, r.appointed) : '',
    'CEO leaving': r.resigned.found ? person(r.resigned.name, r.resigned.confidence, false, r.resigned) + (r.resigned.staysAs ? ` · stays as ${r.resigned.staysAs}` : r.resigned.staysKind === 'board' ? ' · stays on the board' : r.resigned.staysKind === 'role' ? ' · stays in another role' : '') + (r.resigned.coCeo ? ' · Co-CEO' : '') : '',
    'CFO appointed': cfoApp ? person(cfoApp.name, cfoApp.confidence, cfoApp.interim, cfoApp) : '',
    'CFO leaving': cfoRes ? person(cfoRes.name, cfoRes.confidence, cfoRes.interim, cfoRes) : '',
    'Bankruptcy': summarize(det(r, 'bankruptcy')),
    'Delisting / listing notice': summarize(det(r, 'delisting')),
    'Auditor change': summarize(det(r, 'auditor')),
    'Shareholder votes': summarize(det(r, 'votes')),
    'Acquisition / sale': summarize(det(r, 'acquisition')),
    'Material agreements': summarize(det(r, 'agreements')),
    'Unregistered equity sales': summarize(det(r, 'equity')),
    'Earnings guidance': summarize(det(r, 'guidance')),
    'Restructuring / impairment': summarize(det(r, 'restructuring')),
    'Needs review': [['CEO appointed', r.appointed], ['CEO leaving', r.resigned]].flatMap(([label, x]) => {
      const st = (x as SlimResult['appointed']).found ? (x as SlimResult['appointed']).check?.state : undefined
      return st === 'review' ? [`${label} (check)`] : st === 'likely_wrong' ? [`${label} (probably wrong)`] : []
    }).join(', '),
    'Top confidence': confs.length ? Math.round(Math.max(...confs) * 1000) / 10 : '',
    'Evidence': evidence,
    'SEC link': f.indexUrl,
    'Accession': f.accession,
    'Status': inFiling ? 'Analyzed' : 'Analyzed (no tracked item in this filing)',
  }
}

export function errorRow(f: FilingRow, message: string): Row {
  const row: Row = Object.fromEntries(COLUMNS.map((c) => [c, ''])) as Row
  Object.assign(row, { 'Filed': f.date, 'Company': f.company, 'Ticker': f.ticker, 'CIK': f.cik, 'Form': f.form, 'Items in filing': f.items.join(', '), 'SEC link': f.indexUrl, 'Accession': f.accession, 'Status': `Error: ${message}` })
  return row
}
