// A Word document laid out by docx-preview, contained: built in an inert document, cleaned there, then moved into a
// shadow root whose stylesheet is Clui's. What docx-preview hands back is someone else's file, so nothing it builds
// reaches the live document until the post-pass has run.
import type { Options } from 'docx-preview'
import type { NotePart, WordFacts, WordPart } from '../../../shared/office'
import { flatten, lowerRoman, noteNumbers, type Flat, type Para } from './docxView'

/** A paragraph of a part, with the text nodes its text came from. */
export interface Block extends Para { el: HTMLElement; nodes: Text[]; starts: number[] }
/** `chrome`: the headers' and footers' paragraphs, found by find while pages show them, never quoted. */
export type Parts = Record<WordPart | 'chrome', Block[]>
/** Each part's blocks and their flattened text. */
export type Index = { parts: Parts; flats: Record<keyof Parts, Flat> }

export const loadDocx = (): Promise<typeof import('docx-preview')> => import('docx-preview')

const inert = document.implementation.createHTMLDocument('')

/** docx-preview 0.4.1's own `h`, building into an inert document: a picture it can't resolve gets `src = null`, and a
 *  live `<img>` would fetch that. Its digits-only `<sup>` is a note reference mark, tagged here because the DOM it
 *  returns carries no note id. Tied to the pinned version. */
function inertH(e: Parameters<Options['h']>[0]): Node {
  if (typeof e === 'string') return document.createTextNode(e)
  if (e instanceof Node) return e
  const { ns, tagName, className, style, children, ...props } = e
  if (tagName === '#fragment') {
    const f = inert.createDocumentFragment()
    children?.forEach((c) => f.appendChild(inertH(c)))
    return f
  }
  if (tagName === '#comment') return inert.createComment(children ? String(children[0]) : '')
  const r = ns ? inert.createElementNS(ns, tagName) : inert.createElement(tagName)
  if (className) r.setAttribute('class', className)
  if (style) {
    if (typeof style === 'string') r.setAttribute('style', style)
    else Object.assign((r as HTMLElement).style, style)
  }
  for (const [k, v] of Object.entries(props)) if (v !== undefined) (r as unknown as Record<string, unknown>)[k] = v
  if (tagName === 'sup' && children?.length === 1 && typeof children[0] === 'string' && /^\d+$/.test(children[0])) r.setAttribute('data-note', '')
  children?.forEach((c) => r.appendChild(inertH(c)))
  return r
}

export const OPTIONS: Partial<Options> = {
  inWrapper: false,
  ignoreFonts: true,
  useBase64URL: true,
  renderAltChunks: false,
  renderComments: false,
  renderChanges: false,
  experimental: false,
  debug: false,
  breakPages: true,
  ignoreLastRenderedPageBreak: true,
  renderHeaders: true,
  renderFooters: true,
  renderFootnotes: true,
  renderEndnotes: true,
  h: inertH
}

type Parsed = { documentPart?: { body?: { children?: Node0[] } }; stylesPart?: { styles?: Style0[] } }
type Node0 = { type?: string; styleName?: string; pageBreakBefore?: boolean; sectionProps?: unknown; children?: Node0[]; break?: string }
type Style0 = { id?: string; basedOn?: string; paragraphProps?: { pageBreakBefore?: boolean } }

/** What ends each segment but the last, mirroring docx-preview 0.4.1's `splitBySection` with breakPages on and saved
 *  breaks ignored: a page break before or inside a body paragraph, else a section break. */
export function breaksOf(doc: Parsed): ('page' | 'section')[] {
  const styles = new Map((doc.stylesPart?.styles ?? []).map((s) => [s.id, s]))
  const before = (name?: string): boolean => {
    for (let s = name ? styles.get(name) : undefined, k = 0; s && k < 32; s = s.basedOn ? styles.get(s.basedOn) : undefined, k++) if (s.paragraphProps?.pageBreakBefore) return true
    return false
  }
  const out: ('page' | 'section')[] = []
  for (const p of doc.documentPart?.body?.children ?? []) {
    if (p.type !== 'paragraph') continue
    if (p.pageBreakBefore || before(p.styleName)) out.push('page')
    const br = !!p.children?.some((r) => r.children?.some((c) => c.type === 'break' && c.break === 'page'))
    if (p.sectionProps || br) out.push(br ? 'page' : 'section')
  }
  return out
}

export const NO_DESCRIPTION = 'Picture with no description'

/** The segments, and each part's pictures and note lists, as docx-preview put them down. */
function partsOf(sections: HTMLElement[], endnotes: boolean) {
  const lists = sections.map((s) => [...s.children].filter((c): c is HTMLOListElement => c.tagName === 'OL'))
  const last = lists.length - 1
  const notes: Record<NotePart, HTMLOListElement[]> = { footnotes: [], endnotes: [] }
  lists.forEach((ls, i) => ls.forEach((ol, k) => notes[endnotes && i === last && k === ls.length - 1 ? 'endnotes' : 'footnotes'].push(ol)))
  const body = sections.flatMap((s) => [...s.children].filter((c): c is HTMLElement => c.tagName === 'ARTICLE'))
  return { body, notes }
}

/**
 * The post-pass, in the inert document, before any node moves: picture descriptions by order, the non-`data:` picture
 * drop, anything active removed, heading roles, and the note marks docx-preview 0.4.1 numbers wrong (a reference with
 * direct superscript is rendered twice, so its note is listed twice and every later number is off by one).
 */
export function postPass(nodes: Node[], facts: WordFacts, breaks: ('page' | 'section')[]): void {
  const els = nodes.filter((n): n is HTMLElement => n.nodeType === Node.ELEMENT_NODE)
  const sections = els.filter((e) => e.tagName === 'SECTION')
  const { body, notes } = partsOf(sections, facts.notes.some((n) => n.part === 'endnotes'))
  const pics = (roots: Element[]): Element[] => roots.flatMap((r) => [...r.querySelectorAll('img, svg image')])
  const alts = (found: Element[], want: (string | null)[]): void =>
    found.forEach((el, i) => {
      const alt = found.length === want.length ? want[i] : null
      const words = alt === null ? NO_DESCRIPTION : alt
      if (el.tagName === 'IMG') return el.setAttribute('alt', words)
      const svg = el.closest('svg')
      if (!svg) return
      if (words) svg.setAttribute('role', 'img'), svg.setAttribute('aria-label', words)
      else svg.setAttribute('aria-hidden', 'true')
    })
  alts(pics(body), facts.pictures.body)
  alts(pics(notes.footnotes), facts.pictures.footnotes)
  alts(pics(notes.endnotes), facts.pictures.endnotes)
  // Headers and footers repeat on every page box; the region's description says where they are.
  for (const el of pics(sections.flatMap((s) => [...s.querySelectorAll(':scope > header, :scope > footer')]))) {
    if (el.tagName === 'IMG') el.setAttribute('alt', '')
    else el.closest('svg')?.setAttribute('aria-hidden', 'true')
  }
  for (const s of sections) {
    // An SVG picture goes with its svg: docx-preview measures the svg's first child a frame later and throws on none.
    for (const el of s.querySelectorAll('img, image'))
      if (!(el.getAttribute('src') ?? el.getAttribute('href') ?? el.getAttribute('xlink:href') ?? '').startsWith('data:')) (el.tagName === 'IMG' ? el : (el.closest('svg') ?? el)).remove()
    for (const el of s.querySelectorAll('iframe, object, embed, script, link, meta, base, form')) el.remove()
    for (const el of s.querySelectorAll('*')) for (const a of [...el.attributes]) if (a.name.startsWith('on')) el.removeAttribute(a.name)
    for (const p of s.querySelectorAll<HTMLElement>('p')) {
      const level = [...p.classList].map((c) => facts.headings[c]).find(Boolean)
      if (level) p.setAttribute('role', 'heading'), p.setAttribute('aria-level', String(level))
    }
    // A table wider than the page scrolls on its own, with its scrollbar under it and a stop for the keyboard.
    for (const t of s.querySelectorAll(':scope > article > table')) {
      const w = inert.createElement('div')
      w.dataset.scroll = 'table'
      t.before(w)
      w.append(t)
    }
  }
  fixNotes(sections, body, notes, facts)
  // Each segment's height until it lays out: its own page height from the document.
  for (const s of sections) s.style.setProperty('--seg-h', s.style.minHeight || '11in')
  sections.slice(0, -1).forEach((s, i) => {
    const kind = breaks.length === sections.length - 1 ? breaks[i] : null
    if (!kind) return
    const m = inert.createElement('div')
    m.dataset.break = kind
    m.setAttribute('role', 'separator')
    m.setAttribute('aria-label', kind === 'page' ? 'Page break' : 'Section break')
    m.textContent = kind === 'page' ? 'Page break' : 'Section break'
    nodes.splice(nodes.indexOf(s) + 1, 0, m)
  })
  for (const ol of notes.footnotes) ol.dataset.part = 'footnotes'
  for (const ol of notes.endnotes) ol.dataset.part = 'endnotes'
}

/** One mark per reference, each note listed once, numbered as Word does: footnotes 1, 2, 3 through the document across
 *  every page box's list, endnotes i, ii, iii. A custom mark keeps the author's text, which follows the mark
 *  docx-preview adds. Left as rendered when the marks don't line up with main's list. */
function fixNotes(sections: HTMLElement[], body: HTMLElement[], notes: Record<NotePart, HTMLOListElement[]>, facts: WordFacts): void {
  const marks = body.flatMap((a) => [...a.querySelectorAll<HTMLElement>('sup[data-note]')])
  if (marks.length !== facts.notes.length) return
  const num = noteNumbers(facts.notes)
  const lists: { ol: HTMLOListElement; marks: { el: HTMLElement; k: number }[] }[] = []
  const listOf = (ol: HTMLOListElement | undefined) => {
    if (!ol) return null
    let l = lists.find((x) => x.ol === ol)
    if (!l) lists.push((l = { ol, marks: [] }))
    return l
  }
  marks.forEach((el, k) => {
    const sec = el.closest('section')
    const ol = facts.notes[k].part === 'endnotes' ? notes.endnotes[0] : notes.footnotes.find((o) => o.parentElement === sec)
    listOf(ol)?.marks.push({ el, k })
  })
  for (const ol of notes.endnotes) ol.style.listStyleType = 'lower-roman'
  for (const { ol, marks: ms } of lists) {
    const items = [...ol.children] as HTMLLIElement[]
    const at = ms.map(({ el }) => Number(el.textContent) - 1)
    if (at.some((i) => !items[i])) continue
    const used = new Set(at)
    items.forEach((li, i) => !used.has(i) && li.remove())
    ms.forEach(({ el, k }, i) => {
      const li = items[at[i]]
      const n = num[k]
      // The note's own text carries the author's mark, so the list adds no number.
      if (n === null) {
        li.style.listStyleType = 'none'
        return el.remove()
      }
      el.textContent = facts.notes[k].part === 'endnotes' ? lowerRoman(n) : String(n)
      li.value = n
    })
  }
}

/** Every `:host` rule in the document's sheets, nested ones too. docx-preview never writes one; a document that does
 *  is restyling the host, which can make it `position: fixed` and blank its own view. */
export function dropHostRules(root: ShadowRoot): void {
  const strip = (rules: CSSRuleList, del: (i: number) => void): void => {
    for (let i = rules.length - 1; i >= 0; i--) {
      const r = rules[i]
      if (r instanceof CSSStyleRule && r.selectorText.includes(':host')) del(i)
      else if (r instanceof CSSGroupingRule) strip(r.cssRules, (k) => r.deleteRule(k))
    }
  }
  for (const s of root.querySelectorAll('style')) if (s.sheet) strip(s.sheet.cssRules, (i) => s.sheet!.deleteRule(i))
}

/** Each part's paragraphs in document order with their own text, note marks and nested paragraphs left out. Sliced
 *  into tasks under 10ms, since a long document has tens of thousands of text nodes. */
export async function indexOf(root: ShadowRoot, live: () => boolean): Promise<Index | null> {
  const parts: Parts = { body: [], footnotes: [], endnotes: [], chrome: [] }
  const own = { acceptNode: (n: Node) => (n.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT : (n as Element).tagName === 'P' || (n as Element).hasAttribute('data-note') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP) }
  const lists: [keyof Parts, string][] = [
    ['body', 'section.docx > article p'],
    ['footnotes', 'section.docx > ol[data-part="footnotes"] p'],
    ['endnotes', 'section.docx > ol[data-part="endnotes"] p'],
    ['chrome', 'section.docx > header p, section.docx > footer p']
  ]
  let t0 = performance.now()
  for (const [part, sel] of lists) {
    for (const p of root.querySelectorAll<HTMLElement>(sel)) {
      const nodes: Text[] = []
      const starts: number[] = []
      let text = ''
      const walk = document.createTreeWalker(p, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, own)
      for (let t = walk.nextNode() as Text | null; t; t = walk.nextNode() as Text | null) {
        nodes.push(t)
        starts.push(text.length)
        text += t.data
      }
      parts[part].push({ text, el: p, nodes, starts })
      if (performance.now() - t0 > 8) {
        await new Promise((r) => setTimeout(r, 0))
        if (!live()) return null
        t0 = performance.now()
      }
    }
  }
  const flats = {} as Index['flats']
  for (const [part] of lists) {
    flats[part] = flatten(parts[part])
    await new Promise((r) => setTimeout(r, 0))
    if (!live()) return null
  }
  return { parts, flats }
}

/** A raw offset in a block's text as a DOM point. */
export function pointIn(b: Block, off: number): [Node, number] {
  for (let k = b.nodes.length - 1; k >= 0; k--) if (b.starts[k] <= off) return [b.nodes[k], Math.min(off - b.starts[k], b.nodes[k].length)]
  return [b.el, 0]
}

/** A DOM boundary as a raw offset in its block: inside a text node, or at the first of the block's text after it. */
export function offsetIn(b: Block, node: Node, offset: number): number {
  if (node.nodeType === Node.TEXT_NODE) {
    const k = b.nodes.indexOf(node as Text)
    if (k >= 0) return b.starts[k] + offset
  }
  const r = document.createRange()
  r.setStart(node, offset)
  const k = b.nodes.findIndex((t) => r.comparePoint(t, 0) >= 0)
  return k < 0 ? b.text.length : b.starts[k]
}

/** The segments in reading order. */
export const segmentsIn = (root: ShadowRoot): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('section.docx')]

/**
 * Clui's sheet over the document's, adopted by the shadow root. Flow is one paper column; skipped segments keep their
 * page height until they lay out; the marks are each a different shape, so none relies on colour.
 */
export const BASE_SHEET = `
:host { display: block; }
section.docx { content-visibility: auto; contain-intrinsic-size: auto var(--seg-h); }
section.docx[data-pinned] { content-visibility: visible; }
img { max-width: 100%; height: auto; }
[data-scroll="table"] { overflow-x: auto; }
[data-scroll="table"]:focus-visible { outline: 2px solid var(--color-ring); outline-offset: 2px; }
::selection { background: var(--color-text-selected); }
::highlight(docx-selected) { background-color: var(--color-text-selected); }
::highlight(docx-find) { background-color: color-mix(in oklab, var(--color-edge-dark) 18%, transparent); text-decoration: underline solid 1px var(--color-edge-dark); }
::highlight(docx-find-active) { background-color: var(--color-edge-dark); color: var(--color-edge-light); }
::highlight(docx-pointed) { text-decoration: underline dashed 2px var(--color-edge-dark); text-underline-offset: 3px; }
a:focus-visible { outline: 2px solid var(--color-ring); outline-offset: 1px; border-radius: 2px; }
a[aria-disabled] { cursor: default; }
[data-break] {
  display: flex; align-items: center; gap: 8px; padding: 0 24px; user-select: none;
  font: var(--text-meta) / var(--text-meta--line-height) var(--font-sans); color: var(--color-page-ink);
}
[data-break]::after { content: ''; flex: 1; height: 1px; background: color-mix(in oklab, var(--color-page-ink) 24%, transparent); }
`

/** Flow: the sections' page geometry is overridden so the column wraps to the pane; the inline styles docx-preview
 *  writes would otherwise win, hence !important. Repeated headers and footers are noise in one flow. */
export const FLOW_SHEET = `
section.docx { width: auto !important; min-height: 0 !important; padding: 24px !important; margin: 0 !important; box-shadow: none !important; overflow: visible !important; }
img { max-width: 100% !important; height: auto !important; }
@container docx (min-width: 488px) { section.docx { padding: 32px !important; } [data-break] { padding: 0 32px; } }
section.docx > header, section.docx > footer { display: none !important; }
`

/** Pages: each segment a page box at its own size, growing past its page height rather than clipping. Its gap and edge
 *  are screen pixels, so they divide out the zoom the whole document is under. */
export const PAGES_SHEET = `
section.docx { margin: 0 auto calc(12px / var(--z)); background-color: var(--color-page-canvas); box-shadow: 0 0 0 calc(1px / var(--z)) var(--color-page-edge); }
section.docx:last-of-type { margin-bottom: 0; }
[data-break] { display: none; }
`

/** Each section's page size at 100%, in CSS px, from the width and min-height docx-preview wrote. */
export function pageSizes(sections: HTMLElement[]): { w: number; h: number }[] {
  const probe = document.createElement('div')
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  document.body.append(probe)
  const out = sections.map((s) => {
    probe.style.width = s.style.width || '8.5in'
    probe.style.height = s.style.minHeight || '11in'
    const r = probe.getBoundingClientRect()
    return { w: r.width || 816, h: r.height || 1056 }
  })
  probe.remove()
  return out
}

/** For the probe's pinned-version check: the library rendering a fixture on its own, with no post-pass. */
export const docxTestHooks = {
  async bare(bytes: Uint8Array): Promise<{ marks: string[]; items: number }> {
    const { parseAsync, renderDocument } = await loadDocx()
    const nodes = await renderDocument(await parseAsync(bytes, OPTIONS), OPTIONS)
    const els = nodes.filter((n): n is HTMLElement => n.nodeType === Node.ELEMENT_NODE)
    return { marks: els.flatMap((e) => [...e.querySelectorAll('sup[data-note]')].map((s) => s.textContent ?? '')), items: els.reduce((n, e) => n + e.querySelectorAll(':scope > ol > li').length, 0) }
  }
}
