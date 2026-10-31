import { a1Of, CELL_FULL_MAX, CELL_TEXT_MAX, K, tsvOf, type Book, type BookSheet, type CellDetail, type SheetCell, type SheetWindow, type ValueState } from '../../../shared/sheets'
import type { BookAsk } from './bookSource'

// Holds one workbook as the sheet worker process sent it, straight over its port, so the page's thread never carries
// the cells; the tab's grid asks it for windows, cells, copies and finds.
let facts: Book['facts'] | null = null
let date1904 = false
const sheets: BookSheet[] = []
let findGen = 0
const FIND_SLICE = 20_000

const reply = (id: number, value: unknown): void => self.postMessage({ t: 'reply', id, value })
const textOf = (sh: BookSheet, j: number, max = CELL_FULL_MAX): string => sh.text.slice(sh.textAt[j], Math.min(sh.textAt[j + 1], sh.textAt[j] + max))
const lengthOf = (sh: BookSheet, j: number): number => sh.textAt[j + 1] - sh.textAt[j]

function find(sh: BookSheet, r: number, c: number): number {
  if (r < 0 || r >= sh.geo.rows) return -1
  let lo = sh.rowStart[r]
  let hi = sh.rowStart[r + 1] - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (sh.col[mid] === c) return mid
    if (sh.col[mid] < c) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}
/** The first cell of row r at or past column c. */
function from(sh: BookSheet, r: number, c: number): number {
  let lo = sh.rowStart[r]
  let hi = sh.rowStart[r + 1]
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sh.col[mid] < c) lo = mid + 1
    else hi = mid
  }
  return lo
}
function mergeAt(sh: BookSheet, r: number, c: number): { r0: number; c0: number; r1: number; c1: number } | null {
  const m = sh.geo.merges
  for (let i = 0; i < m.length; i += 4) if (r >= m[i] && r <= m[i + 2] && c >= m[i + 1] && c <= m[i + 3]) return { r0: m[i], c0: m[i + 1], r1: m[i + 2], c1: m[i + 3] }
  return null
}

function cellOf(sh: BookSheet, j: number, row: number, col: number): SheetCell {
  const k = sh.kind[j]
  const base = k & 7
  const n = lengthOf(sh, j)
  const state: ValueState = k & K.uncalculated ? 'not-calculated' : k & K.cached ? 'cached-formula' : base === K.error ? 'error' : 'value'
  return {
    row,
    col,
    value: textOf(sh, j, CELL_TEXT_MAX),
    ...(n > CELL_TEXT_MAX ? { long: true as const } : {}),
    valueState: state,
    ...(sh.style[j] ? { styleId: sh.style[j] - 1 } : {}),
    ...(!(k & K.uncalculated) && (base === K.number || base === K.date) ? { num: true as const } : {}),
    ...(!(k & K.uncalculated) && (base === K.bool || base === K.error) ? { centre: true as const } : {})
  }
}

function windowOf(sh: BookSheet, r0: number, r1: number, c0: number, c1: number, fr: number, fc: number): SheetWindow {
  const cells: SheetCell[] = []
  const spans = (lo: number, hi: number, pin: number): [number, number][] => (pin > 0 && lo > 0 ? [[0, Math.min(pin, lo) - 1], [lo, hi]] : [[0 < lo ? lo : 0, hi]])
  const rowSpans = spans(r0, r1, fr)
  const colSpans = spans(c0, c1, fc)
  for (const [a, b] of rowSpans)
    for (let r = Math.max(0, a); r <= Math.min(b, sh.geo.rows - 1); r++)
      for (const [x, y] of colSpans) for (let j = from(sh, r, x); j < sh.rowStart[r + 1] && sh.col[j] <= y; j++) cells.push(cellOf(sh, j, r, sh.col[j]))
  const merges: SheetWindow['merges'] = []
  const m = sh.geo.merges
  const touches = (lo: number, hi: number, s: [number, number][]): boolean => s.some(([a, b]) => lo <= b && hi >= a)
  for (let i = 0; i < m.length; i += 4) {
    if (!touches(m[i], m[i + 2], rowSpans) || !touches(m[i + 1], m[i + 3], colSpans)) continue
    const j = find(sh, m[i], m[i + 1])
    const right = sh.geo.mergeEdges[i / 2]
    const bottom = sh.geo.mergeEdges[i / 2 + 1]
    merges.push({
      row: m[i],
      col: m[i + 1],
      rows: m[i + 2] - m[i] + 1,
      cols: m[i + 3] - m[i + 1] + 1,
      ...(j >= 0 ? { anchor: cellOf(sh, j, m[i], m[i + 1]) } : {}),
      ...(right ? { right: right - 1 } : {}),
      ...(bottom ? { bottom: bottom - 1 } : {})
    })
  }
  return { revision: '', r0, r1, c0, c1, rowHeights: [], columnWidths: [], cells, merges }
}

const EPOCH_1900 = Date.UTC(1899, 11, 30)
const EPOCH_1904 = Date.UTC(1904, 0, 1)
const pad = (n: number): string => String(n).padStart(2, '0')
/** A date serial as ISO: `2024-02-29`, `2024-02-29 13:30`, seconds when it has them; a time alone under one day. */
function iso(serial: number): string {
  const ms = Math.round(((date1904 ? EPOCH_1904 : EPOCH_1900) + serial * 86_400_000) / 1000) * 1000
  const d = new Date(ms)
  const time = d.getUTCHours() || d.getUTCMinutes() || d.getUTCSeconds() ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${d.getUTCSeconds() ? `:${pad(d.getUTCSeconds())}` : ''}` : ''
  if (serial < 1 && !date1904 && time) return time
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}${time ? ` ${time}` : ''}`
}
/** Up to 15 significant digits, as Excel keeps them. */
const raw = (n: number): string => String(Number(n.toPrecision(15)))

function detail(sh: BookSheet, r: number, c: number): CellDetail {
  const m = mergeAt(sh, r, c)
  const merged = m && (m.r0 !== m.r1 || m.c0 !== m.c1) ? { merged: a1Of({ shape: 'cells', ...m }) } : {}
  const j = find(sh, m?.r0 ?? r, m?.c0 ?? c)
  if (j < 0) return { value: '', long: false, ...merged }
  const k = sh.kind[j]
  const base = k & 7
  const t = textOf(sh, j)
  const long = lengthOf(sh, j) > CELL_FULL_MAX
  const formula = sh.formula.get(j)
  if (k & K.uncalculated) return { value: formula ?? t, long: false, state: 'not-calculated', ...merged }
  if (k & K.cached) return { value: formula ?? '', long: false, shown: t, state: 'cached-formula', ...merged }
  const link = sh.link.get(j)
  if (base === K.number || base === K.date) {
    const value = base === K.date ? iso(sh.num[j]) : raw(sh.num[j])
    return { value, long: false, ...(t !== value ? { shown: t } : {}), ...merged }
  }
  return { value: t, long, ...(base === K.error ? { state: 'error' as const } : {}), ...(link ? { link } : {}), ...merged }
}

function copyOf(sh: BookSheet, r0: number, r1: number, c0: number, c1: number): string {
  const rows: string[][] = []
  for (let r = r0; r <= Math.min(r1, sh.geo.rows - 1); r++) {
    const row = Array.from({ length: c1 - c0 + 1 }, () => '')
    for (let j = from(sh, r, c0); j < sh.rowStart[r + 1] && sh.col[j] <= c1; j++) row[sh.col[j] - c0] = textOf(sh, j)
    rows.push(row)
  }
  return tsvOf(rows)
}

let port: MessagePort | null = null
let expected = 0

self.onmessage = (e: MessageEvent<BookAsk>) => {
  const m = e.data
  if (m.t === 'port') {
    port = e.ports[0]
    port.onmessage = (p) => {
      const d = p.data as { t: string; f?: number; failure?: unknown; facts?: Book['facts']; date1904?: boolean; i?: number; sheet?: BookSheet }
      if (d.t === 'progress') self.postMessage({ t: 'progress', f: d.f })
      else if (d.t === 'failed') {
        self.postMessage({ t: 'failed', failure: d.failure })
        port?.postMessage({ t: 'got' })
      } else if (d.t === 'facts') {
        facts = d.facts!
        date1904 = !!d.date1904
        expected = facts.sheets.length
      } else if (d.t === 'sheet') sheets[d.i!] = d.sheet!
      else if (d.t === 'done' && facts && sheets.filter(Boolean).length === expected) {
        port?.postMessage({ t: 'got' })
        self.postMessage({ t: 'ready', facts })
      }
    }
    return
  }
  if (m.t === 'stop') return void findGen++
  const sh = sheets[m.s]
  if (!sh) return reply(m.id, null)
  switch (m.t) {
    case 'geo':
      return reply(m.id, sh.geo)
    case 'window':
      return reply(m.id, windowOf(sh, m.r0, m.r1, m.c0, m.c1, m.fr, m.fc))
    case 'cell':
      return reply(m.id, detail(sh, m.r, m.c))
    case 'copy':
      return reply(m.id, copyOf(sh, m.r0, m.r1, m.c0, m.c1))
    case 'find': {
      const gen = ++findGen
      const re = new RegExp(m.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu')
      const hiddenR = new Set(m.hidden ? [] : sh.geo.hiddenRows)
      const hiddenC = new Set(m.hidden ? [] : sh.geo.hiddenCols)
      const n = sh.col.length
      let found = 0
      let r = 0
      // Row-major over the cells there are, in slices that yield so a new query or a stop gets in.
      const step = (j0: number): void => {
        if (gen !== findGen) return
        const hits: number[] = []
        let j = j0
        for (const end = Math.min(n, j0 + FIND_SLICE); j < end && found <= m.limit; j++) {
          while (sh.rowStart[r + 1] <= j) r++
          if (hiddenR.has(r) || hiddenC.has(sh.col[j])) continue
          const f = sh.formula.get(j)
          if (re.test(textOf(sh, j)) || (!!f && re.test(f))) {
            found++
            hits.push(r, sh.col[j])
          }
        }
        const more = found > m.limit
        const done = more || j >= n
        self.postMessage({ t: 'found', id: m.id, hits: more ? hits.slice(0, hits.length - 2) : hits, done, more })
        if (!done) setTimeout(() => step(j), 0)
      }
      return step(0)
    }
  }
}
