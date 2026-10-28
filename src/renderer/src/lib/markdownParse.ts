import { docTree, type DocTree } from './markdownDoc'

let worker: Worker | null = null
let seq = 0
interface Waiter {
  text: string
  done: (t: DocTree) => void
}
const waiting = new Map<number, Waiter & { got: DocTree }>()

/** Parses left to this thread. One that throws resolves empty, so it can't strand the waiters after it. */
export function parseHere(all: readonly Waiter[], parse: (text: string) => DocTree = docTree): void {
  for (const w of all) {
    let t: DocTree = { rows: [], weights: [], keys: [] }
    try {
      t = parse(w.text)
    } catch {
      /* shown empty */
    }
    w.done(t)
  }
}

export function parseOff(text: string): Promise<DocTree> {
  if (!worker) {
    worker = new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<DocTree & { id: number; last: boolean }>) => {
      const w = waiting.get(e.data.id)
      if (!w) return
      w.got.rows.push(...e.data.rows)
      w.got.weights.push(...e.data.weights)
      w.got.keys.push(...e.data.keys)
      if (!e.data.last) return
      waiting.delete(e.data.id)
      w.done(w.got)
    }
    // A dead worker leaves the parse to this thread: slow, but the document still shows.
    worker.onerror = () => {
      worker?.terminate()
      worker = null
      const all = [...waiting.values()]
      waiting.clear()
      parseHere(all)
    }
  }
  const id = ++seq
  return new Promise((done) => {
    waiting.set(id, { text, got: { rows: [], weights: [], keys: [] }, done })
    worker?.postMessage({ id, text })
  })
}

/**
 * One preview's parses, where only the newest text matters: an ask waits for the one before it, is skipped if a later
 * ask came in meanwhile, and resolves null when superseded, so an old revision never lands on a newer one.
 */
export function latestParse(post: (text: string) => Promise<DocTree> = parseOff): (text: string) => Promise<DocTree | null> {
  let n = 0
  let queue: Promise<unknown> = Promise.resolve()
  return (text) => {
    const me = ++n
    const run = queue.then(() => (me === n ? post(text) : null))
    queue = run
    return run.then((t) => (me === n ? t : null))
  }
}
