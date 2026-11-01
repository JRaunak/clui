import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { refsOf, useActive, useSession } from '../../store'
import { quoteOf, refKey, type DraftReference, type RefInput, type SourceVersion } from '../../../../shared/context'
import { clipName } from '../../../../shared/annotate'
import { CHUNK_MAX, type Refusal } from '../../../../shared/files'
import type { OfficeOpen, WordFacts, WordPart } from '../../../../shared/office'
import type { DocPlace } from '../../../../shared/surfaces'
import { FindField } from '../FindField'
import { IconTarget } from '../Icon'
import { usePopover } from '../Popover'
import { addFromSurface } from '../ContextChips'
import { ANNOUNCE_MS, SelectionBar } from './SelectionBar'
import { TEXT_BUTTON, ZoomGroup } from './ImageSurface'
import { baseOf, FIND_MAX, openDefault, SelectionNotice, SKELETON_MS, TEXT_BTN, VIEW_SETTLE_MS, setStatus, useFind } from './fileDoc'
import { useSay } from '../../lib/useSay'
import { linkTitle, openLink, useLinkTarget } from '../../lib/openLink'
import { POINT_OFF } from '../../lib/refCopy'
import { setPointing, takePoint, takeSurfaceFocus, usePointing, usePointRequest } from '../../lib/surfaceFocus'
import { reportFound } from '../../lib/pointedText'
import { clampScale, FIT_MARGIN, minScale, percent, round4, stepDown, stepUp, type Size } from '../../lib/imageView'
import { fitPage, fitWidth, PDF_MAX, PDF_STEPS, zoomSaid, type At, type DocZoom } from '../../lib/pdfView'
import { BASE_SHEET, breaksOf, dropHostRules, FLOW_SHEET, indexOf, loadDocx, offsetIn, OPTIONS, PAGES_SHEET, pageSizes, pointIn, postPass, segmentsIn, type Block, type Index } from '../../lib/docx'
import { clip40, foldCase, foldMarks, locateIn, matchesIn, occurrences, quoteIn } from '../../lib/docxView'

const STEPS = [0.5, 0.75, 1, 1.5, 2]
const MAX = 2
const GESTURE_IDLE_MS = 150
const REACH_MS = 500
const BACK_MAX = 50
const PARTS: WordPart[] = ['body', 'footnotes', 'endnotes']
const POINTING_SAID = 'Pointing. Select text, or press Shift and an arrow key to select paragraphs. Enter adds it.'
const POINT_HINT = 'Select text, or press Shift and an arrow key.'
const OUTSIDE = 'Select text in the document or in one of its notes.'
const PICTURE = "Pictures aren't quoted. Select text near it."
const NOTICE = {
  cleared: 'The document changed on disk, so the selection was cleared.',
  removed: 'The document changed on disk, so the selection was cleared and removed from the message.'
}
const LAYOUT_SAID = { pages: 'Showing pages', flow: 'Wrapping to the pane' }
const KEYS = 'Meta+Shift+A Meta+F Meta+Equal Meta+Minus Shift+ArrowDown Shift+ArrowUp'

type Flight = Extract<OfficeOpen, { t: 'word' }>
type Layout = 'flow' | 'pages'
interface View {
  host: HTMLDivElement
  root: ShadowRoot
  z: HTMLDivElement
  segs: HTMLElement[]
  revision: string
  facts: WordFacts
  /** Each segment's page size at 100%, and the widest. */
  sizes: Size[]
  maxW: number
  index: Index | null
  /** Every block in document order, for a boundary that isn't inside a paragraph, and where each one is. */
  order: { part: WordPart; i: number; el: HTMLElement }[]
  where: Map<Element, { part: WordPart; i: number }>
  /** Names each table scroller while its table overflows, which is also when it's a tab stop. */
  wide: ResizeObserver
}
type Sel = { part: WordPart; text: string; nth: number; blocks: { start: number; end: number }; heading?: string; tracked?: true }

let sheets: { base: CSSStyleSheet; flow: CSSStyleSheet; pages: CSSStyleSheet } | null = null
const sheetsOf = (): NonNullable<typeof sheets> => {
  if (sheets) return sheets
  const make = (css: string): CSSStyleSheet => {
    const s = new CSSStyleSheet()
    s.replaceSync(css)
    return s
  }
  return (sheets = { base: make(BASE_SHEET), flow: make(FLOW_SHEET), pages: make(PAGES_SHEET) })
}
const sheetsFor = (l: Layout): CSSStyleSheet[] => [sheetsOf().base, sheetsOf()[l]]
const nameWide = (es: ResizeObserverEntry[]): void => {
  for (const { target: w } of es) {
    if (w.scrollWidth > w.clientWidth + 1) w.setAttribute('role', 'group'), w.setAttribute('aria-label', 'Wide table')
    else w.removeAttribute('role'), w.removeAttribute('aria-label')
  }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const frames = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : `${n} ${many}`)
// The DOM typings know only the older rest-argument form; Chromium takes the options object.
const composed = (s: Selection, root: ShadowRoot): StaticRange[] => (s as unknown as { getComposedRanges(o: { shadowRoots: ShadowRoot[] }): StaticRange[] }).getComposedRanges({ shadowRoots: [root] })

/** The panel's sentences, in order, each only when it applies. */
export function layoutSentences(name: string, f: WordFacts, layout: Layout): string[] {
  return [
    `Clui laid out ${name} itself, without Word. The words, tables, pictures and notes are the document's; fonts, spacing and line breaks are Clui's, so it won't look exactly like Word.`,
    "Clui starts a new page only where the document has a page or section break, so pages aren't numbered and one can hold several of Word's.",
    f.strict && "It's saved as Strict Open XML, so Clui shows its text without the document's styles.",
    layout === 'flow' && 'Headers and footers show when you show pages.',
    Object.keys(f.tracked).length > 0 && "It has tracked changes, shown as if accepted: insertions in, deletions out.",
    f.comments > 0 && `${plural(f.comments, '1 comment', 'comments')} ${f.comments === 1 ? "isn't" : "aren't"} shown.`,
    f.charts > 0 && `${plural(f.charts, '1 chart', 'charts')} ${f.charts === 1 ? "isn't" : "aren't"} shown.`,
    f.diagrams > 0 && `${plural(f.diagrams, '1 diagram', 'diagrams')} ${f.diagrams === 1 ? "isn't" : "aren't"} shown.`,
    f.objects > 0 && `${plural(f.objects, '1 embedded object', 'embedded objects')} ${f.objects === 1 ? "isn't" : "aren't"} shown.`,
    f.fonts && "It includes its own fonts, which Clui doesn't use.",
    f.macros && 'This document contains macros. Clui never runs them.',
    f.links && "It links to other files or pictures. Clui doesn't load them, so they may be missing here."
  ].filter((s): s is string => !!s)
}

const selLabel = (s: Sel): string =>
  s.part !== 'body' ? `Text in ${s.part === 'footnotes' ? 'a footnote' : 'an endnote'} selected` : s.heading ? `Text under "${clipName(s.heading)}" selected` : 'Text selected'

/**
 * A .docx in the pane, laid out by Clui with docx-preview in a contained shadow root and saying so. One render serves
 * every place it scrolls to; a new version renders beside the old and swaps in whole. Text selects natively and
 * becomes a quote of its part; Claude's words are found in the same text.
 */
export function DocxSurface({ handleId, tabId, flight, onStale, onFailed }: { handleId: string; tabId: string; flight: Flight; onStale: () => void; onFailed: () => void }): JSX.Element {
  const tab = useActive((s) => s?.surfaces.tabs[tabId])
  const path = tab?.key ?? ''
  const name = baseOf(path)
  const owner = `${handleId}\0${path}`
  const setView = useSession((s) => s.setSurfaceView)
  const hasBrowser = useActive((s) => !!s?.browser)
  const linkTarget = useLinkTarget((s) => s.target)
  const [said, say] = useSay()

  const viewportEl = useRef<HTMLDivElement>(null)
  const frameEl = useRef<HTMLDivElement>(null)
  const [view, setV] = useState<View | null>(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const [indexed, setIndexed] = useState(0)
  const [version, setVersion] = useState<{ revision: string; version: SourceVersion } | null>(null)
  const vs0 = tab?.viewState?.kind === 'doc' ? tab.viewState : null
  const [layout, setLayout] = useState<Layout>(vs0?.layout === 'pages' ? 'pages' : 'flow')
  const layoutRef = useRef(layout)
  // Each layout keeps its own zoom: Flow a scale of the text, Pages a scale or a fit. Only the shown one is saved.
  const modes = useRef<{ flow: number; pages: DocZoom }>({
    flow: vs0?.layout !== 'pages' && typeof vs0?.zoom === 'number' ? Math.min(MAX, Math.max(STEPS[0], vs0.zoom)) : 1,
    pages: vs0?.layout === 'pages' ? vs0.zoom : 'fit-width'
  })
  const [zoom, setZoom] = useState<{ s: number; min: number; mode: DocZoom } | null>(null)
  const zoomRef = useRef(1)
  const [notice, setNotice] = useState<'cleared' | 'removed' | null>(null)
  const [blocked, setBlocked] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [pointed, setPointed] = useState<{ found: boolean } | null>(null)
  const [slow, setSlow] = useState(false)
  const loadGen = useRef(0)
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SKELETON_MS)
    return () => clearTimeout(t)
  }, [])

  const raw = tab?.selection
  const selJson = JSON.stringify(
    raw?.part && raw.text && raw.blocks
      ? { part: raw.part, text: raw.text, nth: raw.nth ?? 0, blocks: raw.blocks, ...(raw.heading ? { heading: raw.heading } : {}), ...(raw.tracked ? { tracked: true } : {}) }
      : null
  )
  const selection = useMemo<Sel | null>(() => JSON.parse(selJson), [selJson])
  const highlight = tab?.highlight?.text ? tab.highlight : null
  const location = tab?.location
  const tabNow = () => useSession.getState().sessions[handleId]?.surfaces.tabs[tabId]
  const sentences = useMemo(() => layoutSentences(name, flight.facts, layout), [name, flight.facts, layout])

  // Where the reader is: the segment at the viewport's top and how far down it.
  const segAt = (v: View, y: number): number => {
    let lo = 0
    let hi = v.segs.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (v.segs[mid].getBoundingClientRect().bottom <= y) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  const placeNow = (): DocPlace | null => {
    const v = viewRef.current
    const c = viewportEl.current
    if (!v || !c || !v.segs.length) return null
    const top = c.getBoundingClientRect().top
    const i = segAt(v, top + 1)
    const r = v.segs[i].getBoundingClientRect()
    return { page: i + 1, offset: round4(Math.min(1, Math.max(0, (top - r.top) / Math.max(1, r.height)))) }
  }
  const findRef = useRef(tab?.viewState?.kind === 'doc' ? (tab.viewState.find ?? '') : '')
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  const saveNow = (): void => {
    clearTimeout(saveTimer.current)
    const p = placeNow()
    if (!p) return
    const find = findRef.current
    const l = layoutRef.current
    setView(handleId, tabId, { viewState: { kind: 'doc', page: p.page, zoom: modes.current[l], offset: p.offset, layout: l, ...(find ? { find } : {}) } })
  }
  const save = (): void => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(saveNow, VIEW_SETTLE_MS)
  }

  /**
   * Every scroll Clui makes: pin the target's segment so it lays out next frame, scroll to where the target sits,
   * and set it again after each segment resize, before paint, until the user moves or 500ms pass.
   */
  const reachStop = useRef<(() => void) | null>(null)
  const reach = (seg: number, at: () => number | null): void => {
    reachStop.current?.()
    const v = viewRef.current
    const c = viewportEl.current
    if (!v || !c) return
    const s = v.segs[Math.min(v.segs.length - 1, Math.max(0, seg))]
    s?.setAttribute('data-pinned', '')
    const apply = (): void => {
      const y = at()
      if (y !== null) c.scrollTop = y
    }
    apply()
    const ro = new ResizeObserver(apply)
    for (const x of v.segs) ro.observe(x)
    const user = ['wheel', 'keydown', 'pointerdown', 'touchstart'] as const
    const stop = (): void => {
      ro.disconnect()
      clearTimeout(t)
      s?.removeAttribute('data-pinned')
      for (const e of user) c.removeEventListener(e, stop, true)
      if (reachStop.current === stop) reachStop.current = null
      save()
    }
    const t = setTimeout(stop, REACH_MS)
    for (const e of user) c.addEventListener(e, stop, { capture: true, passive: true })
    reachStop.current = stop
  }
  /** The document y of a rect's top in the viewport's scroll space. */
  const yOf = (top: number): number => {
    const c = viewportEl.current!
    return top - c.getBoundingClientRect().top + c.scrollTop
  }
  const reachPlace = (p: DocPlace): void => {
    const v = viewRef.current
    if (!v) return
    const i = Math.min(v.segs.length, Math.max(1, p.page)) - 1
    reach(i, () => {
      const r = v.segs[i]?.getBoundingClientRect()
      return r ? yOf(r.top) + p.offset * r.height : null
    })
  }
  const reachRange = (r: Range, align: 'top' | 'center'): void => {
    const v = viewRef.current
    const c = viewportEl.current
    const seg = r.startContainer.parentElement?.closest('section.docx')
    if (!v || !c) return
    reach(seg ? v.segs.indexOf(seg as HTMLElement) : 0, () => {
      const b = r.getBoundingClientRect()
      if (!b.height && !b.width) return null
      return align === 'top' ? yOf(b.top) - 24 : yOf(b.top) - (c.clientHeight - b.height) / 2
    })
  }

  /** The paragraph at the viewport's top and how far into it the top sits, as a reach that puts it back there once
   *  the layout under it has moved. */
  const keepTop = (): (() => void) => {
    const v = viewRef.current
    const c = viewportEl.current
    if (!v || !c || !v.segs.length) return () => {}
    const top = c.getBoundingClientRect().top
    const seg = segAt(v, top + 1)
    // This segment's paragraphs only: asking where one in a skipped segment is lays that segment out to answer.
    const el = [...v.segs[seg].querySelectorAll<HTMLElement>(':scope > article p, :scope > ol p')].find((p) => p.getBoundingClientRect().bottom > top)
    if (!el) {
      const p = placeNow()
      return () => p && reachPlace(p)
    }
    const r0 = el.getBoundingClientRect()
    const frac = (top - r0.top) / Math.max(1, r0.height)
    return () =>
      reach(seg, () => {
        const r = el.getBoundingClientRect()
        return yOf(r.top) + frac * r.height
      })
  }

  const rangeOf = (part: keyof Index['parts'], a: At, b: At): Range | null => {
    const paras = viewRef.current?.index?.parts[part]
    if (!paras?.[a.i] || !paras[b.i]) return null
    const r = document.createRange()
    r.setStart(...pointIn(paras[a.i], a.off))
    r.setEnd(...pointIn(paras[b.i], b.off))
    return r
  }

  // Bytes at the pre-flight's revision, then parse, render and the post-pass, each in its own task; the nodes reach the
  // live document only once all of it has run.
  useEffect(() => {
    const g = ++loadGen.current
    void (async () => {
      const chunks = await Promise.all(
        Array.from({ length: Math.ceil(flight.size / CHUNK_MAX) }, (_, k) =>
          window.clui.docRead(handleId, path, flight.revision, k * CHUNK_MAX, Math.min(CHUNK_MAX, flight.size - k * CHUNK_MAX)).catch((): Refusal => ({ ok: false, reason: 'unreadable' }))
        )
      )
      if (g !== loadGen.current) return
      if (chunks.some((c) => !c.ok)) return onStale()
      const bytes = new Uint8Array(flight.size)
      chunks.forEach((c, k) => c.ok && bytes.set(c.bytes, k * CHUNK_MAX))
      let nodes: Node[]
      try {
        const lib = await loadDocx()
        await tick()
        const doc = await lib.parseAsync(bytes, OPTIONS)
        await tick()
        const breaks = breaksOf(doc)
        nodes = await lib.renderDocument(doc, OPTIONS)
        await tick()
        postPass(nodes, flight.facts, breaks)
      } catch {
        if (g === loadGen.current) onFailed()
        return
      }
      await tick()
      if (g !== loadGen.current || !frameEl.current) return
      mount(nodes, g)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flight.revision])

  const mount = (nodes: Node[], g: number): void => {
    const frame = frameEl.current!
    const old = viewRef.current
    const host = document.createElement('div')
    host.dataset.ui = 'docx-host'
    if (old) host.style.cssText = 'position:absolute;inset:0 0 auto 0;visibility:hidden'
    frame.append(host)
    const root = host.attachShadow({ mode: 'open' })
    root.adoptedStyleSheets = sheetsFor(layoutRef.current)
    const z = document.createElement('div')
    z.id = 'z'
    const styles = nodes.filter((n) => n.nodeName === 'STYLE')
    z.append(...nodes.filter((n) => n.nodeName !== 'STYLE' && n.nodeType === Node.ELEMENT_NODE))
    root.append(...styles, z)
    dropHostRules(root)
    for (const a of root.querySelectorAll<HTMLAnchorElement>('a')) {
      const href = a.getAttribute('href') ?? ''
      const scheme = URL.parse(href)?.protocol
      if (href.startsWith('#') && href.length > 1) continue
      if (scheme === 'http:' || scheme === 'https:') a.title = linkTitle(href, hasBrowser, linkTarget)
      else if (scheme !== 'mailto:') {
        a.removeAttribute('href')
        a.setAttribute('role', 'link')
        a.setAttribute('aria-disabled', 'true')
        a.tabIndex = 0
        a.title = scheme ? `Clui doesn't follow ${scheme.slice(0, -1)} links from a document.` : "Clui doesn't follow this kind of link from a document."
      }
    }
    const segs = segmentsIn(root)
    const sizes = pageSizes(segs)
    const next: View = { host, root, z, segs, revision: flight.revision, facts: flight.facts, sizes, maxW: Math.max(0, ...sizes.map((p) => p.w)) || 816, index: null, order: [], where: new Map(), wide: new ResizeObserver(nameWide) }
    for (const w of root.querySelectorAll('[data-scroll="table"]')) next.wide.observe(w)
    const l = layoutRef.current
    const vs = tabNow()?.viewState
    const z0 = scaleOf(next, l, modes.current[l], old ? curSeg(old) : vs?.kind === 'doc' ? vs.page - 1 : 0)
    applyZoom(next, l, z0.s)
    const show = (): void => {
      if (g !== loadGen.current) return next.wide.disconnect(), host.remove()
      const place = old ? placeNow() : null
      old?.wide.disconnect()
      old?.host.remove()
      host.style.cssText = ''
      setV(next)
      viewRef.current = next
      setZoom({ ...z0, mode: modes.current[l] })
      setVersion(null)
      setStatus(owner, 'binary')
      const t = tabNow()
      const saved = t?.viewState?.kind === 'doc' ? { page: t.viewState.page, offset: t.viewState.offset } : null
      const at = place ?? saved
      if (at && !t?.location?.text && !(t?.selection?.part && !old)) reachPlace(at)
      // The text index waits for the first paint: it walks every paragraph.
      setTimeout(() => void index(next), 0)
    }
    if (old) void frames().then(show)
    else show()
  }

  const index = async (v: View): Promise<void> => {
    const ix = await indexOf(v.root, () => viewRef.current === v)
    if (!ix || viewRef.current !== v) return
    for (const part of PARTS) ix.parts[part].forEach((b, i) => v.where.set(b.el, { part, i }))
    v.order = [...v.root.querySelectorAll<HTMLElement>('p')].flatMap((el) => {
      const w = v.where.get(el)
      return w ? [{ ...w, el }] : []
    })
    v.index = ix
    setIndexed((n) => n + 1)
    void window.clui
      .docVersion(handleId, path, v.revision)
      .catch((): Refusal => ({ ok: false, reason: 'unreadable' }))
      .then((r) => {
        if (viewRef.current !== v) return
        if (r.ok) setVersion({ revision: v.revision, version: r.version })
        else onStale()
      })
  }

  useEffect(
    () => () => {
      loadGen.current++
      reachStop.current?.()
      viewRef.current?.wide.disconnect()
      clearTimeout(saveTimer.current)
      clearTimeout(zoomSay.current)
      clearTimeout(idle.current)
      for (const n of ['docx-selected', 'docx-find', 'docx-find-active', 'docx-pointed']) CSS.highlights.delete(n)
      setStatus(owner, null)
    },
    [owner]
  )

  // A new version keeps a selection whose quote is still there exactly once in its part.
  const shownRev = useRef<string | null>(null)
  useEffect(() => {
    const v = viewRef.current
    if (!v?.index) return
    const was = shownRev.current
    shownRev.current = v.revision
    if (!was || was === v.revision) return
    setView(handleId, tabId, { back: undefined })
    const sel = selRef.current.selection
    if (!sel) return
    const flat = v.index.flats[sel.part]
    const at = occurrences(flat, sel.text) === 1 ? locateIn(flat, sel.text, 0) : null
    if (at && !selRef.current.attached) {
      emitted.current = JSON.stringify({ ...sel, nth: 0, blocks: { start: at.a.i + 1, end: at.b.i + 1 } })
      return setView(handleId, tabId, { selection: { ...sel, nth: 0, blocks: { start: at.a.i + 1, end: at.b.i + 1 } } })
    }
    const inMessage = selRef.current.attached
    setView(handleId, tabId, { selection: undefined })
    setNotice(inMessage ? 'removed' : 'cleared')
    say(NOTICE[inMessage ? 'removed' : 'cleared'])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexed])

  // The kept selection, Claude's mark and find's matches are highlights over the shadow text.
  const liveSelection = (): boolean => {
    const v = viewRef.current
    const s = window.getSelection()
    if (!v || !s || s.isCollapsed) return false
    const [r] = composed(s, v.root)
    return !!r && !r.collapsed && v.root.contains(r.startContainer)
  }
  useEffect(() => {
    const v = viewRef.current
    const at = selection && v?.index ? locateIn(v.index.flats[selection.part], selection.text, selection.nth) : null
    const r = at && selection ? rangeOf(selection.part, at.a, at.b) : null
    const kept = r ? new Highlight(r) : null
    const paint = (): void => {
      if (kept && !liveSelection()) CSS.highlights.set('docx-selected', kept)
      else CSS.highlights.delete('docx-selected')
    }
    paint()
    document.addEventListener('selectionchange', paint)
    return () => document.removeEventListener('selectionchange', paint)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, indexed])

  // A selection set from outside, a chip's, comes to the viewport's top.
  const emitted = useRef<string | null>(null)
  useEffect(() => {
    const v = viewRef.current
    if (!v?.index || !selection || selJson === emitted.current) return
    emitted.current = selJson
    const at = locateIn(v.index.flats[selection.part], selection.text, selection.nth)
    const r = at && rangeOf(selection.part, at.a, at.b)
    if (r) reachRange(r, 'top')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selJson, indexed])

  /** Claude's words: the nth match across the parts in order, case and spacing ignored, accents kept. */
  const applied = useRef<typeof location | null>(null)
  useEffect(() => {
    const v = viewRef.current
    if (!v?.index || !location?.text || applied.current === location) return
    applied.current = location
    const want = location.nth ?? 0
    let left = want
    for (const part of PARTS) {
      const ms = matchesIn(v.index.flats[part], location.text, foldCase, left + 1)
      if (ms.length > left) {
        const r = rangeOf(part, ms[left].a, ms[left].b)
        if (r) {
          CSS.highlights.set('docx-pointed', new Highlight(r))
          reachRange(r, 'top')
        }
        setView(handleId, tabId, { highlight: { text: location.text, nth: want, part } })
        setPointed({ found: true })
        return reportFound(tabId, true)
      }
      left -= ms.length
    }
    CSS.highlights.delete('docx-pointed')
    setPointed({ found: false })
    reportFound(tabId, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, indexed])
  useEffect(() => {
    if (highlight) return
    CSS.highlights.delete('docx-pointed')
    setPointed(null)
  }, [highlight])

  // Selection: the native one for ⌘C, quoted into the tab's on release.
  const selRef = useRef<{ selection: Sel | null; attached: boolean }>({ selection, attached: false })
  const edge = (v: View, node: Node, offset: number, end: boolean): { part: WordPart; i: number; off: number } | null => {
    const parts = v.index!.parts
    const el = node instanceof Element ? node : node.parentElement
    if (!el || el.closest('section.docx > header, section.docx > footer')) return null
    const p = el.closest('p')
    const b = p && v.where.get(p)
    if (b) return { ...b, off: offsetIn(parts[b.part][b.i], node, offset) }
    const r = document.createRange()
    r.setStart(node, offset)
    const k = end ? v.order.findLastIndex((o) => r.comparePoint(o.el, 0) < 0) : v.order.findIndex((o) => r.comparePoint(o.el, 0) >= 0)
    const o = v.order[k]
    return o ? { part: o.part, i: o.i, off: end ? parts[o.part][o.i].text.length : 0 } : null
  }
  const quoteOfRange = (part: WordPart, a: At, b: At): Sel | null => {
    const v = viewRef.current
    const paras = v?.index?.parts[part]
    if (!v?.index || !paras) return null
    const q = quoteIn(v.index.flats[part], a, b)
    if (!q) return null
    let heading: string | undefined
    if (part === 'body')
      for (let i = q.first; i >= 0; i--)
        if (paras[i].el.getAttribute('role') === 'heading') {
          heading = paras[i].text.replace(/\s+/g, ' ').trim().slice(0, 200) || undefined
          break
        }
    return { part, text: q.text, nth: q.nth, blocks: { start: q.first + 1, end: q.last + 1 }, ...(heading ? { heading } : {}), ...(v.facts.tracked[part] ? { tracked: true as const } : {}) }
  }
  const selectionNow = (): Sel | 'outside' | 'picture' | null => {
    const v = viewRef.current
    const s = window.getSelection()
    if (!v?.index || !s || s.isCollapsed) return null
    const [r] = composed(s, v.root)
    if (!r || r.collapsed || !v.root.contains(r.startContainer)) return null
    const a = edge(v, r.startContainer, r.startOffset, false)
    const b = edge(v, r.endContainer, r.endOffset, true)
    if (!a || !b || a.part !== b.part) return 'outside'
    return quoteOfRange(a.part, a, b) ?? 'picture'
  }
  const setSelection = (next: Sel | null): void => {
    if (JSON.stringify(next) === selJson) return
    emitted.current = JSON.stringify(next)
    setAdding(false)
    setNotice(null)
    setBlocked(null)
    setView(handleId, tabId, { selection: next ? { ...next } : undefined, highlight: undefined })
  }
  const kbd = useRef<{ part: WordPart; anchor: number; focus: number } | null>(null)
  const onMouseUp = (): void => {
    const next = selectionNow()
    if (!next) return
    kbd.current = null
    if (next === 'outside' || next === 'picture') {
      setSelection(null)
      setBlocked(next === 'outside' ? OUTSIDE : PICTURE)
      return say(next === 'outside' ? OUTSIDE : PICTURE)
    }
    setSelection(next)
  }

  /** Shift and an arrow: no selection selects the first paragraph in view; one moves its active end a paragraph. */
  const stepBlock = (dir: 1 | -1): void => {
    const v = viewRef.current
    const c = viewportEl.current
    if (!v?.index || !c) return
    const parts = v.index.parts
    const text = (b: Block): boolean => !!b.text.trim()
    let cur = kbd.current
    if (!cur && selection) cur = { part: selection.part, anchor: selection.blocks.start - 1, focus: selection.blocks.end - 1 }
    if (!cur) {
      // From the segment at the top on, so no segment above it, skipped or not, is asked where its paragraphs are.
      const top = c.getBoundingClientRect().top
      let o: { part: WordPart; i: number } | undefined
      for (let k = segAt(v, top + 1); k < v.segs.length && !o; k++)
        for (const el of v.segs[k].querySelectorAll<HTMLElement>(':scope > article p, :scope > ol p')) {
          const w = v.where.get(el)
          if (w && text(parts[w.part][w.i]) && el.getBoundingClientRect().top >= top) {
            o = w
            break
          }
        }
      if (!o) return
      cur = { part: o.part, anchor: o.i, focus: o.i }
    } else {
      const paras = parts[cur.part]
      let j = cur.focus + dir
      while (paras[j] && !text(paras[j])) j += dir
      if (paras[j]) cur = { ...cur, focus: j }
    }
    kbd.current = cur
    const paras = parts[cur.part]
    const [i, j] = [cur.anchor, cur.focus].sort((x, y) => x - y)
    const a = { i, off: 0 }
    const b = { i: j, off: paras[j].text.length }
    const r = rangeOf(cur.part, a, b)
    if (r) window.getSelection()?.setBaseAndExtent(r.startContainer, r.startOffset, r.endContainer, r.endOffset)
    const next = quoteOfRange(cur.part, a, b)
    if (next) setSelection(next)
    paras[cur.focus].el.scrollIntoView({ block: 'nearest' })
  }

  const pointing = usePointing(tabId)
  const asked = usePointRequest(tabId)
  useEffect(() => {
    if (!asked || !view || !takePoint(tabId)) return
    if (pointing) {
      setPointing(tabId, false)
      return say(POINT_OFF)
    }
    setPointing(tabId, true)
    viewportEl.current?.focus({ preventScroll: true })
    say(POINTING_SAID)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, view])
  useEffect(() => () => setPointing(tabId, false), [tabId])

  // The reference: the selection's quote at the version of the bytes the view was laid out from.
  const input = useMemo<RefInput | null>(() => {
    if (!view || !selection || version?.revision !== view.revision) return null
    const q = quoteOf(selection.text)
    return {
      kind: 'docx',
      path,
      sourceVersion: version.version,
      part: selection.part,
      blocks: selection.blocks,
      text: { quote: q.quote, nth: selection.nth, ...(q.elided ? { elided: true as const } : {}) },
      ...(selection.heading ? { heading: selection.heading } : {}),
      ...(selection.tracked ? { tracked: true as const } : {})
    }
  }, [view, selection, version, path])
  const key = input ? refKey(input) : null
  const isThis = (d: DraftReference): boolean => !!key && refKey(d.ref) === key
  const attached = useActive((s) => !!s && !!key && [s.contextRefs, ...s.queuedMessages.map((q) => q.refs)].some((l) => l.some(isThis)))
  const inTarget = useActive((s) => !!s && !!key && !!refsOf(s, s.referenceEditTarget)?.some(isThis))
  selRef.current = { selection, attached }
  const refsHere = useActive((s) => (s ? [s.contextRefs, ...s.queuedMessages.map((q) => q.refs)].flat().filter(({ ref: r }) => r.kind === 'docx' && r.path === path).length : 0))
  const prevHere = useRef({ selection, refsHere })
  useEffect(() => {
    const prev = prevHere.current
    prevHere.current = { selection, refsHere }
    if (prev.selection && !selection && refsHere < prev.refsHere) setNotice('removed')
  }, [selection, refsHere])
  const label = selection ? selLabel(selection) : ''
  const selSay = useRef<ReturnType<typeof setTimeout>>()
  const hadSel = useRef(false)
  useEffect(() => {
    if (!label && !hadSel.current) return
    hadSel.current = !!label
    const t = (selSay.current = setTimeout(() => say(label || 'Selection cleared'), ANNOUNCE_MS))
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label])
  const add = async (): Promise<void> => {
    const v = viewRef.current
    if (!v || !selection || !input) return
    clearTimeout(selSay.current)
    setAdding(true)
    const st = await window.clui.statFile(handleId, path).catch(() => null)
    setAdding(false)
    if (!st?.ok || st.revision !== v.revision) {
      setView(handleId, tabId, { selection: undefined })
      setNotice('cleared')
      say(NOTICE.cleared)
      return onStale()
    }
    addFromSurface(handleId, input, say)
  }

  // Find: the folded text of every part, each match a highlight range, the active one at the viewport's centre.
  const { query, setQuery, deferred, current, setCurrent, input: findInput } = useFind(
    findOpen,
    setFindOpen,
    () => !!viewRef.current,
    (by) => setCurrent((c) => c + by)
  )
  useEffect(() => {
    const v = tab?.viewState?.kind === 'doc' ? tab.viewState.find : undefined
    if (v) {
      setQuery(v)
      setFindOpen(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const matches = useMemo(() => {
    const v = viewRef.current
    if (!findOpen || !deferred.trim() || !v?.index) return null
    const out: Range[] = []
    for (const part of layout === 'pages' ? [...PARTS, 'chrome' as const] : PARTS) {
      for (const m of matchesIn(v.index.flats[part], deferred, foldMarks, FIND_MAX - out.length)) {
        const r = rangeOf(part, m.a, m.b)
        if (r) out.push(r)
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findOpen, deferred, indexed, layout])
  const total = matches?.length ?? 0
  const at = total ? ((current % total) + total) % total : 0
  const shownIn = useRef(layout)
  const totalWas = useRef(0)
  useEffect(() => {
    findRef.current = findOpen ? deferred : ''
    if (findOpen) save()
    // A layout switch keeps the reader's place, even when it shows or hides header matches: the count changes and is
    // said, and only Enter or ⌘G goes to a match.
    const switched = shownIn.current !== layout
    shownIn.current = layout
    const n = matches?.length ?? 0
    // One announcement: the switch's own words would otherwise be replaced by the count.
    if (switched && matches && n !== totalWas.current) say(`${LAYOUT_SAID[layout]}. ${n ? `${at + 1} of ${n >= FIND_MAX ? '10,000+' : n.toLocaleString('en-US')}` : 'No matches'}`)
    totalWas.current = n
    if (!matches?.length) {
      CSS.highlights.delete('docx-find')
      CSS.highlights.delete('docx-find-active')
      return
    }
    CSS.highlights.set('docx-find', new Highlight(...matches.filter((_, i) => i !== at)))
    CSS.highlights.set('docx-find-active', new Highlight(matches[at]))
    if (!switched) reachRange(matches[at], 'center')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, at, layout])
  const totalText = total >= FIND_MAX ? '10,000+' : total.toLocaleString('en-US')
  const countText = !deferred.trim() || !matches ? '' : total ? `${at + 1} of ${totalText}` : 'No matches'
  const statusText = countText && (total ? `Match ${at + 1} of ${totalText}` : 'No matches')
  const closeFind = (): void => {
    setQuery('')
    setFindOpen(false)
    requestAnimationFrame(() => viewportEl.current?.focus())
  }

  // Flow's zoom scales the text and the column re-wraps; Pages' scales the boxes, and its fits follow the pane. The
  // paragraph at the top stays at the top either way.
  const vpSize = (): Size => ({ w: viewportEl.current?.clientWidth ?? 0, h: viewportEl.current?.clientHeight ?? 0 })
  const curSeg = (v: View): number => {
    const c = viewportEl.current
    return c && v.segs.length ? segAt(v, c.getBoundingClientRect().top + 1) : 0
  }
  /** The scale a layout's zoom comes to in this pane, and the smallest it can go. */
  const scaleOf = (v: View, l: Layout, m: DocZoom, seg: number): { s: number; min: number } => {
    if (l === 'flow') return { s: typeof m === 'number' ? Math.min(MAX, Math.max(STEPS[0], m)) : 1, min: STEPS[0] }
    const fit = fitPage(v.sizes[Math.min(v.sizes.length - 1, Math.max(0, seg))] ?? { w: 816, h: 1056 }, vpSize())
    const s = m === 'fit-width' ? fitWidth([v.maxW], vpSize().w) : m === 'fit-page' ? fit : clampScale(m, fit, PDF_STEPS)
    return { s, min: minScale(fit, PDF_STEPS) }
  }
  const applyZoom = (v: View, l: Layout, s: number): void => {
    zoomRef.current = s
    v.z.style.zoom = String(s)
    v.z.style.setProperty('--z', String(s))
    const f = frameEl.current
    if (!f) return
    f.dataset.layout = l
    f.style.maxWidth = l === 'flow' ? `${v.maxW * s}px` : ''
    f.style.width = l === 'pages' ? `${v.maxW * s}px` : ''
  }
  const maxOf = (l: Layout): number => (l === 'flow' ? MAX : PDF_MAX)
  const zoomSay = useRef<ReturnType<typeof setTimeout>>()
  /** Zooms to `m`, keeping the paragraph at the top, or with `page-top` bringing the current segment's top to the viewport's. */
  const zoomTo = (m: DocZoom, keep: 'top' | 'page-top' = 'top', announce = true): void => {
    const v = viewRef.current
    if (!v) return
    const l = layoutRef.current
    const seg = curSeg(v)
    const back = keep === 'top' ? keepTop() : null
    const z = scaleOf(v, l, m, seg)
    const mode = typeof m === 'number' ? z.s : m
    if (l === 'flow') modes.current.flow = z.s
    else modes.current.pages = mode
    applyZoom(v, l, z.s)
    setZoom({ ...z, mode })
    if (back) back()
    else
      reach(seg, () => {
        const r = v.segs[seg]?.getBoundingClientRect()
        return r ? yOf(r.top) - FIT_MARGIN : null
      })
    if (announce) {
      clearTimeout(zoomSay.current)
      zoomSay.current = setTimeout(() => say(zoomSaid(z.s, mode, z.min, percent, maxOf(l))), ANNOUNCE_MS)
    }
    save()
  }
  const step = (dir: 1 | -1): void => {
    if (!zoom) return
    const l = layoutRef.current
    const steps = l === 'flow' ? STEPS : PDF_STEPS
    if ((dir > 0 && zoom.s >= maxOf(l) - 1e-6) || (dir < 0 && zoom.s <= zoom.min + 1e-6)) return say(zoomSaid(zoom.s, zoom.mode, zoom.min, percent, maxOf(l)))
    zoomTo(dir > 0 ? stepUp(zoom.s, steps) : stepDown(zoom.s, zoom.min, steps))
  }
  const toggleFit = (): void => {
    if (layoutRef.current !== 'pages') return
    if (modes.current.pages === 'fit-width') zoomTo('fit-page', 'page-top')
    else zoomTo('fit-width')
  }

  // One set of nodes under two sheets, so the switch keeps the selection, the marks and every reference.
  const switchLayout = (): void => {
    const v = viewRef.current
    if (!v) return
    const next: Layout = layoutRef.current === 'flow' ? 'pages' : 'flow'
    const z = scaleOf(v, next, modes.current[next], curSeg(v))
    const back = keepTop()
    v.root.adoptedStyleSheets = sheetsFor(next)
    layoutRef.current = next
    setLayout(next)
    applyZoom(v, next, z.s)
    setZoom({ ...z, mode: modes.current[next] })
    back()
    say(LAYOUT_SAID[next])
    // Saved at once rather than after the settle delay: the View menu's fit item follows the saved layout.
    saveNow()
  }

  // Pages' fits stay fits across a pane resize or Expand.
  useEffect(() => {
    const c = viewportEl.current
    if (!c || !view) return
    let w = c.clientWidth
    let h = c.clientHeight
    const ro = new ResizeObserver(() => {
      if (c.clientWidth === w && c.clientHeight === h) return
      w = c.clientWidth
      h = c.clientHeight
      const m = modes.current.pages
      if (layoutRef.current === 'pages' && typeof m !== 'number') zoomToRef.current(m, 'top', false)
    })
    ro.observe(c)
    return () => ro.disconnect()
  }, [view])

  // Back from a bookmark: the place it left, in the version it was made in.
  const goBack = (): void => {
    const v = viewRef.current
    const b = useSession.getState().sessions[handleId]?.surfaces.tabs[tabId]?.back
    const pages = b?.pages
    const p = pages?.at(-1)
    if (!p || !pages || !v || b?.revision !== v.revision) return
    setView(handleId, tabId, { back: pages.length > 1 ? { revision: v.revision, pages: pages.slice(0, -1) } : undefined })
    reachPlace(p)
    viewportEl.current?.focus({ preventScroll: true })
  }
  const menu = useRef({ step, toggleFit, goBack })
  menu.current = { step, toggleFit, goBack }
  useEffect(
    () =>
      window.clui.onMenuAction((a) => {
        if (a === 'image-zoom-in') menu.current.step(1)
        else if (a === 'image-zoom-out') menu.current.step(-1)
        else if (a === 'image-zoom-toggle') menu.current.toggleFit()
        else if (a === 'pane-back') menu.current.goBack()
      }),
    []
  )

  // Pinch and ⌘-wheel scale by transform while the gesture runs, then commit the zoom once at rest.
  const idle = useRef<ReturnType<typeof setTimeout>>()
  const zoomToRef = useRef(zoomTo)
  zoomToRef.current = zoomTo
  useEffect(() => {
    const c = viewportEl.current
    const f = frameEl.current
    if (!c || !f) return
    let k = 1
    const onWheel = (e: WheelEvent): void => {
      const v = viewRef.current
      if (!(e.ctrlKey || e.metaKey) || !v) return
      e.preventDefault()
      const s0 = zoomRef.current
      const l = layoutRef.current
      const min = l === 'flow' ? STEPS[0] : scaleOf(v, l, s0, curSeg(v)).min
      if (k === 1) {
        const r = f.getBoundingClientRect()
        f.style.transformOrigin = `${e.clientX - r.left}px ${e.clientY - r.top}px`
      }
      k = Math.min(maxOf(l), Math.max(min, s0 * k * Math.exp(-e.deltaY * 0.01))) / s0
      f.style.transform = `scale(${k})`
      clearTimeout(idle.current)
      idle.current = setTimeout(() => {
        const done = k
        k = 1
        f.style.transform = ''
        f.style.transformOrigin = ''
        if (done !== 1) zoomToRef.current(round4(s0 * done))
      }, GESTURE_IDLE_MS)
    }
    c.addEventListener('wheel', onWheel, { passive: false })
    return () => c.removeEventListener('wheel', onWheel)
  }, [])

  // Links never navigate: a bookmark goes to its place with one to come back to, the web through openLink.
  const down = useRef<{ x: number; y: number } | null>(null)
  const follow = (a: HTMLAnchorElement, meta: boolean): void => {
    const v = viewRef.current
    const href = a.getAttribute('href')
    if (!v || href === null) return
    if (!href.startsWith('#')) return void openLink(href, meta)
    const target = v.root.getElementById(decodeURIComponent(href.slice(1)))
    if (!target) return say("This link's destination isn't in the document.")
    const from = placeNow()
    const b = useSession.getState().sessions[handleId]?.surfaces.tabs[tabId]?.back
    if (from) setView(handleId, tabId, { back: { revision: v.revision, pages: [...(b?.pages && b.revision === v.revision ? b.pages : []), from].slice(-BACK_MAX) } })
    // A bookmark is an empty span, so its paragraph is what has a place.
    const r = document.createRange()
    r.selectNode(target.closest('p') ?? target)
    reachRange(r, 'top')
    viewportEl.current?.focus({ preventScroll: true })
  }
  const anchorOf = (e: Event): HTMLAnchorElement | null => (e.composedPath().find((n) => n instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined) ?? null
  const onClick = (e: ReactMouseEvent): void => {
    const a = anchorOf(e.nativeEvent)
    const at = down.current
    down.current = null
    if (a) {
      e.preventDefault()
      if (a.hasAttribute('href') && e.button === 0) follow(a, e.metaKey || e.ctrlKey)
      return
    }
    if (!selection || !at || e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    if (Math.hypot(e.clientX - at.x, e.clientY - at.y) > 3 || liveSelection()) return
    kbd.current = null
    setSelection(null)
  }
  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.target !== e.currentTarget) return
    if (e.shiftKey && !e.altKey && !e.metaKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      return stepBlock(e.key === 'ArrowDown' ? 1 : -1)
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && selection) {
      e.preventDefault()
      return void add()
    }
    if (e.key === 'Escape') {
      if (selection) {
        e.preventDefault()
        window.getSelection()?.removeAllRanges()
        kbd.current = null
        return setSelection(null)
      }
      if (highlight) {
        e.preventDefault()
        return setView(handleId, tabId, { highlight: undefined })
      }
      if (pointing) {
        e.preventDefault()
        setPointing(tabId, false)
        say(POINT_OFF)
      }
    }
  }

  // A user open focuses the document once it's laid out.
  useEffect(() => {
    if (!view) return
    const via = takeSurfaceFocus(tabId)
    if (!via) return
    const opts: FocusOptions & { focusVisible?: boolean } = { preventScroll: true, focusVisible: via === 'keyboard' }
    viewportEl.current?.focus(opts)
  }, [view, tabId])

  const panel = usePopover({ placement: 'down', align: 'start' })
  const head = `docx-layout-head-${tabId}`
  const fitLabel = zoom?.mode === 'fit-width' ? 'Fit page' : 'Fit width'
  const pointedText = highlight?.text ? (pointed?.found === false ? `Claude pointed to text that isn't in ${name}: "${clip40(highlight.text)}"` : pointed ? `Claude pointed to "${clip40(highlight.text)}"` : null) : null

  return (
    <div data-ui="docx-surface" className="flex h-full min-h-0 flex-col bg-bg pt-(--top-h)">
      {findOpen && (
        <div className="flex h-9 shrink-0 items-center border-b border-border bg-bg px-1">
          <FindField
            ui="docx-find"
            inputRef={findInput}
            value={query}
            onChange={setQuery}
            onEnter={(shift) => setCurrent((c) => c + (shift ? -1 : 1))}
            onClose={closeFind}
            onPrev={() => setCurrent((c) => c - 1)}
            onNext={() => setCurrent((c) => c + 1)}
            stepDisabled={!total}
            countText={countText}
            statusText={statusText}
            placeholder="Find in document"
            label={`Find in ${name}`}
          />
        </div>
      )}
      <div data-ui="docx-toolbar" className="flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-b border-border px-1">
        <button type="button" data-ui="docx-layout" {...panel.triggerProps} aria-haspopup="dialog" title="About this layout" className={TEXT_BUTTON}>
          {flight.facts.macros ? "Clui's layout · macros not run" : "Clui's layout"}
        </button>
        <span className="min-w-0 flex-1" />
        {view && zoom && (
          <div className="flex shrink-0 flex-wrap items-center gap-0.5">
            <button type="button" data-ui="docx-layout-mode" onClick={switchLayout} className={TEXT_BUTTON}>
              {layout === 'flow' ? 'Show pages' : 'Wrap to pane'}
            </button>
            <ZoomGroup s={zoom.s} atMin={zoom.s <= zoom.min + 1e-6} atMax={zoom.s >= maxOf(layout) - 1e-6} max={maxOf(layout)} onStep={step}>
              {layout === 'pages' ? (
                <button type="button" data-ui="docx-fit" title={`${fitLabel} ⌘0`} onClick={toggleFit} className={TEXT_BUTTON}>
                  {fitLabel}
                </button>
              ) : null}
            </ZoomGroup>
          </div>
        )}
      </div>
      <div {...panel.popoverProps} role="dialog" aria-labelledby={head} data-ui="docx-layout-panel" className="pop-base pop glass-thick flex w-[320px] flex-col gap-3 rounded-lg p-3">
        <p id={head} className="text-ui font-medium text-content">
          {"Clui's layout"}
        </p>
        {sentences.map((t) => (
          <p key={t} className="text-ui text-dim">
            {t}
          </p>
        ))}
        <button
          type="button"
          className={`${TEXT_BTN} -ml-2 self-start`}
          onClick={() => {
            panel.close({ returnFocus: false })
            void openDefault(handleId, path)
          }}
        >
          Open in default app
        </button>
      </div>
      {pointedText && (
        <div data-ui="docx-pointed" className="flex min-h-8 shrink-0 items-center gap-1.5 px-3 text-meta text-dim">
          <IconTarget className="h-3 w-3 shrink-0" />
          <span className="min-w-0 truncate" title={pointedText}>
            {pointedText}
          </span>
        </div>
      )}
      <div className="pdf-frame relative min-h-0 flex-1">
        <div
          ref={viewportEl}
          role="region"
          aria-label={`${name}, Word document in Clui's layout`}
          aria-description={sentences.join(' ')}
          aria-busy={!view || undefined}
          aria-keyshortcuts={KEYS}
          tabIndex={0}
          data-ui="docx-viewport"
          data-beside-header=""
          {...(view ? { 'data-pane-title': '' } : {})}
          onScroll={save}
          onMouseDown={(e) => {
            down.current = { x: e.clientX, y: e.clientY }
          }}
          onMouseUp={onMouseUp}
          onClick={onClick}
          onAuxClick={(e) => e.preventDefault()}
          onKeyDown={onKeyDown}
          className="pdf-viewport absolute inset-0 overflow-auto bg-page-gutter p-4 focus-visible:outline-none"
        >
          <div
            ref={frameEl}
            data-ui="docx-frame"
            data-layout={layout}
            className="relative mx-auto overflow-clip data-[layout=flow]:bg-page-canvas data-[layout=flow]:shadow-[0_0_0_1px_var(--color-page-edge)] [contain:layout_paint_style] [container:docx/inline-size] [isolation:isolate]"
          />
          {!view && slow && <p className="text-meta text-dim">{`Loading ${name}`}</p>}
        </div>
      </div>
      {notice && <SelectionNotice notice={notice} copy={NOTICE} onDismiss={() => setNotice(null)} />}
      {view && selection ? (
        <SelectionBar label={label} attached={inTarget} onAdd={() => void add()} busy={adding || !input} />
      ) : view && (blocked || pointing) ? (
        <SelectionBar label={blocked ?? POINT_HINT} blocked={blocked ?? POINT_HINT} onBlocked={() => say(blocked ?? POINT_HINT)} attached={false} onAdd={() => {}} />
      ) : null}
      <span data-ui="docx-live" className="sr-only" aria-live="polite">
        {said}
      </span>
    </div>
  )
}
