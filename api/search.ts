import { requireAccess } from './_auth.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { secFetch, one, indexUrl, docUrl, padCik, type FilingRow } from './_sec.js'

// Mirrors sec.gov's "EDGAR Full-Text Search": keywords, form type, date range, company.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAccess(req, res)) return
  const q = one(req.query.q).trim()
  const forms = one(req.query.forms) || '8-K'
  const start = one(req.query.start)
  const end = one(req.query.end)
  const cik = one(req.query.cik)
  const from = Math.max(0, parseInt(one(req.query.from) || '0', 10) || 0)
  // `item` filters to filings that declare a given 8-K Item (e.g. 5.02 leadership, 1.03 bankruptcy). `leadership=1` is the old alias.
  const itemRaw = one(req.query.item) || (one(req.query.leadership) === '1' ? '5.02' : '')
  const item = /^\d\.\d{2}$/.test(itemRaw) ? itemRaw : ''

  const phrase = item ? `${q ? q + ' ' : ''}"Item ${item}"` : q
  const params = new URLSearchParams()
  if (phrase) params.set('q', phrase)
  params.set('forms', forms)
  if (start && end) {
    params.set('dateRange', 'custom')
    params.set('startdt', start)
    params.set('enddt', end)
  }
  if (cik) params.set('ciks', padCik(cik))
  if (from) params.set('from', String(from))

  try {
    const r = await secFetch(`https://efts.sec.gov/LATEST/search-index?${params}`)
    if (!r.ok) return res.status(502).json({ error: `The SEC search returned ${r.status}.` })
    const data = (await r.json()) as {
      hits: { total: { value: number }; hits: { _id: string; _source: Record<string, any> }[] }
    }
    data.hits.hits.sort((a, b) => String(b._source.file_date ?? '').localeCompare(String(a._source.file_date ?? '')))
    const seen = new Set<string>()
    const rows: FilingRow[] = []
    for (const h of data.hits.hits) {
      const s = h._source
      const adsh: string = s.adsh
      if (seen.has(adsh)) continue
      seen.add(adsh)
      const cikRaw: string = (s.ciks?.[0] ?? '0').replace(/^0+/, '') || '0'
      const name: string = s.display_names?.[0] ?? ''
      const tm = name.match(/\(([A-Z0-9.,\- ]+)\)\s+\(CIK/)
      const file = h._id.split(':')[1] ?? ''
      rows.push({
        accession: adsh,
        cik: cikRaw,
        company: name.replace(/\s+\(.*$/, '').trim(),
        ticker: tm ? tm[1].split(',')[0].trim() : '',
        date: s.file_date,
        form: s.form || s.root_forms?.[0] || '',
        items: s.items ?? [],
        location: s.biz_locations?.[0] ?? '',
        description: s.file_description || s.file_type || '',
        docUrl: file ? docUrl(cikRaw, adsh, file) : indexUrl(cikRaw, adsh),
        indexUrl: indexUrl(cikRaw, adsh),
      })
    }
    res.setHeader('Cache-Control', 'private, max-age=300')
    return res.status(200).json({
      total: data.hits.total.value,
      from,
      pageSize: data.hits.hits.length,
      // the SEC text search matches the words "Item 1.03" anywhere (a trust's boilerplate, a cross-reference), so keep only filings that declare the Item
      filings: item ? rows.filter((r) => r.items.includes(item)) : rows,
    })
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach the SEC search.', detail: String(e) })
  }
}
