import type { SourceVersion } from '../../../shared/context'
import type { Refusal } from '../../../shared/files'
import type { Book, BookFailure, CellDetail, SheetGeo, SheetWindow } from '../../../shared/sheets'

/** What the grid asks a workbook's worker; `s` is the sheet's index. */
export type BookAsk =
  | { t: 'port' }
  | { t: 'geo'; id: number; s: number }
  /** `fr` and `fc`: the frozen rows and columns, which every window carries as well. */
  | { t: 'window'; id: number; s: number; r0: number; r1: number; c0: number; c1: number; fr: number; fc: number }
  | { t: 'cell'; id: number; s: number; r: number; c: number }
  | { t: 'copy'; id: number; s: number; r0: number; r1: number; c0: number; c1: number }
  | { t: 'find'; id: number; s: number; q: string; limit: number; hidden: boolean }
  | { t: 'stop' }

type Answer = { geo: SheetGeo; window: SheetWindow; cell: CellDetail; copy: string }
type Asked<K extends keyof Answer> = Omit<Extract<BookAsk, { t: K }>, 't' | 'id'>

export interface BookSource {
  revision: string
  version: SourceVersion
  facts: Book['facts']
  ask<K extends keyof Answer>(t: K, a: Asked<K>): Promise<Answer[K]>
  /** Matches arrive as flat row, column pairs. */
  find(s: number, q: string, limit: number, hidden: boolean, onHits: (hits: number[], done: boolean, more: boolean) => void): void
  stopFind(): void
  close(): void
}

export type BookOpen =
  | { t: 'ready'; src: BookSource }
  | { t: 'failed'; failure: BookFailure }
  | { t: 'refused'; refusal: Refusal }
  | { t: 'empty'; revision: string }
  | { t: 'stopped' }

/** Reads a workbook tab's file in a sheet worker process. `onProgress` hears the fraction parsed once the worker can
 *  say; `stop` ends the read, and a source already handed back must be closed by its holder. `from`: an .ods's
 *  conversion, which is read in place of the file. */
export function openBook(handleId: string, path: string, onProgress: (f: number) => void, from?: { id: string; revision: string; version: SourceVersion }): { stop(): void; done: Promise<BookOpen> } {
  const id = crypto.randomUUID()
  let worker: Worker | null = null
  let settle: ((o: BookOpen) => void) | null = null
  let handed = false
  const end = (): void => {
    void window.clui.sheetStop(id)
    worker?.terminate()
    worker = null
  }
  const finish = (o: BookOpen): void => {
    const s = settle
    settle = null
    window.removeEventListener('message', onPort)
    offExit()
    if (o.t !== 'ready') end()
    s?.(o)
  }
  const done = new Promise<BookOpen>((res) => (settle = res))
  // The port arrives as a window message from the preload, which only this window can send.
  const onPort = (e: MessageEvent): void => {
    if (e.source !== window || (e.data as { cluiSheetPort?: unknown } | null)?.cluiSheetPort !== id || !e.ports[0]) return
    if (!settle) return e.ports[0].close()
    worker = new Worker(new URL('./book.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (m: MessageEvent) => {
      const d = m.data
      if (d.t === 'progress') onProgress(d.f)
      else if (d.t === 'failed') finish({ t: 'failed', failure: d.failure })
      else if (d.t === 'ready') ready(d.facts)
      else if (d.t === 'reply') {
        waiting.get(d.id)?.(d.value)
        waiting.delete(d.id)
      } else if (d.t === 'found' && d.id === findId) finding?.(d.hits, d.done, d.more)
    }
    worker.postMessage({ t: 'port' } satisfies BookAsk, [e.ports[0]])
  }
  window.addEventListener('message', onPort)
  const offExit = window.clui.onSheetExit((e) => {
    if (e.id === id && !handed) finish({ t: 'failed', failure: { t: 'memory' } })
  })
  const waiting = new Map<number, (v: unknown) => void>()
  let finding: ((hits: number[], done: boolean, more: boolean) => void) | null = null
  let findId = 0
  let n = 0
  let opened: { revision: string; version: SourceVersion } | null = null
  let factsIn: Book['facts'] | null = null
  const ready = (facts: Book['facts']): void => {
    factsIn = facts
    if (!opened) return
    handed = true
    const w = worker!
    finish({
      t: 'ready',
      src: {
        ...opened,
        facts,
        ask: (t, a) =>
          new Promise((res) => {
            const q = ++n
            waiting.set(q, res as (v: unknown) => void)
            // A generic key can't narrow the union; Asked<K> already holds the request to its shape.
            w.postMessage({ t, id: q, ...a } as unknown as BookAsk)
          }),
        find: (s, q, limit, hidden, onHits) => {
          finding = onHits
          findId = ++n
          w.postMessage({ t: 'find', id: findId, s, q, limit, hidden } satisfies BookAsk)
        },
        stopFind: () => {
          finding = null
          w.postMessage({ t: 'stop' } satisfies BookAsk)
        },
        close: () => {
          waiting.clear()
          end()
        }
      }
    })
  }
  void window.clui
    .sheetOpen(handleId, path, id, from)
    .catch((): Refusal => ({ ok: false, reason: 'unreadable' }))
    .then((r) => {
      if (!settle) return
      if (!r.ok) return finish({ t: 'refused', refusal: r })
      if (!r.size) return finish({ t: 'empty', revision: r.revision })
      opened = { revision: r.revision, version: r.version }
      if (factsIn) ready(factsIn)
    })
  return {
    stop: () => finish({ t: 'stopped' }),
    done
  }
}
