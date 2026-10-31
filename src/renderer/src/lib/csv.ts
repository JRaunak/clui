// A CSV or TSV read into one byte buffer and indexed by record as it arrives. The index keeps every 64th record's byte
// offset and first line, never decoded text; windows, cells, find and copy parse from the nearest checkpoint.
import { CELL_FULL_MAX, CELL_TEXT_MAX, type SheetCell, type SheetWindow } from '../../../shared/sheets'
import type { Delimiter } from '../../../shared/surfaces'

export type Encoding = 'UTF-8' | 'UTF-16' | 'Windows-1252'

export interface CsvFacts {
  /** Records indexed so far; final once `done`. */
  records: number
  /** File bytes taken in so far, of `total`. */
  bytes: number
  total: number
  size: number
  done: boolean
  /** The widest record's field count, and the narrowest's. */
  cols: number
  minFields: number
  encoding: Encoding
  delimiter: Delimiter
  detected: { delimiter: Delimiter; header: boolean }
  /** The record that opens a quote nothing closes, so it runs to the end of the file. */
  unclosed?: number
  /** Per column, from the first records: width in px, and whether its data reads as numbers. */
  widths?: number[]
  numeric?: boolean[]
}

const K = 64
const QUOTE = 0x22
const LF = 0x0a
const CR = 0x0d
const SNIFF_BYTES = 64 * 1024
const SNIFF_RECORDS = 20
const SAMPLE = 200
const DELIMS: Delimiter[] = [',', ';', '\t', '|']
const NUMBER = /^[+-]?[$€£¥]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?([eE][+-]?\d+)?%?$/

export const isNumber = (s: string): boolean => NUMBER.test(s.trim())

/** A field as the grid draws it: its line breaks joined with ↵. */
export const oneLine = (s: string): string => s.replace(/\r?\n/g, ' ↵ ')

/** For each candidate, the count outside quotes in each of the first records; the candidate whose non-zero count
 *  repeats in the most records wins, ties to the comma. */
export function sniff(b: Uint8Array): Delimiter {
  const counts: number[][] = DELIMS.map(() => [0])
  const codes = DELIMS.map((d) => d.charCodeAt(0))
  let q = false
  for (let i = 0; i < b.length; i++) {
    const c = b[i]
    if (c === QUOTE) q = !q
    else if (q) continue
    else if (c === LF) {
      if (counts[0].length >= SNIFF_RECORDS) break
      for (const row of counts) row.push(0)
    } else {
      const k = codes.indexOf(c)
      if (k >= 0) counts[k][counts[k].length - 1]++
    }
  }
  let best: Delimiter = ','
  let bestN = 0
  DELIMS.forEach((d, k) => {
    const tally = new Map<number, number>()
    for (const n of counts[k]) if (n) tally.set(n, (tally.get(n) ?? 0) + 1)
    const n = Math.max(0, ...tally.values())
    if (n > bestN) [best, bestN] = [d, n]
  })
  return best
}

/** Row 1 is a header when none of its fields is empty or a number, and a column below it is mostly numbers or row
 *  1's names are distinct where some column below repeats. */
export function guessHeader(rows: readonly (readonly string[])[], numeric: readonly boolean[]): boolean {
  const [head, ...data] = rows
  if (!head || !data.length) return false
  const cols = Math.max(...rows.map((r) => r.length))
  if (head.length < cols || head.some((f) => !f.trim() || isNumber(f))) return false
  if (numeric.some(Boolean)) return true
  if (new Set(head).size !== head.length) return false
  for (let c = 0; c < cols; c++) {
    const seen = new Set<string>()
    for (const r of data) {
      const v = r[c] ?? ''
      if (seen.has(v)) return true
      seen.add(v)
    }
  }
  return false
}

/** Per column, at least 90% of its first non-empty data fields are numbers. */
export function numericColumns(data: readonly (readonly string[])[], cols: number): boolean[] {
  return Array.from({ length: cols }, (_, c) => {
    let n = 0
    let nums = 0
    for (const r of data) {
      const v = r[c]
      if (!v?.trim()) continue
      n++
      if (isNumber(v)) nums++
      if (n === SAMPLE) break
    }
    return n > 0 && nums >= n * 0.9
  })
}

class Grow {
  off = new Float64Array(1024)
  ln = new Float64Array(1024)
  n = 0
  push(o: number, l: number): void {
    if (this.n === this.off.length) {
      const grow = (a: Float64Array<ArrayBuffer>): Float64Array<ArrayBuffer> => {
        const b = new Float64Array(a.length * 2)
        b.set(a)
        return b
      }
      this.off = grow(this.off)
      this.ln = grow(this.ln)
    }
    this.off[this.n] = o
    this.ln[this.n++] = l
  }
}

/** One record parsed from `at`: its fields' byte pieces, where the next record starts, and the line breaks inside it. */
interface Parsed {
  fields: [number, number][][]
  next: number
  breaks: number
}

export class CsvIndex {
  buf: Uint8Array
  len = 0
  facts: CsvFacts
  private head = true
  private valid: TextDecoder | null = new TextDecoder('utf-8', { fatal: true })
  private utf16: TextDecoder | null = null
  private enc = new TextEncoder()
  private text = new TextDecoder('utf-8')
  private delimSet = false
  private measure: (s: string) => number
  // Scan state, carried across chunks.
  private pos = 0
  private inQuote = false
  private pendingQuote = false
  private fieldStart = true
  private fields = 0
  private line = 1
  private recLine = 1
  private recStart = 0
  private cp = new Grow()

  constructor(size: number, total: number, opts: { delimiter?: Delimiter; measure: (s: string) => number }) {
    this.buf = new Uint8Array(total)
    this.measure = opts.measure
    const d = opts.delimiter ?? ','
    this.delimSet = !!opts.delimiter
    this.facts = { records: 0, bytes: 0, total, size, done: false, cols: 0, minFields: 0, encoding: 'UTF-8', delimiter: d, detected: { delimiter: d, header: false } }
  }

  /** Takes the next bytes in file order; `done` with the last. A UTF-16 file is kept as UTF-8, so its offsets are into
   *  that, not the file; its lines are the same. */
  push(chunk: Uint8Array, done: boolean): void {
    let b = chunk
    if (this.head) {
      this.head = false
      if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3)
      else if ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff)) {
        this.utf16 = new TextDecoder(b[0] === 0xff ? 'utf-16le' : 'utf-16be')
        this.facts.encoding = 'UTF-16'
        this.valid = null
        this.buf = new Uint8Array(Math.ceil(this.facts.total * 1.5) + 4)
        b = b.subarray(2)
      }
    }
    this.facts.bytes += chunk.length
    if (this.utf16) this.append(this.enc.encode(this.utf16.decode(b, { stream: !done })))
    else {
      if (this.valid) {
        try {
          this.valid.decode(b, { stream: !done })
        } catch {
          this.valid = null
          this.facts.encoding = 'Windows-1252'
          this.text = new TextDecoder('windows-1252')
        }
      }
      this.append(b)
    }
    this.facts.done = done
    if (!this.delimSet && (this.len >= SNIFF_BYTES || done)) {
      this.delimSet = true
      this.facts.delimiter = this.facts.detected.delimiter = sniff(this.buf.subarray(0, Math.min(this.len, SNIFF_BYTES)))
    }
    if (this.delimSet) this.scan()
  }

  /** Read again with another delimiter: the bytes stay, the index starts over. */
  redelimit(d: Delimiter): void {
    this.pos = this.fields = this.recStart = 0
    this.line = this.recLine = 1
    this.inQuote = this.pendingQuote = false
    this.fieldStart = true
    this.cp = new Grow()
    const { widths: _w, numeric: _n, unclosed: _u, ...keep } = this.facts
    this.facts = { ...keep, delimiter: d, records: 0, cols: 0, minFields: 0 }
    this.delimSet = true
    this.scan()
  }

  private append(b: Uint8Array): void {
    if (this.len + b.length > this.buf.length) {
      const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + b.length))
      next.set(this.buf.subarray(0, this.len))
      this.buf = next
    }
    this.buf.set(b, this.len)
    this.len += b.length
  }

  private endRecord(next: number): void {
    const f = this.facts
    const n = this.fields + 1
    if (!f.records) f.cols = f.minFields = n
    else {
      if (n > f.cols) f.cols = n
      if (n < f.minFields) f.minFields = n
    }
    if (f.records % K === 0) this.cp.push(this.recStart, this.recLine)
    f.records++
    this.fields = 0
    this.recStart = next
    this.recLine = this.line
  }

  private scan(): void {
    const b = this.buf
    const delim = this.facts.delimiter.charCodeAt(0)
    let i = this.pos
    for (; i < this.len; i++) {
      const c = b[i]
      if (this.pendingQuote) {
        this.pendingQuote = false
        if (c === QUOTE) continue
        this.inQuote = false
      }
      if (this.inQuote) {
        if (c === QUOTE) this.pendingQuote = true
        else if (c === LF) this.line++
        continue
      }
      if (c === QUOTE) {
        if (this.fieldStart) this.inQuote = true
        this.fieldStart = false
      } else if (c === delim) {
        this.fields++
        this.fieldStart = true
      } else if (c === LF) {
        this.line++
        this.fieldStart = true
        this.endRecord(i + 1)
      } else this.fieldStart = false
    }
    this.pos = i
    const f = this.facts
    if (!f.done) return this.sample()
    // The last record has no line break after it, unless the read stopped at the ceiling inside it.
    const cut = f.size > f.total
    if (this.recStart < this.len && !cut) {
      if (this.inQuote && !this.pendingQuote) f.unclosed = f.records
      this.endRecord(this.len)
    }
    this.sample()
  }

  /** Widths, number columns and the header guess, once the first records are in. */
  private sample(): void {
    const f = this.facts
    if (f.widths || (f.records <= SAMPLE && !f.done) || !f.records) return
    const rows = this.rows(0, Math.min(f.records, SAMPLE + 1) - 1, CELL_TEXT_MAX)
    f.numeric = numericColumns(rows.slice(1), f.cols)
    f.detected.header = guessHeader(rows, f.numeric)
    f.widths = Array.from({ length: f.cols }, (_, c) => {
      let w = 0
      for (const r of rows) {
        const v = r[c]
        if (v) w = Math.max(w, this.measure(oneLine(v.slice(0, 64))))
      }
      return Math.min(320, Math.max(64, Math.ceil(w) + 12))
    })
  }

  /** Where record `r` starts, and its first line. */
  private seek(r: number): { at: number; line: number } {
    const k = Math.min(Math.floor(r / K), this.cp.n - 1)
    let at = this.cp.off[k]
    let line = this.cp.ln[k]
    for (let i = k * K; i < r; i++) {
      const p = this.parse(at, true)
      line += p.breaks + 1
      at = p.next
    }
    return { at, line }
  }

  /** Field pieces exclude quote characters, so `""` splits a piece and keeps one quote. `skip` only finds the end. */
  private parse(at: number, skip = false): Parsed {
    const b = this.buf
    const end = this.len
    const delim = this.facts.delimiter.charCodeAt(0)
    const fields: [number, number][][] = []
    let pieces: [number, number][] = []
    let from = at
    let q = false
    let start = true
    let breaks = 0
    let i = at
    const close = (to: number): void => {
      if (skip) return
      if (to > from) pieces.push([from, to])
      fields.push(pieces)
      pieces = []
    }
    for (; i < end; i++) {
      const c = b[i]
      if (q) {
        if (c === QUOTE) {
          if (!skip && i > from) pieces.push([from, i])
          if (b[i + 1] === QUOTE) {
            from = i + 1
            i++
          } else {
            q = false
            from = i + 1
          }
        } else if (c === LF) breaks++
        continue
      }
      if (c === QUOTE && start) {
        q = true
        from = i + 1
        start = false
      } else if (c === delim) {
        close(i)
        from = i + 1
        start = true
      } else if (c === LF) {
        close(i > from && b[i - 1] === CR ? i - 1 : i)
        return { fields, next: i + 1, breaks }
      } else start = false
    }
    // The end of the read, inside a quote only for the record that never closes one.
    if (!q) close(end > from && b[end - 1] === CR ? end - 1 : end)
    else if (!skip) {
      if (end > from) pieces.push([from, end])
      fields.push(pieces)
    }
    return { fields, next: end, breaks }
  }

  private decode(pieces: [number, number][], max: number): { text: string; long: boolean } {
    let text = ''
    let long = false
    for (const [a, b] of pieces) {
      const room = max - text.length
      if (room <= 0) return { text, long: true }
      // A character is at most four bytes, so this many always fills the room.
      const take = Math.min(b, a + room * 4)
      text += this.text.decode(this.buf.subarray(a, take))
      if (take < b) long = true
    }
    text = text.replace(/\r\n/g, '\n')
    if (text.length > max) return { text: text.slice(0, max), long: true }
    return { text, long }
  }

  /** Records `r0` to `r1` as text, each field at most `max` characters. */
  rows(r0: number, r1: number, max: number): string[][] {
    const out: string[][] = []
    if (r0 > r1 || r0 >= this.facts.records) return out
    let { at } = this.seek(r0)
    for (let r = r0; r <= Math.min(r1, this.facts.records - 1); r++) {
      const p = this.parse(at)
      out.push(p.fields.map((f) => this.decode(f, max).text))
      at = p.next
    }
    return out
  }

  /** Rows `r0` to `r1` and columns `c0` to `c1`, as the grid's window. `pin`: rows always included, the frozen ones. */
  window(r0: number, r1: number, c0: number, c1: number, pin: number[] = []): SheetWindow {
    const cells: SheetCell[] = []
    const fields: number[] = []
    const read = (a: number, b: number, into: boolean): void => {
      if (a > b || a >= this.facts.records) return
      let { at } = this.seek(a)
      for (let r = a; r <= Math.min(b, this.facts.records - 1); r++) {
        const p = this.parse(at)
        if (into) fields.push(p.fields.length)
        for (let c = c0; c <= Math.min(c1, p.fields.length - 1); c++) {
          const { text, long } = this.decode(p.fields[c], CELL_TEXT_MAX)
          if (text) cells.push({ row: r, col: c, value: text, valueState: 'value', ...(long ? { long: true as const } : {}) })
        }
        at = p.next
      }
    }
    for (const r of pin) if (r < r0 || r > r1) read(r, r, false)
    read(r0, r1, true)
    return { revision: '', r0, r1, c0, c1, rowHeights: [], columnWidths: [], cells, merges: [], fields }
  }

  /** One field in full, up to CELL_FULL_MAX; `fields` is its record's count, so a missing field reads as one. */
  cell(r: number, c: number): { value: string; long: boolean; fields: number } {
    if (r >= this.facts.records) return { value: '', long: false, fields: 0 }
    const p = this.parse(this.seek(r).at)
    const { text, long } = p.fields[c] ? this.decode(p.fields[c], CELL_FULL_MAX) : { text: '', long: false }
    return { value: text, long, fields: p.fields.length }
  }

  /** The first line of record `r0` through the last of `r1`, 1-based. */
  lines(r0: number, r1: number): { start: number; end: number } {
    const a = this.seek(r0)
    const b = r1 === r0 ? a : this.seek(r1)
    return { start: a.line, end: b.line + this.parse(b.at, true).breaks }
  }

  /** The record holding `line`, or -1 past the last. */
  recordOf(line: number): number {
    const { ln, n } = this.cp
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (ln[mid] <= line) lo = mid
      else hi = mid - 1
    }
    if (!n || ln[lo] > line) return -1
    let at = this.cp.off[lo]
    let l = ln[lo]
    for (let r = lo * K; r < this.facts.records; r++) {
      const p = this.parse(at, true)
      if (line <= l + p.breaks) return r
      l += p.breaks + 1
      at = p.next
    }
    return -1
  }

  /** Matching cells from record `from`, row-major, until `limit` hits or `budget` records. */
  find(re: RegExp, from: number, budget: number, limit: number): { hits: number[]; next: number } {
    const hits: number[] = []
    if (from >= this.facts.records) return { hits, next: from }
    let { at } = this.seek(from)
    let r = from
    for (; r < Math.min(this.facts.records, from + budget) && hits.length < limit * 2; r++) {
      const p = this.parse(at)
      p.fields.forEach((f, c) => {
        if (hits.length < limit * 2 && re.test(this.decode(f, CELL_FULL_MAX).text)) hits.push(r, c)
      })
      at = p.next
    }
    return { hits, next: r }
  }
}
