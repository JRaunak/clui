// A Word view's text model: each part's paragraphs as one whitespace-collapsed string, and the quotes, occurrences and
// matches found in it. Pure, so it's testable without docx-preview or a DOM. A part can run to a megabyte of text, so
// it's flattened once into typed arrays rather than an object per character.
import { ELISION } from '../../../shared/context'
import type { NotePart, Unpacks } from '../../../shared/office'
import type { At } from './pdfView'

/** One paragraph's raw text. */
export interface Para { text: string }

/** A part's text, every run of whitespace and each paragraph break as one space. Character k of `text` came from
 *  paragraph `pi[k]` at offset `off[k]`; a space points at the character after it. */
export interface Flat { text: string; pi: Int32Array; off: Int32Array; folded: Map<(s: string) => string, string> }

// JavaScript's \s, by code unit, without a regex test per character.
const ws = (c: number): boolean =>
  c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff

export function flatten(paras: readonly Para[]): Flat {
  const n = paras.reduce((k, p) => k + p.text.length + 1, 0)
  const pi = new Int32Array(n)
  const off = new Int32Array(n)
  const out: string[] = []
  let k = 0
  let gap = false
  paras.forEach((p, i) => {
    gap = i > 0
    for (let o = 0; o < p.text.length; o++) {
      if (ws(p.text.charCodeAt(o))) {
        gap = true
        continue
      }
      if (gap && k) {
        out.push(' ')
        pi[k] = i
        off[k++] = o
      }
      gap = false
      out.push(p.text[o])
      pi[k] = i
      off[k++] = o
    }
  })
  return { text: out.join(''), pi: pi.subarray(0, k), off: off.subarray(0, k), folded: new Map() }
}

/** Folds each UTF-16 unit for matching, keeping every index: a fold that would change a unit's length leaves it. */
export const foldCase = (s: string): string => {
  const out: string[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 128) out.push(c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i])
    else {
      const l = s[i].toLowerCase()
      out.push(l.length === 1 ? l : s[i])
    }
  }
  return out.join('')
}
export const foldMarks = (s: string): string => {
  const low = foldCase(s)
  const out: string[] = []
  for (let i = 0; i < low.length; i++) {
    if (low.charCodeAt(i) < 128) {
      out.push(low[i])
      continue
    }
    const f = low[i].normalize('NFD').replace(/\p{M}+/gu, '')
    out.push(f.length === 1 ? f : low[i])
  }
  return out.join('')
}
const foldedOf = (f: Flat, fold: (s: string) => string): string => {
  let t = f.folded.get(fold)
  if (t === undefined) f.folded.set(fold, (t = fold(f.text)))
  return t
}

/** The first collapsed index at or after a raw position. */
function indexOf(f: Flat, at: At): number {
  let lo = 0
  let hi = f.text.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (f.pi[mid] < at.i || (f.pi[mid] === at.i && f.off[mid] < at.off)) lo = mid + 1
    else hi = mid
  }
  return lo
}
const rawAt = (f: Flat, k: number): At => ({ i: f.pi[k], off: f.off[k] })
const rawEnd = (f: Flat, k: number): At => ({ i: f.pi[k], off: f.off[k] + 1 })
const count = (text: string, quote: string, upto: number): number => {
  let n = 0
  for (let k = text.indexOf(quote); k >= 0 && k < upto; k = text.indexOf(quote, k + 1)) n++
  return n
}

/** The quote between two raw positions, trimmed, with its occurrence in the whole part and the paragraphs it spans. */
export function quoteIn(f: Flat, a: At, b: At): { text: string; nth: number; first: number; last: number } | null {
  let s = indexOf(f, a)
  let e = indexOf(f, b)
  while (s < e && f.text[s] === ' ') s++
  while (e > s && f.text[e - 1] === ' ') e--
  if (s >= e) return null
  const quote = f.text.slice(s, e)
  return { text: quote, nth: count(f.text, quote, s), first: f.pi[s], last: f.pi[e - 1] }
}

/** Every match of `query`, as raw positions end exclusive, through `fold` on both sides; non-overlapping. */
export function matchesIn(f: Flat, query: string, fold: (s: string) => string, max = Infinity): { a: At; b: At }[] {
  const q = fold(query.replace(/\s+/g, ' ').trim())
  if (!q || max <= 0) return []
  const t = foldedOf(f, fold)
  const out: { a: At; b: At }[] = []
  for (let k = t.indexOf(q); k >= 0 && out.length < max; k = t.indexOf(q, k + q.length)) out.push({ a: rawAt(f, k), b: rawEnd(f, k + q.length - 1) })
  return out
}

/** Where the `nth` occurrence of a reference's quote lies. A quote cut to its start and end matches its start there
 *  and its end after it. */
export function locateIn(f: Flat, quote: string, nth: number): { a: At; b: At } | null {
  const find = (head: string): number => {
    let n = 0
    for (let k = f.text.indexOf(head); k >= 0; k = f.text.indexOf(head, k + 1)) if (n++ === nth) return k
    return -1
  }
  const whole = find(quote)
  if (whole >= 0) return { a: rawAt(f, whole), b: rawEnd(f, whole + quote.length - 1) }
  const cut = quote.indexOf(ELISION)
  if (cut < 0) return null
  const head = quote.slice(0, cut)
  const tail = quote.slice(cut + ELISION.length)
  const k = find(head)
  const t = k < 0 ? -1 : f.text.indexOf(tail, k + head.length)
  return t < 0 ? null : { a: rawAt(f, k), b: rawEnd(f, t + tail.length - 1) }
}

/** How often `quote` occurs in the part, so a selection survives a new version only where it's still unique. */
export const occurrences = (f: Flat, quote: string): number => count(f.text, quote, Infinity)

/** Claude's text as its row quotes it: the first 40 characters, `…` when there's more. */
export const clip40 = (s: string): string => {
  const cp = [...s.replace(/\s+/g, ' ').trim()]
  return cp.length > 40 ? `${cp.slice(0, 40).join('')}…` : cp.join('')
}

/** `{n}` in the too-long sentence: MB to one decimal, rounded up, so a file just over the cap never reads 1.0 MB. */
export const megabytes = (bytes: number): string => (Math.ceil(bytes / 100_000) / 10).toFixed(1)

/** Each note reference's number in reading order: footnotes count on through the document, endnotes on their own, and
 *  a custom mark takes none. */
export function noteNumbers(marks: readonly { part: NotePart; custom: boolean }[]): (number | null)[] {
  const n = { footnotes: 0, endnotes: 0 }
  return marks.map((m) => (m.custom ? null : ++n[m.part]))
}

const ROMAN: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
/** Word's default endnote mark: i, ii, iii. */
export function lowerRoman(n: number): string {
  let out = ''
  for (const [v, r] of ROMAN) for (; n >= v; n -= v) out += r
  return out
}

/** Why a package is refused before it's unpacked, as the state's detail. MB here are the 1,048,576-byte kind the
 *  512 MB bound is set in, rounded up to one decimal. */
export function unpackDetail(u: Unpacks): string {
  if (u.bound === 'entries') return `It has ${u.n.toLocaleString('en-US')} internal parts, and Clui opens documents with up to 10,000.`
  if (u.bound === 'unzipped') return `It unpacks to ${(Math.ceil(u.n / 104_857.6) / 10).toLocaleString('en-US', { minimumFractionDigits: 1 })} MB. Clui opens documents that unpack to 512 MB or less.`
  return 'Part of it expands to over 200 times its saved size when unpacked, more than Clui opens.'
}
