// Workbooks: the sheet worker's reader over generated fixtures (number formats and both date systems, styles, merges,
// freezes, hidden bands, formulas with and without saved results, conditional formats, what isn't shown), the states
// it refuses with, and the colour and copy rules the grid draws them by.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classify, colPx, formatColour, readWorkbook, rowPx, UNZIPPED_MAX } from '../src/main/surfaces/workbook.ts'
import { K, type Book, type BookSheet } from '../src/shared/sheets.ts'
import { contrast, readable, rgbOf } from '../src/renderer/src/lib/fileColor.ts'
import { bookGaps, hiddenSaid, millions, offsetsOf, prefix, rowWindow, scrollToCol, scrollToRow, selectedLabel, selectedSaid, sheetGaps } from '../src/renderer/src/lib/sheetView.ts'
import { hidden, macro, many, ole, over, padded, report, shaped, styled, wide } from './support/xlsx-fixtures.mjs'
import { equal, ok } from './support/harness.mjs'

// Every reader call runs with an empty TMPDIR: a full load must leave nothing there.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clui-wb-'))
const spool = path.join(tmp, 'spool')
fs.mkdirSync(spool)
const tmpBefore = process.env.TMPDIR
process.env.TMPDIR = spool

const read = async (b: Uint8Array): Promise<Book> => {
  const r = await readWorkbook(b)
  if ('t' in r) throw new Error(`expected a book, got ${r.t}`)
  return r
}
const at = (s: BookSheet, a1: string): number => {
  const m = /^([A-Z]+)(\d+)$/.exec(a1)!
  const c = [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1
  const r = Number(m[2]) - 1
  for (let j = s.rowStart[r]; j < s.rowStart[r + 1]; j++) if (s.col[j] === c) return j
  return -1
}
const text = (s: BookSheet, a1: string): string => {
  const j = at(s, a1)
  return j < 0 ? '' : s.text.slice(s.textAt[j], s.textAt[j + 1])
}
const styleOf = (b: Book, s: BookSheet, a1: string) => {
  const j = at(s, a1)
  return j >= 0 && s.style[j] ? b.facts.styles[s.style[j] - 1] : undefined
}

// The styled workbook, saved in each date system: the same dates read the same.
for (const date1904 of [false, true]) {
  const b = await read(await styled(date1904))
  const s = b.sheets[0]
  const tag = date1904 ? '1904' : '1900'
  equal(b.date1904, date1904, `styled ${tag}: the date system`)
  equal(JSON.stringify(b.facts.sheets.map((x) => x.name)), '["Summary","Data"]', `styled ${tag}: sheet names in order`)
  equal(text(s, 'B5'), '1,240.50', `styled ${tag}: #,##0.00`)
  equal(text(s, 'C2'), '25.6%', `styled ${tag}: 0.0%`)
  equal(text(s, 'D2'), '$42', `styled ${tag}: a positive section`)
  equal(text(s, 'D3'), '($42)', `styled ${tag}: [Red] section text`)
  equal(styleOf(b, s, 'D3')?.ink, '#ff0000', `styled ${tag}: [Red] becomes the ink`)
  equal(styleOf(b, s, 'D2')?.ink, '#000000', `styled ${tag}: the positive section keeps the font colour`)
  equal(text(s, 'E2'), '2024-02-29', `styled ${tag}: a leap day`)
  equal(text(s, 'E3'), '2024-02-29 13:30', `styled ${tag}: a date and time`)
  equal(s.kind[at(s, 'E2')] & 7, K.date, `styled ${tag}: a date's kind`)
  equal(text(s, 'B13'), '123,456,789,012,345.00', `styled ${tag}: a wide number keeps its digits`)
  equal(text(s, 'A14'), 'TRUE', `styled ${tag}: a boolean`)
  equal(text(s, 'A15'), '#N/A', `styled ${tag}: an error`)
  equal(s.kind[at(s, 'A15')] & 7, K.error, `styled ${tag}: an error's kind`)
  equal(text(s, 'A16'), 'line one\nline two', `styled ${tag}: line breaks kept`)
  equal(s.link.get(at(s, 'A10')), 'https://example.com/clui', `styled ${tag}: a hyperlink's target, never fetched`)
}
{
  const b = await read(await styled(false))
  const s = b.sheets[0]
  const g = s.geo
  equal(JSON.stringify(g.frozen), '{"rows":1,"cols":1}', 'styled: frozen at B2')
  equal(JSON.stringify(g.top), '{"r":1,"c":1}', 'styled: opens at the top left cell')
  equal(JSON.stringify([...g.merges]), '[2,0,3,2]', 'styled: the A3:C4 merge')
  equal(at(s, 'B3'), -1, 'styled: a merge’s other cells hold nothing')
  equal(JSON.stringify([...g.mergeEdges].map((id) => b.facts.styles[id - 1]?.bd)), '[[0,4,0,0],[0,0,5,0]]', "styled: a merge's right and bottom borders from C3 and A4")
  equal(text(s, 'A3'), 'Quarterly totals', 'styled: the merge anchor')
  equal(JSON.stringify([...g.widths].slice(0, 3)), '[126,98,64]', "styled: widths by Excel's formula, default 64")
  equal(JSON.stringify([g.heights?.[0], g.heights?.[1], g.heights?.[5]]), '[20,40,60]', 'styled: heights in px, 15pt is 20')
  ok(g.gridlines, 'styled: gridlines on')
  equal(JSON.stringify(styleOf(b, s, 'A1')), '{"fill":"#1f4e79","ink":"#ffffff","b":true}', 'styled: a header fill and its text')
  equal(styleOf(b, s, 'A9')?.fill, '#95b3d7', 'styled: a theme colour with its tint')
  equal(JSON.stringify(styleOf(b, s, 'B5')?.bd), '[1,1,1,1]', 'styled: thin borders')
  equal(JSON.stringify(styleOf(b, s, 'D3')?.bd), '[4,4,4,4]', 'styled: medium borders')
  equal(JSON.stringify(styleOf(b, s, 'E2')?.bd), '[0,0,5,0]', 'styled: a double bottom border')
  equal(styleOf(b, s, 'A5')?.h, 'right', 'styled: right alignment')
  equal(JSON.stringify([styleOf(b, s, 'A6')?.wrap, styleOf(b, s, 'A6')?.v]), '[true,"top"]', 'styled: wrapped, top')
  equal(styleOf(b, s, 'A7')?.indent, 2, 'styled: an indent')
  equal(JSON.stringify([styleOf(b, s, 'A8')?.ink, styleOf(b, s, 'A8')?.i, styleOf(b, s, 'A8')?.u]), '["#ff0000",true,1]', 'styled: coloured italic underlined text')
  equal(JSON.stringify([styleOf(b, s, 'A11')?.s, styleOf(b, s, 'A11')?.b]), '[true,true]', 'styled: struck bold')
  equal(JSON.stringify(styleOf(b, s, 'A3')), '{"fill":"#fff2cc","ink":"#000000","h":"center","v":"middle"}', 'styled: the merge anchor’s style')

  // Formulas: a saved result, a wrong saved result shown as saved, a saved error, none at all. Nothing recalculates.
  const f = (a1: string): [number, string, string | undefined] => [s.kind[at(s, a1)], text(s, a1), s.formula.get(at(s, a1))]
  equal(JSON.stringify(f('F1')), JSON.stringify([K.number | K.cached, '4,812.00', '=SUM(B2:E2)']), 'formula: a saved result in its format')
  equal(JSON.stringify(f('F2')), JSON.stringify([K.number | K.cached, '7', '=B2*2']), 'formula: a wrong saved result stays wrong (never evaluated)')
  equal(JSON.stringify(f('F3')), JSON.stringify([K.error | K.cached, '#DIV/0!', '=B2/0']), 'formula: a saved error')
  equal(JSON.stringify(f('F4')), JSON.stringify([K.text | K.uncalculated, '=F2*1.2', '=F2*1.2']), 'formula: no saved result shows the formula')
  equal(g.gaps.uncalculated, 2, 'formula: two without saved results counted')

  // Conditional formats: cellIs, colorScale and dataBar drawn; an expression rule counts as not shown.
  equal(JSON.stringify(styleOf(b, s, 'B24')), '{"fill":"#c6efce","ink":"#006100","b":true}', 'cf: cellIs greaterThan applies its fill, ink and weight')
  equal(styleOf(b, s, 'B23'), undefined, 'cf: cellIs leaves a cell it doesn’t match')
  equal(styleOf(b, s, 'G2')?.fill, '#f8696b', 'cf: colorScale at the minimum')
  equal(styleOf(b, s, 'G10')?.fill, '#63be7b', 'cf: colorScale at the maximum')
  ok(!!styleOf(b, s, 'G6')?.fill && styleOf(b, s, 'G6')?.fill !== '#f8696b' && styleOf(b, s, 'G6')?.fill !== '#63be7b', 'cf: colorScale between')
  equal(JSON.stringify([styleOf(b, s, 'H2')?.bar?.f, styleOf(b, s, 'H10')?.bar?.f, styleOf(b, s, 'H10')?.bar?.color]), '[0,1,"#638ec6"]', 'cf: dataBar lengths from min to max')
  equal(JSON.stringify([styleOf(b, s, 'I2')?.bar?.f, styleOf(b, s, 'I10')?.bar?.f]), '[0.2,1]', 'cf: an Automatic dataBar runs from zero')
  ok(g.gaps.cf, 'cf: the expression rule is disclosed')
  equal(JSON.stringify(sheetGaps(g.gaps)), JSON.stringify(['2 formulas have no saved result, so they show as formulas.', "Some conditional formatting isn't shown."]), 'gaps: the styled sheet’s sentences')
}

// Hidden rows and columns, a hidden sheet.
{
  const b = await read(await hidden())
  equal(JSON.stringify([...b.sheets[0].geo.hiddenRows]), '[17,18]', 'hidden: rows 18 and 19')
  equal(JSON.stringify([...b.sheets[0].geo.hiddenCols]), '[2]', 'hidden: column C')
  equal(JSON.stringify(b.facts.sheets.map((x) => x.hidden)), '[false,true]', 'hidden: a hidden sheet')
  equal(hiddenSaid(2, 1), '2 hidden rows and 1 hidden column.', 'hidden: the sentence')
  equal(hiddenSaid(0, 3), '3 hidden columns.', 'hidden: columns alone')
  equal(hiddenSaid(0, 0), null, 'hidden: nothing to say')
}
{
  const b = await read(await many())
  equal(b.facts.sheets.length, 40, 'many: forty sheets')
  equal(JSON.stringify(b.facts.sheets.flatMap((x, i) => (x.hidden ? [i] : []))), '[6,19]', 'many: two hidden')
}
{
  const b = await read(await report())
  const g = b.sheets[0].geo
  ok(!g.gridlines, 'report: gridlines off')
  equal(JSON.stringify([g.gaps.charts, g.gaps.images, g.gaps.pivots, g.gaps.notes, [...g.hiddenCols]]), '[1,1,1,true,[3]]', 'report: chart, image, pivot, note, hidden column')
  equal(
    JSON.stringify(sheetGaps(g.gaps)),
    JSON.stringify(["1 chart isn't shown.", "1 image isn't shown.", "1 pivot table shows its saved values. Clui doesn't refresh it.", "Cell notes aren't shown."]),
    'report: the sentences'
  )
}
{
  const g = (await read(await shaped())).sheets[0].geo.gaps
  equal(JSON.stringify([g.images, g.shapes, sheetGaps(g)]), JSON.stringify([1, 1, ["2 images and shapes aren't shown."]]), 'shaped: a shape counts apart from an image')
  const only = (images: number, shapes: number): string[] => sheetGaps({ ...g, images, shapes })
  equal(JSON.stringify([only(0, 1), only(0, 3), only(2, 0)]), JSON.stringify([["1 shape isn't shown."], ["3 shapes aren't shown."], ["2 images aren't shown."]]), 'gaps: shapes alone and images alone')
}
{
  const b = await read(await macro())
  equal(JSON.stringify([b.facts.macros, b.facts.links, b.facts.recalc]), '[true,true,true]', 'macro: macros, links, recalculate on open')
  equal(b.sheets[0].formula.get(0), '=[1]Prices!B2', 'macro: an external reference verbatim')
  equal(bookGaps(b.facts).length, 3, 'macro: three workbook sentences')
}
{
  const b = await read(await wide())
  equal(JSON.stringify([b.sheets[0].geo.cols, [...b.sheets[0].geo.merges]]), '[1000,[0,2,0,8]]', 'wide: 1,000 columns and the C1:I1 merge')
}

// What isn't read: past the ceiling from <dimension> alone, encrypted, legacy and damaged.
{
  const t0 = performance.now()
  const r = await readWorkbook(await over())
  equal(JSON.stringify(r), JSON.stringify({ t: 'too-many', cells: 5_200_000 }), 'over: refused by <dimension> before a full load')
  ok(performance.now() - t0 < 1000, 'over: the precheck is quick')
  equal(millions(5_200_000), 'about 5.2 million', 'over: the copy’s number')
  equal(millions(12_400_000), 'about 12 million', 'over: past ten million, whole')
  equal(JSON.stringify(classify(ole(true))), '{"t":"encrypted"}', 'locked: an OLE file with EncryptionInfo is encrypted')
  equal(JSON.stringify(classify(ole(false))), '{"t":"old"}', 'old: an OLE file without it is a legacy workbook')
  equal(JSON.stringify(await readWorkbook(ole(false))), '{"t":"old"}', 'disguised: an .xls saved as .xlsx')
  const t1 = performance.now()
  equal(JSON.stringify(await readWorkbook(await padded(1, UNZIPPED_MAX))), '{"t":"damaged"}', 'bomb: an archive claiming more than 512 MiB unzipped is damaged')
  ok(performance.now() - t1 < 1000, 'bomb: refused without inflating it')
  ok(!('t' in (await readWorkbook(await padded(64 * 1024 * 1024)))), 'bomb: a workbook that really unzips to 64 MiB still reads')
  const s = await styled(false)
  equal(JSON.stringify(await readWorkbook(s.subarray(0, s.length >> 1))), '{"t":"damaged"}', 'broken: a truncated zip is damaged')
  equal(JSON.stringify(await readWorkbook(Buffer.from('PK binary workbook'))), '{"t":"damaged"}', 'broken: not a zip')
}
equal(fs.readdirSync(spool).length, 0, 'tmp: the full load spooled nothing to the temp dir')
process.env.TMPDIR = tmpBefore
fs.rmSync(tmp, { recursive: true, force: true })

// Sizes and format colours.
{
  equal(colPx(undefined), 64, 'size: no width is 64px')
  equal(colPx(9.140625), 64, 'size: the stored default width is 64px')
  equal(rowPx(15), 20, 'size: 15pt is 20px')
  equal(rowPx(9), 20, 'size: never under 20px')
  equal(formatColour('$#,##0;[Red]($#,##0)', -1), '#ff0000', 'format: the negative section’s colour')
  equal(formatColour('$#,##0;[Red]($#,##0)', 1), undefined, 'format: none for the positive section')
  equal(formatColour('[Blue][>100]0;[Red]0', 150), '#0000ff', 'format: a condition picks the section')
  equal(formatColour('[Blue][>100]0;[Red]0', 50), '#ff0000', 'format: past the condition, the next')
  equal(formatColour('[Color 10]0', 5), '#008000', 'format: an indexed colour')
}

// A file's colour on an unfilled cell keeps its hue and moves until it reads, in both themes.
{
  const dark = rgbOf('#161617')
  const light = rgbOf('#ffffff')
  for (const hex of ['#c00000', '#0000ff', '#00b050', '#ffff00', '#7030a0']) {
    for (const [bg, name] of [[dark, 'dark'], [light, 'light']] as const) {
      const out = readable(hex, bg, 4.5)
      ok(contrast(rgbOf(out), bg) >= 4.5, `colour: ${hex} on ${name} reaches 4.5:1 (${out}, ${contrast(rgbOf(out), bg).toFixed(2)})`)
    }
  }
  equal(readable('#ff0000', dark, 4.5), '#ff0000', 'colour: a colour already readable is kept')
  const r = rgbOf(readable('#c00000', dark, 4.5))
  ok(r[0] > r[1] && r[0] > r[2], 'colour: red stays red')
  ok(contrast(rgbOf(readable('#638ec6', light, 3)), light) >= 3, 'colour: a data bar reaches 3:1')
}

// The grid's geometry with row offsets and frozen columns, and its workbook copy.
{
  const off = prefix(5, (i) => [20, 40, 0, 20, 60][i])
  equal(JSON.stringify([...off]), '[0,20,60,60,80,140]', 'geometry: a hidden row is zero tall')
  const w = rowWindow(0, 50, 5, 1, 0, off)
  equal(JSON.stringify([w.first, w.r0, w.r1]), '[0,0,1]', 'geometry: rows in view by their heights')
  equal(scrollToRow(3, 0, 50, 5, 1, off), 30, 'geometry: a row below comes in at the bottom edge')
  equal(scrollToRow(4, 0, 50, 5, 1, off), 80, 'geometry: a row taller than the view comes in at its top')
  const cols = offsetsOf([100, 50, 50, 50], 4)
  equal(scrollToCol(cols, 1, 0, 200, 100), null, 'geometry: a column right of the frozen ones in view')
  equal(scrollToCol(cols, 3, 0, 200, 100), 50, 'geometry: past the frozen columns, scrolled so it ends at the right edge')
  const a = { shape: 'cells' as const, r0: 17, c0: 0, r1: 23, c1: 3 }
  equal(selectedLabel(a, 100, 10, 'Summary', true), 'Summary!A18:D24 selected · 28 cells · with values', 'copy: the workbook bar label')
  equal(selectedLabel(a, 100, 10, 'Q1 sales', false), "'Q1 sales'!A18:D24 selected · 28 cells", 'copy: a quoted sheet, no values')
  equal(selectedSaid(a, 100, 10, 'Summary', true), 'Summary, A18 to D24 selected, 28 cells, with values', 'copy: the workbook announcement')
  equal(selectedLabel(a, 100, 10), 'A18:D24 selected · 28 cells', 'copy: a CSV label unchanged')
}
