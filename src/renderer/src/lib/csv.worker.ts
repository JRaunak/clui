import { CsvIndex } from './csv'
import { CELL_FULL_MAX, tsvOf } from '../../../shared/sheets'
import type { CsvAsk } from './csvSource'

// Parses, indexes and searches one CSV off the main thread; the tab's grid asks it for windows of cells.
let x: CsvIndex | null = null
let findGen = 0
const FIND_SLICE = 20_000

const ctx = typeof OffscreenCanvas === 'undefined' ? null : new OffscreenCanvas(1, 1).getContext('2d')
const measure = (s: string): number => (ctx ? ctx.measureText(s).width : s.length * 7)
const reply = (id: number, value: unknown): void => self.postMessage({ t: 'reply', id, value })
const facts = (): void => self.postMessage({ t: 'facts', facts: x?.facts })

self.onmessage = (e: MessageEvent<CsvAsk>) => {
  const m = e.data
  if (m.t === 'open') {
    if (ctx) ctx.font = m.font
    x = new CsvIndex(m.size, m.total, { measure, ...(m.delimiter ? { delimiter: m.delimiter } : {}) })
    return
  }
  if (!x) return
  const ix = x
  switch (m.t) {
    case 'chunk':
      ix.push(m.bytes, m.done)
      return facts()
    case 'delimiter':
      findGen++
      ix.redelimit(m.delimiter)
      return facts()
    case 'window':
      return reply(m.id, ix.window(m.r0, m.r1, m.c0, m.c1, m.pin))
    case 'cell':
      return reply(m.id, ix.cell(m.r, m.c))
    case 'lines':
      return reply(m.id, ix.lines(m.r0, m.r1))
    case 'record':
      return reply(m.id, ix.recordOf(m.line))
    case 'copy':
      return reply(m.id, tsvOf(ix.rows(m.r0, m.r1, CELL_FULL_MAX).map((r) => Array.from({ length: m.c1 - m.c0 + 1 }, (_, i) => r[m.c0 + i] ?? ''))))
    case 'find': {
      const gen = ++findGen
      const re = new RegExp(m.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'iu')
      let found = 0
      // Slices yield to the queue, so a new query, a stop or the next chunk gets in; an index still growing is waited on.
      const step = (from: number): void => {
        if (gen !== findGen) return
        const { hits, next } = ix.find(re, from, FIND_SLICE, m.limit + 1 - found)
        found += hits.length / 2
        const more = found > m.limit
        const done = more || (ix.facts.done && next >= ix.facts.records)
        self.postMessage({ t: 'found', id: m.id, hits: more ? hits.slice(0, hits.length - 2) : hits, done, more })
        if (!done) setTimeout(() => step(next), next >= ix.facts.records ? 20 : 0)
      }
      return step(0)
    }
    case 'stop':
      findGen++
  }
}
