import { COLUMNS, type Row } from './columns'

const save = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

const csvCell = (v: string | number) => {
  const s = String(v ?? '')
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function downloadCsv(rows: Row[], name: string) {
  const lines = [COLUMNS.map(csvCell).join(','), ...rows.map((r) => COLUMNS.map((c) => csvCell(r[c] ?? '')).join(','))]
  // The BOM makes Excel open the file as UTF-8 instead of garbling accents and symbols.
  save(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), name)
}

export async function downloadXlsx(rows: Row[], name: string, about: [string, string][]) {
  const mod: any = await import('exceljs/dist/exceljs.min.js')
  const ExcelJS = mod.default ?? mod
  const wb = new ExcelJS.Workbook()
  wb.creator = 'FilingLens'
  wb.created = new Date()

  const ws = wb.addWorksheet('Results', { views: [{ state: 'frozen', ySplit: 1, xSplit: 2 }] })
  ws.columns = COLUMNS.map((c) => ({
    header: c,
    key: c,
    width: ({ Company: 30, 'Event summary': 46, Evidence: 60, 'SEC link': 30, 'Items in filing': 22, Status: 26 } as Record<string, number>)[c] ?? (c.length > 14 ? 30 : 16),
  }))
  rows.forEach((r) => {
    const row = ws.addRow(Object.fromEntries(COLUMNS.map((c) => [c, r[c] ?? ''])))
    const link = String(r['SEC link'] || '')
    if (link) row.getCell('SEC link').value = { text: 'Open on SEC.gov', hyperlink: link }
  })
  ws.getColumn('Market cap ($ millions)').numFmt = '#,##0.0'
  const head = ws.getRow(1)
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } }
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } }
  head.alignment = { vertical: 'middle', wrapText: true }
  head.height = 30
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } }
  ws.eachRow((row: any, n: number) => {
    if (n > 1) row.alignment = { vertical: 'top', wrapText: true }
  })
  // light highlight on event cells so findings stand out
  const eventCols = COLUMNS.slice(8, 21)
  rows.forEach((r, i) => {
    eventCols.forEach((c) => {
      if (r[c]) ws.getRow(i + 2).getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F6EC' } }
    })
  })

  const info = wb.addWorksheet('About')
  info.columns = [{ width: 26 }, { width: 90 }]
  about.forEach(([k, v]) => info.addRow([k, v]))
  info.getColumn(1).font = { bold: true }

  const buf: ArrayBuffer = await wb.xlsx.writeBuffer()
  save(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), name)
}
