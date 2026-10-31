// The grid's geometry: column offsets, which rows and columns a scroll position shows, and the scroll space scaled
// past Chromium's element height limit. A CSV's rows are all ROW_H; a workbook's come as offsets.
import { a1Of, clampA1, qualified, spokenA1, type A1, type SheetGaps } from '../../../shared/sheets'
import type { Delimiter } from '../../../shared/surfaces'

export const ROW_H = 24
/** Under Chromium's ~33.5M px element limit, with room for the header band. */
export const SCROLL_MAX = 30_000_000

/** Rows' tops from the first, then the total; null when every row is ROW_H. */
export type Off = Float64Array | null
export const topOf = (off: Off, j: number): number => (off ? off[j] : j * ROW_H)
export const heightOf = (off: Off, j: number): number => topOf(off, j + 1) - topOf(off, j)
/** The row whose span holds `y`, clamped to the `n` rows. */
export const rowAt = (off: Off, y: number, n: number): number => (off ? colAt(off, y) : Math.max(0, Math.min(n - 1, Math.floor(y / ROW_H))))
/** Prefix sums of `n` sizes. */
export function prefix(n: number, size: (i: number) => number): Float64Array {
  const off = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) off[i + 1] = off[i] + size(i)
  return off
}

/** Each column's left edge, then the total width. */
export function offsetsOf(widths: readonly number[] | undefined, cols: number): Float64Array {
  const off = new Float64Array(cols + 1)
  for (let c = 0; c < cols; c++) off[c + 1] = off[c] + (widths?.[c] ?? 64)
  return off
}

/** The column whose span holds `x`, clamped to the sheet. */
export function colAt(off: Float64Array, x: number): number {
  let lo = 0
  let hi = off.length - 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (off[mid] <= x) lo = mid
    else hi = mid - 1
  }
  return Math.max(0, lo)
}

/** The columns `left` to `left + width` show, with `over` more on each side. */
export function colRange(off: Float64Array, left: number, width: number, over: number): [number, number] {
  const last = off.length - 2
  if (last < 0) return [0, -1]
  return [Math.max(0, colAt(off, left) - over), Math.min(last, colAt(off, left + width) + over)]
}

/** Scroll space for `body` rows under a `viewH` viewport: its height, and `k` virtual px per scrolled px, 1 until the
 *  rows pass SCROLL_MAX. */
export function scrollSpace(body: number, viewH: number, off: Off = null): { height: number; k: number } {
  const full = topOf(off, body)
  if (full <= SCROLL_MAX) return { height: full, k: 1 }
  return { height: SCROLL_MAX, k: Math.max(1, (full - viewH) / Math.max(1, SCROLL_MAX - viewH)) }
}

/** The body rows a scroll position shows: `v` is the virtual offset of the viewport's top, `first` the row at it, and
 *  `r0` to `r1` the rows drawn, `over` either side. */
export function rowWindow(top: number, viewH: number, body: number, k: number, over: number, off: Off = null): { v: number; first: number; r0: number; r1: number } {
  const v = Math.max(0, Math.min(top * k, topOf(off, body) - viewH))
  const first = rowAt(off, v, body)
  const last = off ? rowAt(off, v + viewH, body) : Math.ceil((v + viewH) / ROW_H)
  return { v, first, r0: Math.max(0, first - over), r1: Math.min(body - 1, last + over) }
}

/** The scrollTop that brings body row `j` into view at its nearest edge, or null when it's in view. */
export function scrollToRow(j: number, top: number, viewH: number, body: number, k: number, off: Off = null): number | null {
  const v = top * k
  const y = topOf(off, j)
  const h = heightOf(off, j)
  if (y >= v && y + h <= v + viewH) return null
  const want = y < v || h > viewH ? y : y + h - viewH
  return Math.max(0, Math.min(want, topOf(off, body) - viewH)) / k
}

/** The scrollLeft that brings column `c` into view, or null when it's in view. `fw`: the frozen columns' width, which
 *  the scrolling ones pass under. */
export function scrollToCol(off: Float64Array, c: number, left: number, viewW: number, fw = 0): number | null {
  const a = off[c] - fw
  const b = off[c + 1] - fw
  const w = viewW - fw
  if (a >= left && b <= left + w) return null
  return Math.max(0, a < left || b - a > w ? a : b - w)
}

export const rowHeaderW = (rows: number): number => Math.max(40, String(Math.max(1, rows)).length * 7 + 16)

const count = new Intl.NumberFormat('en-US')
export const cellCount = (a: A1, rows: number, cols: number): number => {
  const r = clampA1(a, rows, cols)
  return (r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1)
}

/** The SelectionBar's label: `A18:D24 selected · 28 cells`, `B4 selected`, `Rows 18:24 selected · 120 cells`; in a
 *  workbook the reference as written, `Summary!A18:D24 selected · 28 cells · with values`, `Summary!18:18 selected · 12 cells`. */
export function selectedLabel(a: A1, rows: number, cols: number, sheet?: string, values = false): string {
  const n = cellCount(a, rows, cols)
  const at = a1Of(a)
  const tail = values ? ' · with values' : ''
  const cells = `${count.format(n)} ${n === 1 ? 'cell' : 'cells'}`
  if (a.shape === 'cells') return `${qualified(at, sheet)} selected${n === 1 ? '' : ` · ${cells}`}${tail}`
  if (sheet !== undefined) return `${qualified(at, sheet)} selected · ${cells}${tail}`
  const [x, y] = at.split(':')
  const what = a.shape === 'rows' ? 'Row' : 'Column'
  return `${x === y ? `${what} ${x}` : `${what}s ${at}`} selected · ${cells}${tail}`
}

/** `A18 to D24 selected, 28 cells`; `Summary, A18 to D24 selected, 28 cells, with values`. */
export function selectedSaid(a: A1, rows: number, cols: number, sheet?: string, values = false): string {
  const n = cellCount(a, rows, cols)
  const said = `${spokenA1(a)} selected${n === 1 ? '' : `, ${count.format(n)} cells`}${values ? ', with values' : ''}`
  return sheet === undefined ? `${said.charAt(0).toUpperCase()}${said.slice(1)}` : `${sheet}, ${said}`
}


const NAMES: Record<Delimiter, string> = { ',': 'Commas', ';': 'Semicolons', '\t': 'Tabs', '|': 'Pipes' }
export const delimiterName = (d: Delimiter): string => NAMES[d]
/** `Commas, header row`, `Tabs, no header row`. */
export const readAs = (d: Delimiter, header: boolean): string => `${NAMES[d]}, ${header ? 'header row' : 'no header row'}`

/** `100,000 rows · 12 columns · UTF-8`; `About` while the count is still an estimate. */
export function readout(rows: number, exact: boolean, cols: number, ragged: boolean, encoding: string): string {
  const r = exact ? rows : Number(rows.toPrecision(2))
  return `${exact ? '' : 'About '}${count.format(r)} ${r === 1 ? 'row' : 'rows'} · ${ragged ? 'up to ' : ''}${count.format(cols)} ${cols === 1 ? 'column' : 'columns'} · ${encoding}`
}

export const fmt = (n: number): string => count.format(n)

/** `140,000 rows · 10 columns`. */
export const bookReadout = (rows: number, cols: number): string => `${count.format(rows)} ${rows === 1 ? 'row' : 'rows'} · ${count.format(cols)} ${cols === 1 ? 'column' : 'columns'}`

/** `about 3.2 million`, the predicted size of a workbook past the ceiling. */
export const millions = (n: number): string => `about ${n >= 10_000_000 ? Math.round(n / 1e6) : (Math.round(n / 1e5) / 10).toFixed(1)} million`

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many).replace('{n}', count.format(n))
/** What the not-shown panel says about a sheet; `hidden` is said by the caller, which owns the Show them button. */
export function sheetGaps(g: SheetGaps): string[] {
  return [
    g.charts > 0 && plural(g.charts, "1 chart isn't shown.", "{n} charts aren't shown."),
    g.images + g.shapes > 0 &&
      (!g.shapes ? plural(g.images, "1 image isn't shown.", "{n} images aren't shown.") : !g.images ? plural(g.shapes, "1 shape isn't shown.", "{n} shapes aren't shown.") : `${count.format(g.images + g.shapes)} images and shapes aren't shown.`),
    g.pivots > 0 && plural(g.pivots, "1 pivot table shows its saved values. Clui doesn't refresh it.", "{n} pivot tables show their saved values. Clui doesn't refresh them."),
    g.uncalculated > 0 && plural(g.uncalculated, '1 formula has no saved result, so it shows as a formula.', '{n} formulas have no saved result, so they show as formulas.'),
    g.cf && "Some conditional formatting isn't shown.",
    g.notes && "Cell notes aren't shown.",
    g.validation && "Data validation isn't shown.",
    g.sparklines && "Sparklines aren't shown.",
    g.slicers && "Slicers aren't shown.",
    g.controls && "Form controls aren't shown.",
    g.fonts && "Fonts and text sizes use Clui's."
  ].filter((x): x is string => !!x)
}
/** `3 hidden rows and 1 hidden column.` */
export function hiddenSaid(rows: number, cols: number): string | null {
  const r = rows ? plural(rows, '1 hidden row', '{n} hidden rows') : ''
  const c = cols ? plural(cols, '1 hidden column', '{n} hidden columns') : ''
  return r || c ? `${[r, c].filter(Boolean).join(' and ')}.` : null
}
export function bookGaps(b: { macros: boolean; links: boolean; recalc: boolean }): string[] {
  return [
    b.recalc && 'The file asks to be recalculated when opened, so saved results may be out of date.',
    b.macros && 'This workbook contains macros. Clui never runs them.',
    b.links && 'This workbook links to other files. Clui never updates the links.'
  ].filter((x): x is string => !!x)
}
