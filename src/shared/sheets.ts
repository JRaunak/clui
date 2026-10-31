// What a sheet tab shows, whatever read it: A1 ranges, the window DTOs a reader returns, and the text a selection
// copies as. CSV/TSV and workbooks produce the same shapes.

/** One sheet of a workbook, or the one sheet a CSV is. `frozen`: the bands that don't scroll. */
export interface SheetInfo {
  id: string
  name: string
  rows: number
  cols: number
  frozen?: { rows: number; cols: number }
}
export interface SheetModel {
  resourceId: string
  revision: string
  sheets: SheetInfo[]
}
export type ValueState = 'value' | 'cached-formula' | 'not-calculated' | 'error'
export interface SheetCell {
  row: number
  col: number
  /** Display text, at most CELL_TEXT_MAX characters; `long` when the value runs past it. */
  value: string
  long?: true
  formula?: string
  valueState: ValueState
  styleId?: number
}
export interface SheetWindow {
  revision: string
  r0: number
  r1: number
  c0: number
  c1: number
  rowHeights: { index: number; px: number }[]
  columnWidths: { index: number; px: number }[]
  /** Non-empty cells only. */
  cells: SheetCell[]
  merges: { row: number; col: number; rows: number; cols: number; anchorValue: string; anchorStyleId?: number }[]
  /** CSV: each row's field count, from r0, so a missing trailing field reads differently from an empty one. */
  fields?: number[]
}

export const CELL_TEXT_MAX = 1000
/** The most of one cell the formula bar shows. */
export const CELL_FULL_MAX = 64 * 1024
export const COPY_MAX = 10_000
/** The most of a CSV Clui reads; past it the grid shows the records inside this many bytes. */
export const CSV_BYTES_MAX = 200 * 1024 * 1024
export const ROW_MAX = 100_000_000
export const COL_MAX = 1_000_000

export const isDelimited = (p: string): boolean => /\.(csv|tsv)$/i.test(p)

/** 0-based and inclusive. A whole-row or whole-column range has the other axis open, as `Infinity`. */
export interface Rect {
  r0: number
  c0: number
  r1: number
  c1: number
}
export type A1 = Rect & { shape: 'cells' | 'rows' | 'cols' }

/** `0` → `A`, `26` → `AA`. */
export function colName(c: number): string {
  let s = ''
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}
/** `A` → 0; -1 past COL_MAX. */
export function colIndex(s: string): number {
  let n = 0
  for (const ch of s) {
    n = n * 26 + ch.charCodeAt(0) - 64
    if (n > COL_MAX) return -1
  }
  return n - 1
}

const CELL = /^([A-Z]{1,5})([1-9]\d{0,8})$/
const ROWS = /^([1-9]\d{0,8}):([1-9]\d{0,8})$/
const COLS = /^([A-Z]{1,5}):([A-Z]{1,5})$/

function cellOf(s: string): { r: number; c: number } | null {
  const m = CELL.exec(s)
  if (!m) return null
  const c = colIndex(m[1])
  const r = Number(m[2]) - 1
  return c < 0 || r >= ROW_MAX ? null : { r, c }
}

/** `B4`, `A18:D24`, `18:24`, `B:D`, any case; corners in either order. Null for anything else. */
export function parseA1(text: string): A1 | null {
  const s = text.trim().toUpperCase()
  const rows = ROWS.exec(s)
  if (rows) {
    const [a, b] = [Number(rows[1]) - 1, Number(rows[2]) - 1]
    return a >= ROW_MAX || b >= ROW_MAX ? null : { shape: 'rows', r0: Math.min(a, b), r1: Math.max(a, b), c0: 0, c1: Infinity }
  }
  const cols = COLS.exec(s)
  if (cols) {
    const [a, b] = [colIndex(cols[1]), colIndex(cols[2])]
    return a < 0 || b < 0 ? null : { shape: 'cols', c0: Math.min(a, b), c1: Math.max(a, b), r0: 0, r1: Infinity }
  }
  const [x, y, more] = s.split(':')
  if (more !== undefined) return null
  const a = cellOf(x)
  const b = y === undefined ? a : cellOf(y)
  if (!a || !b) return null
  return { shape: 'cells', r0: Math.min(a.r, b.r), r1: Math.max(a.r, b.r), c0: Math.min(a.c, b.c), c1: Math.max(a.c, b.c) }
}

export function a1Of(a: A1): string {
  if (a.shape === 'rows') return `${a.r0 + 1}:${a.r1 + 1}`
  if (a.shape === 'cols') return `${colName(a.c0)}:${colName(a.c1)}`
  const tl = `${colName(a.c0)}${a.r0 + 1}`
  return a.r0 === a.r1 && a.c0 === a.c1 ? tl : `${tl}:${colName(a.c1)}${a.r1 + 1}`
}

/** The range inside a sheet of `rows` by `cols`, open axes closed. */
export const clampA1 = (a: A1, rows: number, cols: number): Rect => ({
  r0: a.r0,
  c0: a.c0,
  r1: Math.min(a.r1, Math.max(0, rows - 1)),
  c1: Math.min(a.c1, Math.max(0, cols - 1))
})

/** `B4`, `A18 to D24`, `rows 18 to 24`, `column B`. */
export function spokenA1(a: A1): string {
  const [x, y] = a1Of(a).split(':')
  if (a.shape === 'cells') return y ? `${x} to ${y}` : x
  const what = a.shape === 'rows' ? 'row' : 'column'
  return x === y ? `${what} ${x}` : `${what}s ${x} to ${y}`
}

// A name Excel writes bare: a letter or underscore, then word characters and dots, and not itself a cell address.
const BARE = /^[A-Za-z_][A-Za-z0-9_.]*$/
/** `Summary!A18:D24`, `'Q1 sales'!A18`, or the range alone without a sheet. */
export const qualified = (range: string, sheet?: string): string =>
  sheet === undefined ? range : `${BARE.test(sheet) && !CELL.test(sheet.toUpperCase()) ? sheet : `'${sheet.replace(/'/g, "''")}'`}!${range}`

/** Rows of displayed text as compact TSV: a tab or line break inside a value becomes a space. */
export const tsvOf = (rows: readonly (readonly string[])[]): string => rows.map((r) => r.map((v) => v.replace(/\r\n|[\t\r\n]/g, ' ')).join('\t')).join('\n')
