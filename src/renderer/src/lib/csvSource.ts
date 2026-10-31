import { CHUNK_MAX, type Refusal } from '../../../shared/files'
import { CSV_BYTES_MAX, type SheetWindow } from '../../../shared/sheets'
import type { Delimiter } from '../../../shared/surfaces'
import type { CsvFacts } from './csv'

/** What the grid asks the CSV worker. */
export type CsvAsk =
  | { t: 'open'; size: number; total: number; font: string; delimiter?: Delimiter }
  | { t: 'chunk'; bytes: Uint8Array; done: boolean }
  | { t: 'delimiter'; delimiter: Delimiter }
  | { t: 'window'; id: number; r0: number; r1: number; c0: number; c1: number; pin: number[] }
  | { t: 'cell'; id: number; r: number; c: number }
  | { t: 'lines'; id: number; r0: number; r1: number }
  | { t: 'record'; id: number; line: number }
  | { t: 'copy'; id: number; r0: number; r1: number; c0: number; c1: number }
  | { t: 'find'; id: number; q: string; limit: number }
  | { t: 'stop' }

type Answer = { window: SheetWindow; cell: { value: string; long: boolean; fields: number }; lines: { start: number; end: number }; record: number; copy: string }
type Asked<K extends keyof Answer> = Omit<Extract<CsvAsk, { t: K }>, 't' | 'id'>

// The first read is small, so the first window paints before a big file's next 4 MiB arrives.
const FIRST = 256 * 1024

export interface CsvSource {
  revision: string
  size: number
  ask<K extends keyof Answer>(t: K, a: Asked<K>): Promise<Answer[K]>
  delimit(d: Delimiter): void
  /** Matches arrive as flat row, column pairs. */
  find(q: string, limit: number, onHits: (hits: number[], done: boolean, more: boolean) => void): void
  stopFind(): void
  close(): void
}

/** Opens a CSV tab's file at its current revision and streams it into a worker that indexes it. `onFacts` hears each
 *  step of the index; `onFail` a read refused part way, `changed` included. */
export async function openCsv(
  handleId: string,
  path: string,
  opts: { font: string; delimiter?: Delimiter },
  onFacts: (f: CsvFacts) => void,
  onFail: (r: Refusal) => void
): Promise<CsvSource | Refusal> {
  const h = await window.clui.docOpen(handleId, path, FIRST).catch((): Refusal => ({ ok: false, reason: 'unreadable' }))
  if (!h.ok) return h
  const total = Math.min(h.size, CSV_BYTES_MAX)
  const worker = new Worker(new URL('./csv.worker.ts', import.meta.url), { type: 'module' })
  const waiting = new Map<number, (v: unknown) => void>()
  let finding: ((hits: number[], done: boolean, more: boolean) => void) | null = null
  let findId = 0
  let n = 0
  let live = true
  worker.onmessage = (e: MessageEvent) => {
    const m = e.data
    if (m.t === 'facts') onFacts(m.facts)
    else if (m.t === 'reply') {
      waiting.get(m.id)?.(m.value)
      waiting.delete(m.id)
    } else if (m.t === 'found' && m.id === findId) finding?.(m.hits, m.done, m.more)
  }
  const post = (m: CsvAsk): void => {
    if (live) worker.postMessage(m, m.t === 'chunk' ? [m.bytes.buffer] : [])
  }
  // IPC hands back a fresh buffer, but a view may not cover all of it; only a whole one can move.
  const own = (b: Uint8Array): Uint8Array => (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b : b.slice())
  post({ t: 'open', size: h.size, total, font: opts.font, ...(opts.delimiter ? { delimiter: opts.delimiter } : {}) })
  void (async () => {
    let off = 0
    if (h.head?.length) {
      off = Math.min(total, h.head.length)
      post({ t: 'chunk', bytes: own(h.head.subarray(0, off)), done: off >= total })
    } else if (!total) post({ t: 'chunk', bytes: new Uint8Array(0), done: true })
    while (live && off < total) {
      const r = await window.clui.docRead(handleId, path, h.revision, off, Math.min(CHUNK_MAX, total - off)).catch((): Refusal => ({ ok: false, reason: 'unreadable' }))
      if (!live) return
      if (!r.ok) return onFail(r)
      if (!r.bytes.length) return onFail({ ok: false, reason: 'changed' })
      off += r.bytes.length
      post({ t: 'chunk', bytes: own(r.bytes), done: off >= total })
    }
  })()
  return {
    revision: h.revision,
    size: h.size,
    ask: (t, a) =>
      new Promise((res) => {
        const id = ++n
        waiting.set(id, res as (v: unknown) => void)
        // A generic key can't narrow the union; Asked<K> already holds the request to its shape.
        post({ t, id, ...a } as unknown as CsvAsk)
      }),
    delimit: (d) => post({ t: 'delimiter', delimiter: d }),
    find: (q, limit, onHits) => {
      finding = onHits
      findId = ++n
      post({ t: 'find', id: findId, q, limit })
    },
    stopFind: () => {
      finding = null
      post({ t: 'stop' })
    },
    close: () => {
      live = false
      waiting.clear()
      worker.terminate()
    }
  }
}
