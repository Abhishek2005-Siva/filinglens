import { requireAccess } from './_auth.js'
import type { VercelRequest, VercelResponse } from '@vercel/node'
import { secFetch, one, indexUrl, docUrl, padCik, type FilingRow } from './_sec.js'

// A company's recent filings (like sec.gov's company page), straight from EDGAR submissions.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!requireAccess(req, res)) return
  const cik = one(req.query.cik)
  const forms = (one(req.query.forms) || '8-K').split(',').map((f) => f.trim().toUpperCase())
  const start = one(req.query.start)
  const end = one(req.query.end)
  const itemRaw = one(req.query.item) || (one(req.query.leadership) === '1' ? '5.02' : '')
  const item = /^\d\.\d{2}$/.test(itemRaw) ? itemRaw : ''
  if (!/^\d{1,10}$/.test(cik)) return res.status(400).json({ error: 'A numeric company CIK is required.' })

  try {
    const r = await secFetch(`https://data.sec.gov/submissions/CIK${padCik(cik)}.json`)
    if (r.status === 404) return res.status(404).json({ error: 'No company with that CIK.' })
    if (!r.ok) return res.status(502).json({ error: `The SEC returned ${r.status}.` })
    const d = (await r.json()) as any
    const rec = d.filings.recent
    const rows: FilingRow[] = []
    for (let i = 0; i < rec.accessionNumber.length; i++) {
      const form: string = rec.form[i]
      if (!forms.includes(form.toUpperCase())) continue
      const date: string = rec.filingDate[i]
      if (start && date < start) continue
      if (end && date > end) continue
      const items: string[] = (rec.items[i] || '').split(',').map((x: string) => x.trim()).filter(Boolean)
      if (item && !items.includes(item)) continue
      const acc: string = rec.accessionNumber[i]
      rows.push({
        accession: acc,
        cik: String(Number(cik)),
        company: d.name,
        ticker: d.tickers?.[0] ?? '',
        date,
        form,
        items,
        location: [d.addresses?.business?.city, d.addresses?.business?.stateOrCountry].filter(Boolean).join(', '),
        description: rec.primaryDocDescription[i] || form,
        docUrl: docUrl(cik, acc, rec.primaryDocument[i]),
        indexUrl: indexUrl(cik, acc),
      })
    }
    res.setHeader('Cache-Control', 'private, max-age=300')
    return res.status(200).json({ total: rows.length, from: 0, pageSize: rows.length, filings: one(req.query.all) ? rows : rows.slice(0, 200), company: { name: d.name, ticker: d.tickers?.[0] ?? '', cik: String(Number(cik)) } })
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach the SEC.', detail: String(e) })
  }
}
