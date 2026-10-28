import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import type { Element, ElementContent, Root, RootContent } from 'hast'

export const PREVIEW_MAX = 1024 * 1024

/** Where a Preview of `text` stops, in UTF-16 units: after the last line break within PREVIEW_MAX bytes of UTF-8.
 *  Null when the whole text fits. */
export function previewEnd(text: string): number | null {
  if (text.length * 3 <= PREVIEW_MAX) return null
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(PREVIEW_MAX))
  if (read >= text.length) return null
  const nl = text.lastIndexOf('\n', read - 1)
  return nl >= 0 ? nl + 1 : read
}

const FENCE = /^---[ \t]*\r?$/

/**
 * A leading `---` … `---` block: its inner text, how many lines it takes with both fences, and the text to parse,
 * with those lines left empty so every later line keeps its number.
 */
export function frontMatter(text: string): { code: string; lines: number; body: string } | null {
  const first = text.indexOf('\n')
  if (first < 0 || !FENCE.test(text.slice(0, first))) return null
  for (let n = 2, start = first + 1; start < text.length; n++) {
    const nl = text.indexOf('\n', start)
    const end = nl < 0 ? text.length : nl
    if (FENCE.test(text.slice(start, end))) {
      return { code: text.slice(first + 1, start).replace(/\r?\n$/, '').replace(/\r$/gm, ''), lines: n, body: '\n'.repeat(n) + (nl < 0 ? '' : text.slice(nl + 1)) }
    }
    if (nl < 0) break
    start = nl + 1
  }
  return null
}

/** GitHub's heading ids: lowercase, only letters, digits, spaces, `-` and `_` kept, spaces to `-`. A repeat gets
 *  `-1`, `-2`, and so on. One per document, in heading order. */
export function slugger(): (text: string) => string {
  const seen = new Map<string, number>()
  return (text) => {
    const base = text.toLowerCase().replace(/[^\p{L}\p{M}\p{N} _-]/gu, '').replace(/ /g, '-')
    let slug = base
    while (seen.has(slug)) {
      const n = seen.get(base)! + 1
      seen.set(base, n)
      slug = `${base}-${n}`
    }
    seen.set(slug, 0)
    return slug
  }
}

export interface Span {
  start: number
  end: number
}

interface Position {
  start: { line: number }
  end: { line: number }
}

/** A block's `data-src`. */
export const spanAttr = (p: Position | undefined): string | undefined => (p ? `${p.start.line}-${p.end.line}` : undefined)

export function parseSpan(s: string | undefined): Span | null {
  const m = s ? /^(\d+)-(\d+)$/.exec(s) : null
  return m ? { start: Number(m[1]), end: Number(m[2]) } : null
}

export const meets = (a: Span, b: Span): boolean => a.start <= b.end && b.start <= a.end

/** Two blocks and everything between: the lower start to the higher end. */
export const joinSpans = (a: Span, b: Span): Span => ({ start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) })

/**
 * The block, by index in document order, that shows line `n`: the innermost one containing it, which is the last
 * such in document order since a container comes before what it holds. A line between blocks goes to the next
 * block, and one past the last block to the last. -1 when there are no blocks.
 */
export function blockFor(spans: readonly Span[], n: number): number {
  let inner = -1
  let next = -1
  for (let i = 0; i < spans.length; i++) {
    const s = spans[i]
    if (s.start <= n && n <= s.end) inner = i
    else if (next < 0 && s.start > n) next = i
  }
  return inner >= 0 ? inner : next >= 0 ? next : spans.length - 1
}

export const textOf = (n: Root | RootContent): string => (n.type === 'text' ? n.value : 'children' in n ? (n.children as RootContent[]).map(textOf).join('') : '')

/** GitHub-style ids on the document's headings. One that has an id already, like the footnotes label, keeps it. */
function headingIds() {
  return (tree: Root): void => {
    const slug = slugger()
    const walk = (n: Root | Element): void => {
      for (const c of n.children) {
        if (c.type !== 'element') continue
        if (/^h[1-6]$/.test(c.tagName) && !c.properties.id) c.properties.id = slug(textOf(c))
        else walk(c)
      }
    }
    walk(tree)
  }
}

// react-markdown's own pipeline, raw HTML included, so the Preview parses exactly as the transcript does.
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true }).use(headingIds)

/** A document's top-level blocks, and how many elements each holds: the measure of what it costs to render and to copy
 *  out of the worker. A row's key is the same exactly when it renders the same. */
export interface DocTree {
  rows: RootContent[]
  weights: number[]
  keys: string[]
}

// Text drops its position on the way: only elements map to lines, and the worker's copy costs per object.
function weigh(n: RootContent | ElementContent): number {
  if (n.type === 'text') delete n.position
  if (n.type !== 'element') return 0
  let w = 1
  for (const c of n.children) w += weigh(c)
  return w
}

// The key is the tree, not the source: a reference link, a footnote's number or a repeated heading's id comes from
// other rows. Columns and offsets move with any edit earlier on the row's line, and only lines show.
const lineOnly = (k: string, v: unknown): unknown => (k === 'column' || k === 'offset' ? undefined : v)

export function docTree(text: string): DocTree {
  const rows = (processor.runSync(processor.parse(text)) as Root).children.filter((c) => c.type !== 'text' || c.value.trim())
  const weights = rows.map(weigh)
  return { rows, weights, keys: rows.map((r) => JSON.stringify(r, lineOnly)) }
}

/** Where the chunk of rows starting at `from` ends: rows until their weights reach `budget`, at least one. A `free`
 *  row, one already built, costs nothing. */
export function nextChunk(weights: readonly number[], from: number, budget: number, free?: (i: number) => boolean): number {
  let to = from
  for (let w = 0; to < weights.length && w < budget; to++) if (!free?.(to)) w += weights[to]
  return to
}

/** The row that shows line `n`: the first ending at or after it, else the last. */
export function rowOf(rows: readonly RootContent[], n: number): number {
  const i = rows.findIndex((r) => (r.position?.end.line ?? 0) >= n)
  return i < 0 ? rows.length - 1 : i
}

export function rowWithId(rows: readonly RootContent[], id: string): number {
  const has = (n: RootContent | ElementContent): boolean => n.type === 'element' && (n.properties.id === id || n.children.some(has))
  return rows.findIndex(has)
}

const spanOfNode = (n: RootContent | ElementContent): Span | null => (n.type === 'element' && n.position ? { start: n.position.start.line, end: n.position.end.line } : null)
const LISTS = new Set(['ul', 'ol'])
const CONTAINERS = new Set(['blockquote', 'section', 'ul', 'ol'])

/**
 * The "Claude pointed to" row, placed just before the first block it marks: inside a list it's an item of that list,
 * so it never sits beside another item's marker. Returns what replaces row `at`; the elements on the way down are
 * copies, so every other row keeps its identity and its render.
 */
export function pointAt(rows: readonly RootContent[], pointed: (Span & { label: string }) | null): { at: number; nodes: RootContent[] } | null {
  if (!pointed) return null
  const hit = (cs: readonly (RootContent | ElementContent)[]): number =>
    cs.findIndex((c) => {
      const sp = spanOfNode(c)
      return !!sp && meets(sp, pointed)
    })
  const at = hit(rows)
  if (at < 0) return null
  const top: Element = { type: 'element', tagName: 'div', properties: {}, children: [rows[at] as ElementContent] }
  let parent = top
  for (let i = 0; ; ) {
    const el = parent.children[i] as Element
    // An item descends only when the mark starts in its nested list rather than its own text.
    const inner = el.tagName === 'li' ? el.children.find((c) => !!spanOfNode(c) && meets(spanOfNode(c)!, pointed)) : undefined
    if (CONTAINERS.has(el.tagName) || (inner?.type === 'element' && LISTS.has(inner.tagName))) {
      const copy: Element = { ...el, children: [...el.children] }
      parent.children[i] = copy
      parent = copy
      i = hit(copy.children)
      if (i < 0) return null
      continue
    }
    const tagName = parent !== top && LISTS.has(parent.tagName) ? 'li' : 'div'
    parent.children.splice(i, 0, { type: 'element', tagName, properties: { dataPointed: pointed.label }, children: [] })
    return { at, nodes: top.children as RootContent[] }
  }
}
