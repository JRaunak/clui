// The grid's geometry: column offsets, which rows and columns a scroll position shows, and the scroll space scaled
// past Chromium's element height limit. Every row is ROW_H high.
import { a1Of, clampA1, spokenA1, type A1 } from '../../../shared/sheets'
import type { Delimiter } from '../../../shared/surfaces'

export const ROW_H = 24
/** Under Chromium's ~33.5M px element limit, with room for the header band. */
export const SCROLL_MAX = 30_000_000

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
export function scrollSpace(body: number, viewH: number): { height: number; k: number } {
  const full = body * ROW_H
  if (full <= SCROLL_MAX) return { height: full, k: 1 }
  return { height: SCROLL_MAX, k: Math.max(1, (full - viewH) / Math.max(1, SCROLL_MAX - viewH)) }
}

/** The body rows a scroll position shows: `v` is the virtual offset of the viewport's top, `first` the row at it, and
 *  `r0` to `r1` the rows drawn, `over` either side. */
export function rowWindow(top: number, viewH: number, body: number, k: number, over: number): { v: number; first: number; r0: number; r1: number } {
  const v = Math.max(0, Math.min(top * k, body * ROW_H - viewH))
  const first = Math.floor(v / ROW_H)
  return { v, first, r0: Math.max(0, first - over), r1: Math.min(body - 1, Math.ceil((v + viewH) / ROW_H) + over) }
}

/** The scrollTop that brings body row `j` into view at its nearest edge, or null when it's in view. */
export function scrollToRow(j: number, top: number, viewH: number, body: number, k: number): number | null {
  const v = top * k
  const y = j * ROW_H
  if (y >= v && y + ROW_H <= v + viewH) return null
  const want = y < v ? y : y + ROW_H - viewH
  return Math.max(0, Math.min(want, body * ROW_H - viewH)) / k
}

/** The scrollLeft that brings column `c` into view, or null when it's in view. */
export function scrollToCol(off: Float64Array, c: number, left: number, viewW: number): number | null {
  const a = off[c]
  const b = off[c + 1]
  if (a >= left && b <= left + viewW) return null
  return Math.max(0, a < left || b - a > viewW ? a : b - viewW)
}

export const rowHeaderW = (rows: number): number => Math.max(40, String(Math.max(1, rows)).length * 7 + 16)

const count = new Intl.NumberFormat('en-US')
export const cellCount = (a: A1, rows: number, cols: number): number => {
  const r = clampA1(a, rows, cols)
  return (r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1)
}

/** The SelectionBar's label: `A18:D24 selected · 28 cells`, `B4 selected`, `Rows 18:24 selected · 120 cells`. */
export function selectedLabel(a: A1, rows: number, cols: number): string {
  const n = cellCount(a, rows, cols)
  const at = a1Of(a)
  if (a.shape === 'cells') return n === 1 ? `${at} selected` : `${at} selected · ${count.format(n)} cells`
  const [x, y] = at.split(':')
  const what = a.shape === 'rows' ? 'Row' : 'Column'
  return `${x === y ? `${what} ${x}` : `${what}s ${at}`} selected · ${count.format(n)} ${n === 1 ? 'cell' : 'cells'}`
}

/** `A18 to D24 selected, 28 cells`. */
export function selectedSaid(a: A1, rows: number, cols: number): string {
  const n = cellCount(a, rows, cols)
  const what = spokenA1(a)
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} selected${n === 1 ? '' : `, ${count.format(n)} cells`}`
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
