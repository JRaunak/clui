// Workbook fixtures for the sheet reader's tests and the sheets probe, built with exceljs and finished with JSZip for
// the parts exceljs can't write.
import fs from 'node:fs'
import path from 'node:path'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const thin = { style: 'thin', color: { argb: 'FF000000' } }

async function rezip(buf, edit) {
  const zip = await JSZip.loadAsync(buf)
  await edit(zip)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
const text = (zip, name) => zip.file(name).async('string')

/** The styled workbook: fills, fonts, borders, alignment, a boxed A3:C4 merge, a freeze at B2, widths and
 *  heights, number formats, formulas with and without saved results, and four conditional formats. */
export async function styled(date1904) {
  const wb = new ExcelJS.Workbook()
  wb.properties.date1904 = date1904
  const ws = wb.addWorksheet('Summary', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1, topLeftCell: 'B2' }] })
  ws.getColumn(1).width = 18
  ws.getColumn(2).width = 14
  ws.getColumn(5).width = 18
  ws.getRow(2).height = 30
  ws.getRow(1).values = ['Region', 'Q1', 'Rate', 'Delta', 'Date', 'Total', 'Scale', 'Bar']
  ws.getRow(1).eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' } }
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } }
  })
  ws.getCell('A2').value = 'North'
  ws.getCell('B2').value = 1200
  ws.getCell('C2').value = 0.256
  ws.getCell('C2').numFmt = '0.0%'
  ws.getCell('D2').value = 42
  ws.getCell('D2').numFmt = '$#,##0;[Red]($#,##0)'
  ws.getCell('D3').value = -42
  ws.getCell('D3').numFmt = '$#,##0;[Red]($#,##0)'
  ws.getCell('D3').border = { top: { style: 'medium' }, left: { style: 'medium' }, bottom: { style: 'medium' }, right: { style: 'medium' } }
  ws.getCell('E2').value = new Date(Date.UTC(2024, 1, 29))
  ws.getCell('E2').numFmt = 'yyyy-mm-dd'
  ws.getCell('E2').border = { bottom: { style: 'double' } }
  ws.getCell('E3').value = new Date(Date.UTC(2024, 1, 29, 13, 30))
  ws.getCell('E3').numFmt = 'yyyy-mm-dd hh:mm'
  ws.getCell('A3').value = 'Quarterly totals'
  ws.getCell('A3').alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getCell('A3').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } }
  ws.mergeCells('A3:C4')
  // A boxed merge as Excel saves one: the right side on the right-edge cells, the bottom on the bottom-edge cells.
  ws.getCell('C3').style = { ...ws.getCell('A3').style, border: { right: { style: 'medium' } } }
  ws.getCell('A4').style = { ...ws.getCell('A3').style, border: { bottom: { style: 'double' } } }
  ws.getCell('B5').value = 1240.5
  ws.getCell('B5').numFmt = '#,##0.00'
  ws.getCell('B5').border = { top: thin, left: thin, bottom: thin, right: thin }
  ws.getCell('A5').value = 'right'
  ws.getCell('A5').alignment = { horizontal: 'right' }
  ws.getCell('A6').value = 'A wrapped cell whose words run on past the width of its column'
  ws.getCell('A6').alignment = { wrapText: true, vertical: 'top' }
  ws.getRow(6).height = 45
  ws.getCell('A7').value = 'indented'
  ws.getCell('A7').alignment = { indent: 2 }
  ws.getCell('A8').value = 'red ink'
  ws.getCell('A8').font = { color: { argb: 'FFFF0000' }, italic: true, underline: true }
  ws.getCell('A9').value = 'theme fill'
  ws.getCell('A9').fill = { type: 'pattern', pattern: 'solid', fgColor: { theme: 4, tint: 0.3999755851924192 } }
  ws.getCell('A10').value = { text: 'Clui', hyperlink: 'https://example.com/clui' }
  ws.getCell('A11').value = 'struck'
  ws.getCell('A11').font = { strike: true, bold: true }
  ws.getCell('A12').value = 'A long label that spills over the empty cells to its right'
  ws.getCell('C12').value = 'stop'
  ws.getCell('B13').value = 123456789012345
  ws.getCell('B13').numFmt = '#,##0.00'
  ws.getCell('A14').value = true
  ws.getCell('A15').value = { error: '#N/A' }
  ws.getCell('A16').value = 'line one\nline two'
  ws.getCell('F1').value = { formula: 'SUM(B2:E2)', result: 4812 }
  ws.getCell('F1').numFmt = '#,##0.00'
  // Deliberately wrong: Clui shows what the file saved and never recalculates.
  ws.getCell('F2').value = { formula: 'B2*2', result: 7 }
  ws.getCell('F3').value = { formula: 'B2/0', result: { error: '#DIV/0!' } }
  ws.getCell('F4').value = { formula: 'F2*1.2' }
  ws.getCell('G12').value = { formula: 'VLOOKUP(A2,A2:B5,2,FALSE)' }
  for (let r = 18; r <= 27; r++) for (let c = 1; c <= 6; c++) ws.getCell(r, c).value = c === 1 ? `row${r}` : r * 10 + c
  for (let r = 2; r <= 10; r++) {
    ws.getCell(r, 7).value = r * 10
    ws.getCell(r, 8).value = r
  }
  ws.addConditionalFormatting({ ref: 'B18:B27', rules: [{ type: 'cellIs', operator: 'greaterThan', formulae: ['240'], priority: 1, style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFC6EFCE' } }, font: { color: { argb: 'FF006100' }, bold: true } } }] })
  ws.addConditionalFormatting({ ref: 'G2:G10', rules: [{ type: 'colorScale', priority: 2, cfvo: [{ type: 'min' }, { type: 'max' }], color: [{ argb: 'FFF8696B' }, { argb: 'FF63BE7B' }] }] })
  ws.addConditionalFormatting({ ref: 'H2:H10', rules: [{ type: 'dataBar', priority: 3, cfvo: [{ type: 'min' }, { type: 'max' }], color: { argb: 'FF638EC6' } }] })
  ws.addConditionalFormatting({ ref: 'C18:C27', rules: [{ type: 'expression', formulae: ['MOD(C18,2)=0'], priority: 4, style: { font: { bold: true } } }] })
  const data = wb.addWorksheet('Data')
  data.getRow(1).values = ['k', 'v']
  for (let r = 2; r <= 6; r++) data.getRow(r).values = [`k${r}`, r]
  const buf = await wb.xlsx.writeBuffer()
  // exceljs writes no <v> for a formula without a result; F1 to F3 keep theirs.
  return Buffer.from(buf)
}

/** Hidden rows and columns, a hidden sheet, and default geometry. */
export async function hidden() {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Visible')
  for (let r = 1; r <= 30; r++) for (let c = 1; c <= 6; c++) ws.getCell(r, c).value = `${String.fromCharCode(64 + c)}${r}`
  for (const r of [18, 19]) ws.getRow(r).hidden = true
  ws.getColumn(3).hidden = true
  const h = wb.addWorksheet('Secret', { state: 'hidden' })
  h.getCell('A1').value = 'hidden sheet'
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** 140k rows by 10 columns of strings, numbers, dates and booleans, a styled header, and a second 50-row sheet. */
export async function big10(file) {
  const w = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: file, useSharedStrings: false, useStyles: true })
  const ws = w.addWorksheet('Data')
  const head = ws.addRow(['id', 'name', 'qty', 'price', 'when', 'ok', 'city', 'code', 'score', 'note'])
  head.font = { bold: true }
  head.commit()
  const day = Date.UTC(2020, 0, 1)
  for (let i = 1; i <= 140_000; i++) {
    const r = ws.addRow([i, `name${i % 997}`, i % 13, i * 1.25, new Date(day + (i % 2000) * 86_400_000), i % 2 === 0, `city${i % 50}`, `C${i}`, (i * 7) % 100, `n${i}`])
    r.getCell(4).numFmt = '#,##0.00'
    r.getCell(5).numFmt = 'yyyy-mm-dd'
    r.commit()
  }
  ws.commit()
  const s = w.addWorksheet('Summary')
  for (let i = 1; i <= 50; i++) s.addRow([`k${i}`, i]).commit()
  s.commit()
  await w.commit()
}

/** 40 sheets, two hidden. */
export async function many() {
  const wb = new ExcelJS.Workbook()
  for (let i = 1; i <= 40; i++) {
    const ws = wb.addWorksheet(`Sheet number ${i}`, i === 7 || i === 20 ? { state: 'hidden' } : {})
    ws.getCell('A1').value = `sheet ${i}`
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** Gridlines off, a chart, an image, a pivot table, a note and a hidden column. */
export async function report() {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Report', { views: [{ showGridLines: false }] })
  for (let r = 1; r <= 10; r++) for (let c = 1; c <= 5; c++) ws.getCell(r, c).value = r * c
  ws.getColumn(4).hidden = true
  ws.getCell('B2').note = 'A note'
  ws.addImage(wb.addImage({ buffer: PNG, extension: 'png' }), 'G2:H6')
  return rezip(Buffer.from(await wb.xlsx.writeBuffer()), async (zip) => {
    const relsName = 'xl/drawings/_rels/drawing1.xml.rels'
    const rels = await text(zip, relsName)
    zip.file(relsName, rels.replace('</Relationships>', '<Relationship Id="rIdChart1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/></Relationships>'))
    zip.file('xl/charts/chart1.xml', '<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>')
    const sheetRels = 'xl/worksheets/_rels/sheet1.xml.rels'
    const sr = await text(zip, sheetRels)
    zip.file(sheetRels, sr.replace('</Relationships>', '<Relationship Id="rIdPivot1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/pivotTable" Target="../pivotTables/pivotTable1.xml"/></Relationships>'))
    zip.file('xl/pivotTables/pivotTable1.xml', '<?xml version="1.0"?><pivotTableDefinition xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" name="P"/>')
  })
}

/** An image and a shape on one sheet. */
export async function shaped() {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Drawn')
  ws.getCell('A1').value = 1
  ws.addImage(wb.addImage({ buffer: PNG, extension: 'png' }), 'C2:D4')
  return rezip(Buffer.from(await wb.xlsx.writeBuffer()), async (zip) => {
    const name = 'xl/drawings/drawing1.xml'
    const shape = '<xdr:oneCellAnchor><xdr:from><xdr:col>5</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="914400" cy="457200"/><xdr:sp><xdr:nvSpPr><xdr:cNvPr id="2" name="Box 2"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:sp><xdr:clientData/></xdr:oneCellAnchor>'
    zip.file(name, (await text(zip, name)).replace('</xdr:wsDr>', `${shape}</xdr:wsDr>`))
  })
}

/** A macro workbook that also links to another file. */
export async function macro() {
  const wb = new ExcelJS.Workbook()
  wb.addWorksheet('Macros').getCell('A1').value = { formula: '[1]Prices!B2', result: 3 }
  return rezip(Buffer.from(await wb.xlsx.writeBuffer()), async (zip) => {
    zip.file('xl/vbaProject.bin', Buffer.from('not a real project'))
    zip.file('xl/externalLinks/externalLink1.xml', '<?xml version="1.0"?><externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>')
    const wbx = await text(zip, 'xl/workbook.xml')
    zip.file('xl/workbook.xml', wbx.replace(/<calcPr[^>]*\/>/, '<calcPr calcId="171027" fullCalcOnLoad="1"/>'))
  })
}

/** 1,000 columns, a merge anchored in column 3 spanning to 9. */
export async function wide() {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Wide')
  for (let r = 1; r <= 200; r++) ws.getRow(r).values = Array.from({ length: 1000 }, (_, c) => (r === 1 && c >= 2 && c <= 8 ? null : `${r}-${c}`))
  ws.getCell(1, 3).value = 'merged anchor'
  ws.mergeCells(1, 3, 1, 9)
  return Buffer.from(await wb.xlsx.writeBuffer())
}

/** A small sheet whose <dimension> claims 200,000 rows by 26 columns: the precheck refuses it without a full load. */
export async function over() {
  const wb = new ExcelJS.Workbook()
  wb.addWorksheet('Big').getCell('A1').value = 1
  return rezip(Buffer.from(await wb.xlsx.writeBuffer()), async (zip) => {
    const s = await text(zip, 'xl/worksheets/sheet1.xml')
    zip.file('xl/worksheets/sheet1.xml', s.replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:Z200000"/>'))
  })
}

/** A one-cell workbook with an extra part of `bytes` zeros whose central directory entry claims `claim` bytes unzipped,
 *  so the reader's archive cap can see a huge claim without anything that large being built. */
export async function padded(bytes, claim = bytes) {
  const wb = new ExcelJS.Workbook()
  wb.addWorksheet('Data').getCell('A1').value = 1
  const buf = await rezip(Buffer.from(await wb.xlsx.writeBuffer()), async (zip) => zip.file('customXml/pad.bin', Buffer.alloc(bytes)))
  const cd = Buffer.from('504b0102', 'hex')
  const name = Buffer.from('customXml/pad.bin')
  for (let p = buf.indexOf(cd); p >= 0; p = buf.indexOf(cd, p + 4)) if (buf.subarray(p + 46, p + 46 + name.length).equals(name)) buf.writeUInt32LE(claim, p + 24)
  return buf
}

/** An OLE compound file: with an EncryptionInfo stream it's an encrypted OOXML workbook, without it a legacy .xls. A
 *  header and one directory sector are all the reader looks at. */
export function ole(encrypted) {
  const b = Buffer.alloc(1536)
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(b, 0)
  const name = (s, at) => b.write(s, at, 'utf16le')
  name('Root Entry', 512)
  name(encrypted ? 'EncryptionInfo' : 'Workbook', 640)
  if (encrypted) name('EncryptedPackage', 768)
  return b
}

export async function writeAll(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const put = (n, b) => fs.writeFileSync(path.join(dir, n), b)
  put('styled1900.xlsx', await styled(false))
  put('styled1904.xlsx', await styled(true))
  put('hidden.xlsx', await hidden())
  put('many.xlsx', await many())
  put('report.xlsx', await report())
  put('macro.xlsm', await macro())
  put('wide.xlsx', await wide())
  put('over.xlsx', await over())
  put('locked.xlsx', ole(true))
  put('old.xls', ole(false))
  put('disguised.xlsx', ole(false))
  put('bin.xlsb', Buffer.from('PK binary workbook'))
  const s = await styled(false)
  put('broken.xlsx', s.subarray(0, Math.floor(s.length / 2)))
  if (!fs.existsSync(path.join(dir, 'big10.xlsx'))) await big10(path.join(dir, 'big10.xlsx'))
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1])) && process.argv[2]) await writeAll(process.argv[2])
