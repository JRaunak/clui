// Sheets: A1 ranges, the CSV parser and its record index over the fixture corpus (quoted delimiters and line breaks,
// escaped quotes, CRLF, BOM, chunk boundaries inside a character, ragged rows, encodings), and the sheet reference.
import { a1Of, clampA1, colIndex, colName, parseA1, qualified, spokenA1, tsvOf } from '../src/shared/sheets.ts'
import { CsvIndex, guessHeader, isNumber, numericColumns, oneLine, sniff } from '../src/renderer/src/lib/csv.ts'
import { isRefInput, parseRefs, refKey, refLabel, resourceOf, serializeContext, type RefInput } from '../src/shared/context.ts'
import { kindForPath, restoreKinds, type SavedSet } from '../src/shared/surfaces.ts'
import { addedText, removalSpoken, shortLabel, spokenRef } from '../src/renderer/src/lib/refCopy.ts'
import { hasFind, opensDefault, presentationOf } from '../src/renderer/src/lib/presentation.ts'
import { equal, ok } from './support/harness.mjs'

const enc = new TextEncoder()
const measure = (s: string): number => s.length * 7
/** The whole file in chunks of `step` bytes. */
function index(bytes: Uint8Array, step = bytes.length || 1, opts: { delimiter?: ',' | ';' | '\t' | '|'; size?: number; total?: number } = {}): CsvIndex {
  const total = opts.total ?? bytes.length
  const x = new CsvIndex(opts.size ?? bytes.length, total, { measure, ...(opts.delimiter ? { delimiter: opts.delimiter } : {}) })
  if (!total) x.push(new Uint8Array(0), true)
  for (let i = 0; i < total; i += step) x.push(bytes.subarray(i, Math.min(total, i + step)), i + step >= total)
  return x
}
const all = (x: CsvIndex): string[][] => x.rows(0, x.facts.records - 1, 100_000)

// A1 notation
{
  equal(colName(0), 'A', 'a1: column 0 is A')
  equal(colName(25), 'Z', 'a1: 25 is Z')
  equal(colName(26), 'AA', 'a1: 26 is AA')
  equal(colName(701), 'ZZ', 'a1: 701 is ZZ')
  equal(colName(16383), 'XFD', "a1: Excel's last column")
  for (const c of [0, 25, 26, 701, 702, 16383, 999_999]) equal(colIndex(colName(c)), c, `a1: ${colName(c)} round-trips`)
  for (const [text, want] of [
    ['B4', 'B4'],
    ['a18:d24', 'A18:D24'],
    ['D24:A18', 'A18:D24'],
    ['18:24', '18:24'],
    ['24:18', '18:24'],
    ['B:D', 'B:D'],
    ['b4:b4', 'B4']
  ]) {
    const a = parseA1(text)
    equal(a ? a1Of(a) : null, want, `a1: ${text} reads as ${want}`)
  }
  for (const bad of ['', 'A0', '4B', 'A1:B', '1:B', 'A:1', 'A1:B2:C3', 'AAAAAA1', '0:3', 'A1 B2', '$A$1']) equal(parseA1(bad), null, `a1: ${JSON.stringify(bad)} is refused`)
  const rows = parseA1('18:24')!
  equal(JSON.stringify(clampA1(rows, 100, 12)), JSON.stringify({ r0: 17, c0: 0, r1: 23, c1: 11 }), 'a1: a row range closes on the sheet’s columns')
  equal(spokenA1(parseA1('A18:D24')!), 'A18 to D24', 'a1: a range is spoken with to')
  equal(spokenA1(parseA1('18:18')!), 'row 18', 'a1: one row')
  equal(spokenA1(parseA1('B:D')!), 'columns B to D', 'a1: columns')
  equal(qualified('A18:D24', 'Summary'), 'Summary!A18:D24', 'a1: a plain sheet name is bare')
  equal(qualified('A18', 'Q1 sales'), "'Q1 sales'!A18", 'a1: a name with a space is quoted')
  equal(qualified('A1', "Bob's"), "'Bob''s'!A1", 'a1: a quote in a name doubles')
  equal(qualified('A1', 'B4'), "'B4'!A1", 'a1: a name that reads as a cell is quoted')
  equal(qualified('A1'), 'A1', 'a1: no sheet, no prefix')
  equal(tsvOf([['a\tb', 'c\r\nd'], ['', 'e\nf']]), 'a b\tc d\n\te f', 'tsv: tabs and line breaks inside values become spaces')
}

// The parser over the corpus
{
  const multi = enc.encode('﻿name,note,qty\r\n"Smith, J","said ""hi""",3\r\n"a\nb\nc\nd",x,4\r\nlast,,5')
  for (const step of [multi.length, 7, 1]) {
    const x = index(multi, step)
    equal(x.facts.records, 4, `csv: four records, not seven lines (chunks of ${step})`)
    equal(JSON.stringify(all(x)), JSON.stringify([['name', 'note', 'qty'], ['Smith, J', 'said "hi"', '3'], ['a\nb\nc\nd', 'x', '4'], ['last', '', '5']]), `csv: quoted commas, escaped quotes, CRLF, BOM gone (chunks of ${step})`)
    equal(JSON.stringify(x.lines(2, 2)), JSON.stringify({ start: 3, end: 6 }), `csv: a record with three line breaks spans four lines (chunks of ${step})`)
    equal(JSON.stringify(x.lines(1, 3)), JSON.stringify({ start: 2, end: 7 }), 'csv: a range runs from its first record’s line to its last’s')
    equal(x.recordOf(4), 2, 'csv: a line inside a multiline field maps to its record')
    equal(x.recordOf(7), 3, 'csv: the last line maps to the last record')
    equal(x.recordOf(8), -1, 'csv: past the end maps to nothing')
  }
  // A two-byte character split across the chunk boundary, and a three-byte one.
  const wide = enc.encode(`${'x'.repeat(65_535)},é\nb,€\n`)
  const split = index(wide, 65_536)
  equal(split.facts.encoding, 'UTF-8', 'csv: a character across a chunk boundary still reads as UTF-8')
  equal(split.rows(0, 1, 100_000)[0][1], 'é', 'csv: and decodes whole')
  equal(split.rows(1, 1, 10)[0][1], '€', 'csv: a three-byte character decodes')

  const cp = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x2c, 0x31, 0x0a])
  const w = index(cp)
  equal(w.facts.encoding, 'Windows-1252', 'csv: invalid UTF-8 reads as Windows-1252')
  equal(w.rows(0, 0, 100)[0][0], 'café', 'csv: é in Windows-1252')

  const le = new Uint8Array([0xff, 0xfe, ...Array.from('a,é\nb,c\n').flatMap((ch) => [ch.charCodeAt(0), 0])])
  const u = index(le, 3)
  equal(u.facts.encoding, 'UTF-16', 'csv: a UTF-16 BOM reads as UTF-16')
  equal(JSON.stringify(all(u)), JSON.stringify([['a', 'é'], ['b', 'c']]), 'csv: UTF-16 decodes across odd chunk boundaries')

  const ragged = index(enc.encode('a,b,c\n1\n1,2,3,4,5\n\n'))
  equal(ragged.facts.records, 4, 'csv: a blank line is a record, the final line break is not')
  equal(`${ragged.facts.minFields}-${ragged.facts.cols}`, '1-5', 'csv: ragged rows report their narrowest and widest')
  equal(ragged.cell(1, 2).fields, 1, 'csv: a missing field reports its record’s field count')

  const open = index(enc.encode('a,b\n1,"never\nclosed,3\n4,5\n'))
  equal(open.facts.unclosed, 1, 'csv: an unclosed quote names its record')
  equal(open.facts.records, 2, 'csv: and runs to the end of the file')

  const loose = index(enc.encode('a"b,"c"d,"e"""\n'))
  equal(JSON.stringify(all(loose)), JSON.stringify([['a"b', 'cd', 'e"']]), 'csv: a quote inside a bare field is text; text after a closing quote is kept')

  const tsv = index(enc.encode('a\tb,c\n1\t2\n'), 4, { delimiter: '\t' })
  equal(JSON.stringify(all(tsv)), JSON.stringify([['a', 'b,c'], ['1', '2']]), 'tsv: tabs split, commas are text')

  const big = enc.encode(Array.from({ length: 1000 }, (_, i) => `${i},"r${i}\nx"`).join('\n'))
  const b = index(big, 4096)
  equal(b.facts.records, 1000, 'csv: a thousand multiline records')
  equal(b.rows(777, 777, 99)[0][0], '777', 'csv: a record far from its checkpoint')
  equal(b.lines(777, 777).start, 1555, 'csv: its first line counts every line break before it')
  equal(b.recordOf(1556), 777, 'csv: and its second line maps back to it')
  const win = b.window(500, 502, 1, 1, [0])
  equal(win.cells.map((c) => `${c.row}:${c.value}`).join(' '), '0:r0\nx 500:r500\nx 501:r501\nx 502:r502\nx', 'csv: a window carries its pinned rows and only its columns')
  equal(JSON.stringify(win.fields), '[2,2,2]', 'csv: and each row’s field count')

  const long = index(enc.encode(`${'é'.repeat(1500)},b\n`))
  const lw = long.window(0, 0, 0, 0)
  ok(lw.cells[0].value.length === 1000 && lw.cells[0].long === true, 'csv: a window cell stops at 1,000 characters and says so')
  equal(long.cell(0, 0).value.length, 1500, 'csv: the formula bar reads the whole field')

  const cut = enc.encode('a,b\n1,2\n3,4\n5,6')
  const c = index(cut, 5, { size: 100, total: cut.length - 2 })
  equal(c.facts.records, 3, 'csv: at the ceiling a record cut in half is dropped')

  const empty = index(new Uint8Array(0))
  equal(empty.facts.records, 0, 'csv: an empty file has no records')

  const re = /2/iu
  const f = index(enc.encode('a,b\n12,x\ny,2\n'))
  equal(f.find(re, 0, 100, 10).hits.join(','), '1,0,2,1', 'find: matching cells, row-major')
  equal(f.find(re, 0, 100, 1).hits.join(','), '1,0', 'find: stops at its limit')

  const redo = index(enc.encode('a;b,c\n1;2,3\n'))
  equal(redo.facts.delimiter, ',', 'csv: a tie goes to the comma')
  redo.redelimit(';')
  equal(JSON.stringify(all(redo)), JSON.stringify([['a', 'b,c'], ['1', '2,3']]), 'csv: reading again with semicolons')
}

// Sniffing and the header guess
{
  equal(sniff(enc.encode('a;b;c\n1,5;2;3\n4;5;6\n')), ';', 'sniff: semicolons with decimal commas')
  equal(sniff(enc.encode('a\tb\n1\t2\n')), '\t', 'sniff: tabs')
  equal(sniff(enc.encode('a|b|c\n1|2|3\n')), '|', 'sniff: pipes')
  equal(sniff(enc.encode('"x;y",b\n"1;2",3\n')), ',', 'sniff: delimiters inside quotes don’t count')
  for (const [v, want] of [
    ['1,240.50', true],
    ['-3', true],
    ['$1,000', true],
    ['12.5%', true],
    ['1e5', true],
    [' 007 ', true],
    ['1,5', false],
    ['.5', false],
    ['abc', false],
    ['', false]
  ] as const) {
    equal(isNumber(v), want, `number: ${JSON.stringify(v)}`)
  }
  const head = [['id', 'name', 'qty'], ['1', 'a', '3'], ['2', 'b', '4']]
  ok(guessHeader(head, numericColumns(head.slice(1), 3)), 'header: names over number columns')
  const none = [['1', 'a'], ['2', 'b']]
  ok(!guessHeader(none, numericColumns(none.slice(1), 2)), 'header: a number in row 1 means no header')
  const words = [['kind', 'colour'], ['cat', 'red'], ['dog', 'red']]
  ok(guessHeader(words, numericColumns(words.slice(1), 2)), 'header: distinct names over a repeating column')
  const flat = [['a', 'b'], ['c', 'd'], ['e', 'f']]
  ok(!guessHeader(flat, numericColumns(flat.slice(1), 2)), 'header: text over unique text is not a header')
  const gap = [['a', ''], ['1', '2']]
  ok(!guessHeader(gap, numericColumns(gap.slice(1), 2)), 'header: an empty field in row 1 means no header')
  equal(oneLine('a\r\nb\nc'), 'a ↵ b ↵ c', 'cell: line breaks join with ↵')
  const x = index(enc.encode('id,name\n1,ab\n2,abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz0123456789\n'))
  equal(JSON.stringify(x.facts.widths), '[64,320]', 'widths: clamped 64 to 320 px')
  equal(JSON.stringify(x.facts.numeric), '[true,false]', 'widths: number columns found')
  ok(x.facts.detected.header, 'header: guessed from the first records')
}

// The sheet reference
{
  const V = `sha256:${'b'.repeat(32)}` as const
  const ref: RefInput = { kind: 'sheet', path: '/w/data.csv', sourceVersion: V, range: 'A18:D24', lines: { start: 18, end: 31 } }
  ok(isRefInput(ref), 'ref: a CSV range with lines is valid')
  ok(isRefInput({ kind: 'sheet', path: '/w/b.xlsx', sourceVersion: V, sheet: 'Summary', range: 'B4', values: '1240.5' }), 'ref: a workbook range with a sheet and values is valid')
  for (const [bad, what] of [
    [{ ...ref, range: 'a18:d24' }, 'a range not in canonical form'],
    [{ ...ref, range: 'D24:A18' }, 'corners out of order'],
    [{ ...ref, range: 'nope' }, 'not A1'],
    [{ ...ref, sourceVersion: 'rev' }, 'a stat revision'],
    [{ ...ref, sheet: '' }, 'an empty sheet name'],
    [{ ...ref, lines: { start: 5, end: 4 } }, 'lines backwards']
  ] as const) {
    ok(!isRefInput(bad), `ref: refuses ${what}`)
  }
  equal(refLabel(ref), 'data.csv · A18:D24', 'ref: refLabel')
  equal(refLabel({ ...ref, sheet: 'Q1 sales', lines: undefined }), "data.csv · 'Q1 sales'!A18:D24", 'ref: refLabel quotes a sheet name')
  equal(resourceOf({ ...ref, id: 'r1' }), 'sheet:/w/data.csv', 'ref: its own resource')
  ok(refKey(ref) !== refKey({ ...ref, range: 'A18:D25' }), 'ref: another range is another reference')
  equal(shortLabel({ ...ref, id: 'r1' }), 'A18:D24', 'copy: shortLabel is the range')
  equal(spokenRef(ref), 'data.csv, A18 to D24', 'copy: spoken')
  equal(spokenRef({ ...ref, range: '18:24' }), 'data.csv, rows 18 to 24', 'copy: spoken rows')
  equal(addedText(ref), 'Added A18 to D24 of data.csv to the message.', 'copy: added')
  equal(removalSpoken([{ ...ref, id: 'r1' }], 'changed'), 'data.csv changed. A18 to D24 was removed from the message.', 'copy: removed')
  const text = serializeContext([{ version: 1, ref: { ...ref, id: 'r1', path: 'data.csv' } }], 'look', { packetId: null })
  ok(text.includes('Sheet ranges use A1 notation. In CSV and TSV files row 1 is the first record, and lines gives where those records are in the file.'), 'context: the sheet sentence')
  const back = parseRefs(text).refs[0]
  equal(back?.kind === 'current' ? JSON.stringify(back.value.ref) : '', JSON.stringify({ id: 'r1', kind: 'sheet', path: 'data.csv', sourceVersion: V, range: 'A18:D24', lines: { start: 18, end: 31 } }), 'context: it round-trips')
}

// The kind, the presentation and restored tabs
{
  for (const p of ['/w/a.csv', '/w/a.TSV', '/w/old.xls', '/w/bin.xlsb', '/w/c.ods']) equal(kindForPath(p), 'sheet', `kind: ${p} is a sheet`)
  equal(kindForPath('/w/a.xlsx'), 'file', 'kind: an .xlsx waits for the workbook reader')
  const csv = { kind: 'sheet' as const, key: '/w/a.csv' }
  equal(presentationOf(csv, false), 'preview', 'presentation: a CSV opens as its grid')
  equal(presentationOf({ ...csv, mode: 'source' }, false), 'source', 'presentation: Source on request')
  equal(presentationOf({ kind: 'sheet', key: '/w/old.xls' }, false), null, 'presentation: an .xls has no Source')
  ok(hasFind(null, csv) && hasFind(null, { ...csv, mode: 'source' }), 'find: the grid and its Source both find')
  ok(!hasFind(null, { kind: 'sheet', key: '/w/old.xls' }), 'find: an .xls state has none')
  ok(opensDefault('sheet', 'preview') && opensDefault('sheet', null) && !opensDefault('sheet', 'source'), 'external: the grid opens the default app, Source the editor')
  const view = { kind: 'file' as const, topLine: 40, offsetPx: 0, scrollLeft: 0 }
  const set: SavedSet = { order: ['file:/w/a.csv'], active: 'file:/w/a.csv', tabs: { 'file:/w/a.csv': { id: 'file:/w/a.csv', kind: 'file', key: '/w/a.csv', title: 'a.csv', openedBy: 'user', openedAt: 1, lastViewedAt: 1, viewState: view } } }
  const r = restoreKinds(set)
  equal(r.active, 'sheet:/w/a.csv', 'restore: a saved CSV file tab comes back as its sheet tab')
  const t = r.tabs['sheet:/w/a.csv']
  equal(JSON.stringify([t?.viewState, t?.sourceView]), JSON.stringify([undefined, view]), 'restore: its place moves to Source')
}

// The grid's geometry and its copy
{
  const { colAt, colRange, offsetsOf, readAs, readout, rowWindow, scrollSpace, scrollToRow, SCROLL_MAX, selectedLabel, selectedSaid } = await import('../src/renderer/src/lib/sheetView.ts')
  const off = offsetsOf([100, 50, 200], 4)
  equal(Array.from(off).join(','), '0,100,150,350,414', 'grid: offsets with a measured and a default width')
  equal(colAt(off, 149), 1, 'grid: the column under x')
  equal(colAt(off, 10_000), 3, 'grid: clamped past the last column')
  equal(colRange(off, 120, 100, 1).join(','), '0,3', 'grid: the shown columns with overscan')
  equal(JSON.stringify(scrollSpace(1000, 600)), JSON.stringify({ height: 24_000, k: 1 }), 'grid: a small sheet scrolls one to one')
  const big = scrollSpace(4_766_254, 600)
  ok(big.height === SCROLL_MAX && big.k > 3.8 && big.k < 3.82, `grid: 4.7M rows scale the scroll space under the limit (k ${big.k.toFixed(3)})`)
  const end = rowWindow(SCROLL_MAX - 600, 600, 4_766_254, big.k, 3)
  equal(end.r1, 4_766_253, 'grid: the bottom of a scaled scroll reaches the last row')
  const mid = rowWindow(1_000_000, 600, 4_766_254, big.k, 3)
  equal(mid.first, Math.floor((1_000_000 * big.k) / 24), 'grid: a scaled position maps to its true row')
  const one = scrollToRow(mid.first + 30, 1_000_000, 600, 4_766_254, big.k)
  ok(one !== null && Math.abs(rowWindow(one, 600, 4_766_254, big.k, 0).first + 24 - (mid.first + 30)) <= 1, 'grid: bringing a row below into view puts it at the bottom edge')
  equal(scrollToRow(mid.first + 3, 1_000_000, 600, 4_766_254, big.k), null, 'grid: a row in view needs no scroll')
  const a = (t: string) => parseA1(t)!
  equal(selectedLabel(a('A18:D24'), 100, 12), 'A18:D24 selected · 28 cells', 'copy: a range')
  equal(selectedLabel(a('B4'), 100, 12), 'B4 selected', 'copy: one cell')
  equal(selectedLabel(a('18:24'), 100, 12), 'Rows 18:24 selected · 84 cells', 'copy: rows')
  equal(selectedLabel(a('18:18'), 100, 12), 'Row 18 selected · 12 cells', 'copy: one row')
  equal(selectedLabel(a('B:D'), 100_000, 12), 'Columns B:D selected · 300,000 cells', 'copy: columns')
  equal(selectedSaid(a('A18:D24'), 100, 12), 'A18 to D24 selected, 28 cells', 'copy: said')
  equal(readAs('\t', false), 'Tabs, no header row', 'copy: read as')
  equal(readout(100_000, true, 12, false, 'UTF-8'), '100,000 rows · 12 columns · UTF-8', 'copy: readout')
  equal(readout(98_765, false, 12, true, 'Windows-1252'), 'About 99,000 rows · up to 12 columns · Windows-1252', 'copy: a provisional, ragged readout')
}
