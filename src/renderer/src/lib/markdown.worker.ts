import { docTree, nextChunk } from './markdownDoc'

// The tree goes back in slices: copying a whole big one into the main thread is a single task of hundreds of ms.
const SLICE = 2000

self.onmessage = (e: MessageEvent<{ id: number; text: string }>) => {
  const { id, text } = e.data
  const { rows, weights, keys } = docTree(text)
  for (let from = 0; ; ) {
    const to = nextChunk(weights, from, SLICE)
    const last = to >= rows.length
    self.postMessage({ id, rows: rows.slice(from, to), weights: weights.slice(from, to), keys: keys.slice(from, to), last })
    if (last) return
    from = to
  }
}
