import hljs from './hljs'
import { splitHighlightedLines } from './highlightLines'

/** Highlights each text off the main thread and returns it split per line; null for one that failed. */
self.onmessage = (e: MessageEvent<{ id: number; lang: string; texts: string[] }>) => {
  const { id, lang, texts } = e.data
  const lines = texts.map((text) => {
    try {
      return splitHighlightedLines(hljs.highlight(text, { language: lang, ignoreIllegals: true }).value)
    } catch {
      return null
    }
  })
  self.postMessage({ id, lines })
}
