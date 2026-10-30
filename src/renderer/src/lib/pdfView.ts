// The PDF surface's view model: its zoom stops and fits, which page is current, and the text a selection quotes and
// finds again. Pure, so it's testable without pdf.js or a DOM.
import { ELISION } from '../../../shared/context'
import { FIT_MARGIN, type Size } from './imageView'

export const PDF_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]
export const PDF_MAX = 4
export type DocZoom = number | 'fit-width' | 'fit-page'
const EPS = 1e-6

/** The widest of `widths` (pages in view at 100%) across the viewport less its padding, never past the largest zoom. */
export const fitWidth = (widths: readonly number[], vpW: number): number => Math.min(PDF_MAX, Math.max(EPS, (vpW - 2 * FIT_MARGIN) / Math.max(1, ...widths)))

/** The whole page, width and height, less the padding each way. `page` at 100%. */
export const fitPage = (page: Size, vp: Size): number => Math.min(PDF_MAX, Math.max(EPS, Math.min((vp.w - 2 * FIT_MARGIN) / page.w, (vp.h - 2 * FIT_MARGIN) / page.h)))

/** Each page box's top and height down the column, in order. */
export interface Box { top: number; h: number }

/** The page covering `y`, or in a gap the page below it; the last page past the end. */
export function pageAt(boxes: readonly Box[], y: number): number {
  let lo = 0
  let hi = boxes.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (boxes[mid].top + boxes[mid].h < y) lo = mid + 1
    else hi = mid
  }
  return Math.max(0, lo)
}

/** PageDown's target: the first page whose top is below `top`. Past the last page, the last. */
export const nextPage = (boxes: readonly Box[], top: number): number => {
  const i = boxes.findIndex((b) => b.top > top + 1)
  return i < 0 ? boxes.length - 1 : i
}

/** PageUp's target: the last page whose top is above `top`, else the first. */
export const prevPage = (boxes: readonly Box[], top: number): number => Math.max(0, boxes.findLastIndex((b) => b.top < top - 1))

/** The fraction of page `i` at `y`, which a restore puts back at the viewport's centre. */
export const offsetIn = (b: Box, y: number): number => Math.min(1, Math.max(0, (y - b.top) / Math.max(1, b.h)))

/** One page's text layer as plain text: its text nodes in order, a line break where pdf.js puts a `<br>`. */
export interface PageText { page: number; text: string }
/** A position in that text: the index into the pages given and the offset into its text. */
export interface At { i: number; off: number }

/** The pages' text with every run of whitespace, and each page break, as one space; `from[k]` is where character k of
 *  it came from. A space points at the character after it. */
export function collapse(pages: readonly PageText[]): { text: string; from: At[] } {
  let text = ''
  const from: At[] = []
  for (const [i, p] of pages.entries()) {
    let gap = i > 0
    for (let off = 0; off < p.text.length; off++) {
      if (/\s/.test(p.text[off])) {
        gap = true
        continue
      }
      if (gap && text) {
        text += ' '
        from.push({ i, off })
      }
      gap = false
      text += p.text[off]
      from.push({ i, off })
    }
  }
  return { text, from }
}

const before = (a: At, b: At): boolean => a.i < b.i || (a.i === b.i && a.off < b.off)

/** The first collapsed index at or after `at`. */
const indexOf = (from: readonly At[], at: At): number => {
  const k = from.findIndex((f) => !before(f, at))
  return k < 0 ? from.length : k
}

/** The quote between two positions, collapsed and trimmed, and which occurrence of it on its first page it is. */
export function quoteBetween(pages: readonly PageText[], a: At, b: At): { text: string; nth: number; i: number; endI: number } | null {
  const { text, from } = collapse(pages)
  let s = indexOf(from, a)
  let e = indexOf(from, b)
  while (s < e && text[s] === ' ') s++
  while (e > s && text[e - 1] === ' ') e--
  if (s >= e) return null
  const quote = text.slice(s, e)
  const i = from[s].i
  let nth = 0
  for (let k = text.indexOf(quote); k >= 0 && k < s; k = text.indexOf(quote, k + 1)) if (from[k].i === i) nth++
  return { text: quote, nth, i, endI: from[e - 1].i }
}

/** Where `quote`'s `nth` occurrence starting on page index `i` lies, as raw positions, end exclusive. A quote cut to
 *  its start and end matches its start there and its end after it. */
export function locate(pages: readonly PageText[], quote: string, nth: number, i: number): { a: At; b: At } | null {
  const { text, from } = collapse(pages)
  const end = (k: number): At => ({ i: from[k].i, off: from[k].off + 1 })
  const find = (head: string): number => {
    let n = 0
    for (let k = text.indexOf(head); k >= 0; k = text.indexOf(head, k + 1)) {
      if (from[k].i !== i) continue
      if (n++ === nth) return k
    }
    return -1
  }
  const whole = find(quote)
  if (whole >= 0) return { a: from[whole], b: end(whole + quote.length - 1) }
  const cut = quote.indexOf(ELISION)
  if (cut < 0) return null
  const head = quote.slice(0, cut)
  const tail = quote.slice(cut + ELISION.length)
  const k = find(head)
  const t = k < 0 ? -1 : text.indexOf(tail, k + head.length)
  return t < 0 ? null : { a: from[k], b: end(t + tail.length - 1) }
}

/** A page's lines as raw ranges, end exclusive: runs of text up to a line break, blank ones skipped. */
export function linesOf(text: string): [number, number][] {
  const out: [number, number][] = []
  let start = 0
  for (let k = 0; k <= text.length; k++) {
    if (k < text.length && text[k] !== '\n') continue
    if (text.slice(start, k).trim()) out.push([start, k])
    start = k + 1
  }
  return out
}

/** `Fit width, 84%`, `Zoom 150%`, `Zoom 400%, the largest`. */
export function zoomSaid(s: number, mode: DocZoom, min: number, pct: (s: number) => string): string {
  if (mode === 'fit-width') return `Fit width, ${pct(s)}`
  if (mode === 'fit-page') return `Fit page, ${pct(s)}`
  if (s >= PDF_MAX - EPS) return `Zoom ${pct(s)}, the largest`
  return s <= min + EPS ? `Zoom ${pct(s)}, the smallest` : `Zoom ${pct(s)}`
}
