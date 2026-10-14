/**
 * Syntax highlighting for the File and Diff surfaces and the permission Gate's diff: grammar by
 * file extension, per-line HTML, a highlight worker so big files never block input, and one
 * shared cache.
 */
import hljs from './hljs'
import { splitHighlightedLines } from './highlightLines'

/** Over these, a request renders plain. */
export const HIGHLIGHT_MAX_CHARS = 512 * 1024
export const HIGHLIGHT_MAX_LINES = 10_000
const CACHE_CHARS = 8_000_000

/** Extensions highlight.js has no alias for. */
const EXT: Record<string, string> = { htm: 'xml', vue: 'xml' }

/** The registered grammar for a path's extension, else null (plain). */
export function langForPath(path: string): string | null {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  const ext = name.slice(dot + 1).toLowerCase()
  const lang = EXT[ext] ?? ext
  return hljs.getLanguage(lang) ? lang : null
}

const cache = new Map<string, string[]>()
let cachedChars = 0

function cached(key: string): string[] | undefined {
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
  }
  return hit
}

function remember(key: string, lines: string[]): void {
  cache.set(key, lines)
  cachedChars += key.length + lines.reduce((n, l) => n + l.length, 0)
  for (const [k, v] of cache) {
    if (cachedChars <= CACHE_CHARS) break
    cache.delete(k)
    cachedChars -= k.length + v.reduce((n, l) => n + l.length, 0)
  }
}

let worker: Worker | null = null
let seq = 0
const waiting = new Map<number, (lines: (string[] | null)[]) => void>()

function post(lang: string, texts: string[]): Promise<(string[] | null)[]> {
  if (!worker) {
    worker = new Worker(new URL('./highlight.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; lines: (string[] | null)[] }>) => {
      waiting.get(e.data.id)?.(e.data.lines)
      waiting.delete(e.data.id)
    }
    // A dead worker leaves everything plain rather than pending forever.
    worker.onerror = () => {
      for (const done of waiting.values()) done([])
      waiting.clear()
      worker = null
    }
  }
  const id = ++seq
  return new Promise((resolve) => {
    waiting.set(id, resolve)
    worker?.postMessage({ id, lang, texts })
  })
}

/** Each text highlighted and split per line, or null where it stays plain. Over the size limit every text stays plain. */
export async function highlightTexts(lang: string | null, texts: string[]): Promise<(string[] | null)[]> {
  const plain = texts.map(() => null)
  if (!lang || !texts.length) return plain
  let size = 0
  let lines = 0
  for (const t of texts) {
    size += t.length
    lines += t.split('\n').length
  }
  if (size > HIGHLIGHT_MAX_CHARS || lines > HIGHLIGHT_MAX_LINES) return plain
  const keys = texts.map((t) => `${lang}\0${t}`)
  const out: (string[] | null)[] = keys.map((k) => cached(k) ?? null)
  const missing = out.flatMap((v, i) => (v ? [] : [i]))
  if (!missing.length) return out
  const got = await post(lang, missing.map((i) => texts[i]))
  missing.forEach((i, j) => {
    const lines = got[j]
    if (!lines) return
    out[i] = lines
    remember(keys[i], lines)
  })
  return out
}

/** Highlighted on the spot, for content that must paint complete on its first frame. */
export function highlightNow(lang: string | null, text: string): string[] | null {
  if (!lang) return null
  const key = `${lang}\0${text}`
  const hit = cached(key)
  if (hit) return hit
  try {
    const lines = splitHighlightedLines(hljs.highlight(text, { language: lang, ignoreIllegals: true }).value)
    remember(key, lines)
    return lines
  } catch {
    return null
  }
}
