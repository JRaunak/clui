import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { EventBus, PDFFindController, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import { refsOf, useActive, useSession } from '../../store'
import { CROP_MAX_EDGE } from '../../../../shared/annotate'
import { docPages, quoteOf, refKey, type DraftReference, type DraftVisual, type RefInput, type SourceVersion } from '../../../../shared/context'
import { CHUNK_MAX, type Refusal } from '../../../../shared/files'
import { stripControls } from '../../../../shared/surface-tools'
import type { DocPlace, SurfaceSelection } from '../../../../shared/surfaces'
import { Button } from '../Button'
import { FindField } from '../FindField'
import { IconHash, IconTarget } from '../Icon'
import { usePopover } from '../Popover'
import { addFromSurface } from '../ContextChips'
import { ANNOUNCE_MS, SelectionBar } from './SelectionBar'
import { RegionPicker, type Picked, type PickerHandle } from './RegionPicker'
import { TEXT_BUTTON, ZoomGroup } from './ImageSurface'
import { baseOf, DocState, FIND_MAX, openDefault, REASON, SelectionNotice, SKELETON_MS, STATE_BODY, VIEW_SETTLE_MS, setStatus, useFind, type Doc } from './fileDoc'
import { FILE_GOTO_EVENT } from './FileSurface'
import { useSettings } from '../../lib/settings'
import { useSay } from '../../lib/useSay'
import { noteRead } from '../../lib/blockedFiles'
import { linkTitle, openLink, useLinkTarget } from '../../lib/openLink'
import { POINT_OFF } from '../../lib/refCopy'
import { setPointBlocked, setPointing, takePoint, takeSurfaceFocus, usePointing, usePointRequest } from '../../lib/surfaceFocus'
import { loadPdf, pdfAssets } from '../../lib/pdf'
import { clampScale, FIT_MARGIN, minScale, percent, round4, stepDown, stepUp, type Size } from '../../lib/imageView'
import {
  fitPage,
  fitWidth,
  linesOf,
  locate,
  nextPage,
  offsetIn,
  PDF_MAX,
  PDF_STEPS,
  pageAt,
  prevPage,
  quoteBetween,
  zoomSaid,
  type At,
  type Box,
  type DocZoom,
  type PageText
} from '../../lib/pdfView'

const TURN_RELOAD_MS = 300
const MISSING_POLL_MS = 2000
const GESTURE_IDLE_MS = 150
const HEAD_BYTES = 64 * 1024
const BACK_MAX = 50
const CLICK_PX = 4
const POINTING_SAID = 'Pointing. Drag across a page to select a region, or click a point. Shift and an arrow key also selects. Enter adds it.'
const POINT_HINT = 'Drag across a page, or click a point.'
const NO_PAGE = "There's no page here to point at."
const NOTICE = {
  cleared: 'The PDF changed on disk, so the selection was cleared.',
  removed: 'The PDF changed on disk, so the selection was cleared and removed from the message.'
}
const KEYS = 'Meta+Shift+A Meta+F Meta+L Meta+Equal Meta+Minus Meta+0 PageDown PageUp Home End'

type Shown =
  | { t: 'loading' }
  | { t: 'doc'; doc: PDFDocumentProxy; task: PDFDocumentLoadingTask; revision: string; pages: number }
  | { t: 'empty' }
  | { t: 'not-pdf' }
  | { t: 'damaged' }
  | { t: 'locked' }
  | { t: 'xfa' }
  | { t: 'too-large'; bytes: number }
  | { t: 'missing' }
  | { t: 'error'; reason: Refusal['reason']; message: string }

/** What this surface reads of pdf.js's page views; the viewer types them loosely. */
interface PageView {
  id: number
  div: HTMLDivElement
  width: number
  height: number
  scale: number
  pdfPage: PDFPageProxy | null
}
interface Viewer {
  view: PDFViewer
  bus: EventBus
  links: PDFLinkService
  find: PDFFindController
  /** Internal links' destinations by the href the link layer gave them. */
  dests: Map<string, unknown>
}
type Sel = { page: number; endPage?: number; text?: string; nth?: number; region?: SurfaceSelection['region']; point?: SurfaceSelection['point'] }
/** A text layer as PageText, with the nodes its text came from. */
interface Layer extends PageText { el: HTMLElement; nodes: Text[]; starts: number[] }

const pageCount = (n: number): string => `${n.toLocaleString('en-US')} ${n === 1 ? 'page' : 'pages'}`
const isPdf = (head: Uint8Array): boolean => new TextDecoder('latin1').decode(head.subarray(0, 1024)).includes('%PDF-')

function layerOf(page: number, div: HTMLElement): Layer | null {
  const el = div.querySelector<HTMLElement>('.textLayer')
  if (!el) return null
  const nodes: Text[] = []
  const starts: number[] = []
  let text = ''
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: (n) => ((n as Element).classList?.contains('endOfContent') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT)
  })
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      nodes.push(n as Text)
      starts.push(text.length)
      text += (n as Text).data
    } else if ((n as Element).tagName === 'BR') text += '\n'
  }
  return { page, el, text, nodes, starts }
}

/** Where a DOM point falls in `layers`: inside one, or at the start of the first that follows it. */
function atOf(layers: readonly Layer[], node: Node, offset: number): At {
  const r = document.createRange()
  r.setStart(node, offset)
  for (const [i, l] of layers.entries()) {
    if (r.comparePoint(l.el, 0) > 0) return { i, off: 0 }
    if (!l.el.contains(node) && node !== l.el) continue
    if (node.nodeType === Node.TEXT_NODE) {
      const k = l.nodes.indexOf(node as Text)
      if (k >= 0) return { i, off: l.starts[k] + offset }
    }
    const k = l.nodes.findIndex((t) => r.comparePoint(t, 0) >= 0)
    return { i, off: k < 0 ? l.text.length : l.starts[k] }
  }
  return { i: layers.length - 1, off: layers.at(-1)?.text.length ?? 0 }
}

/** The DOM point at a raw offset of a layer's text. */
function pointOf(l: Layer, off: number): [Node, number] {
  for (let k = l.nodes.length - 1; k >= 0; k--) if (l.starts[k] <= off) return [l.nodes[k], Math.min(off - l.starts[k], l.nodes[k].length)]
  return [l.el, 0]
}

/**
 * A PDF in the pane: continuous pages drawn by pdf.js's viewer from byte ranges main reads at one revision, under the
 * image viewer's toolbar row. Text selects as in any reader; pointing selects a region or a point of a page. Pages
 * stay as authored, white in both themes, and Clui marks them only with the selection and the two-tone edge.
 */
export function PdfSurface({ handleId, tabId }: { handleId: string; tabId: string }): JSX.Element {
  const tab = useActive((s) => s?.surfaces.tabs[tabId])
  const path = tab?.key ?? ''
  const name = baseOf(path)
  const owner = `${handleId}\0${path}`
  const busy = useActive((s) => !!s?.busy)
  const setView = useSession((s) => s.setSurfaceView)
  const picture = useSettings((s) => s?.values.annotateScreenshots ?? true)
  const hasBrowser = useActive((s) => !!s?.browser)
  const [said, say] = useSay()

  const [shown, setShown] = useState<Shown>({ t: 'loading' })
  const shownRef = useRef(shown)
  shownRef.current = shown
  const doc = shown.t === 'doc' ? shown : null
  const [version, setVersion] = useState<{ revision: string; version: SourceVersion } | null>(null)
  const [slow, setSlow] = useState(false)
  const [notice, setNotice] = useState<'cleared' | 'removed' | null>(null)
  const [watchGen, setWatchGen] = useState(0)
  const [adding, setAdding] = useState(false)
  const [current, setCurrent] = useState(1)
  const [zoomed, setZoomed] = useState<{ s: number; mode: DocZoom; min: number } | null>(null)
  const [bar, setBar] = useState<'find' | 'goto' | null>(null)
  const [inited, setInited] = useState(0)

  const frameEl = useRef<HTMLDivElement>(null)
  const viewportEl = useRef<HTMLDivElement>(null)
  const columnEl = useRef<HTMLDivElement>(null)
  const pageEl = useRef<HTMLElement | null>(null)
  const picker = useRef<PickerHandle>(null)
  const stateEl = useRef<HTMLDivElement>(null)
  const pv = useRef<Viewer | null>(null)
  const [ready, setReady] = useState(false)
  const loadGen = useRef(0)
  const captureGen = useRef(0)
  const mode = useRef<DocZoom>(tab?.viewState?.kind === 'doc' ? tab.viewState.zoom : 'fit-width')
  const place = useRef<DocPlace | null>(tab?.viewState?.kind === 'doc' ? { page: tab.viewState.page, offset: tab.viewState.offset } : null)

  const raw = tab?.selection
  const selJson = JSON.stringify(
    raw?.page
      ? { page: raw.page, ...(raw.endPage ? { endPage: raw.endPage } : {}), ...(raw.text ? { text: raw.text, nth: raw.nth ?? 0 } : raw.region ? { region: raw.region } : { point: raw.point }) }
      : null
  )
  const selection = useMemo<Sel | null>(() => JSON.parse(selJson), [selJson])
  const highlight = tab?.highlight?.page ?? null
  const location = tab?.location

  const viewOf = (i: number): PageView | null => (pv.current?.view.getPageView(i) as PageView | undefined) ?? null
  const boxes = (): Box[] => {
    const v = pv.current?.view
    const out: Box[] = []
    for (let i = 0; i < (v?.pagesCount ?? 0); i++) {
      const d = viewOf(i)?.div
      if (d) out.push({ top: d.offsetTop, h: d.offsetHeight })
    }
    return out
  }
  const centreY = (): number => {
    const c = viewportEl.current
    return c ? c.scrollTop + c.clientHeight / 2 : 0
  }
  const placeNow = (): DocPlace | null => {
    const b = boxes()
    if (!b.length) return null
    const i = pageAt(b, centreY())
    return { page: i + 1, offset: round4(offsetIn(b[i], centreY())) }
  }

  // Each page's 100% size from pdf.js, before which a page has page 1's.
  const sizeAt1 = (i: number): Size | null => {
    const v = viewOf(i)
    return v ? { w: v.width / v.scale, h: v.height / v.scale } : null
  }
  const visiblePages = (): number[] => {
    const c = viewportEl.current
    if (!c) return []
    const out: number[] = []
    boxes().forEach((b, i) => b.top < c.scrollTop + c.clientHeight && b.top + b.h > c.scrollTop && out.push(i))
    return out
  }
  const vpSize = (): Size => ({ w: viewportEl.current?.clientWidth ?? 0, h: viewportEl.current?.clientHeight ?? 0 })
  const scaleFor = (m: DocZoom): number => {
    if (typeof m === 'number') return m
    const cur = Math.max(0, current - 1)
    if (m === 'fit-page') return fitPage(sizeAt1(cur) ?? { w: 816, h: 1056 }, vpSize())
    const vis = visiblePages()
    return fitWidth((vis.length ? vis : [cur]).map((i) => sizeAt1(i)?.w ?? 816), vpSize().w)
  }
  const minOf = (): number => minScale(fitPage(sizeAt1(Math.max(0, current - 1)) ?? { w: 816, h: 1056 }, vpSize()), PDF_STEPS)

  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  const save = (): void => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      const p = placeNow()
      const pages = shownRef.current.t === 'doc' ? shownRef.current.pages : undefined
      if (!p) return
      place.current = p
      const find = findRef.current
      setView(handleId, tabId, { viewState: { kind: 'doc', page: p.page, zoom: mode.current, offset: p.offset, ...(pages ? { pages } : {}), ...(find ? { find } : {}) } })
    }, VIEW_SETTLE_MS)
  }

  /** Puts page `p.page`'s point at `p.offset` down it back at the viewport's centre. */
  const goPlace = (p: DocPlace): void => {
    const c = viewportEl.current
    const b = boxes()
    if (!c || !b.length) return
    const i = Math.min(b.length, Math.max(1, p.page)) - 1
    c.scrollTop = b[i].top + p.offset * b[i].h - c.clientHeight / 2
  }
  /** A page's top to the viewport's, with Claude's row above it when it has one. */
  const toTop = (page: number): void => {
    const c = viewportEl.current
    const d = viewOf(page - 1)?.div
    const row = d?.previousElementSibling as HTMLElement | null | undefined
    if (c && d) c.scrollTop = row?.dataset.ui === 'pdf-pointed' ? row.offsetTop : d.offsetTop
  }

  const zoomSay = useRef<ReturnType<typeof setTimeout>>()
  /** Zooms to `m` with the document point under `at` (viewport coordinates, the centre by default) held still, or a
   *  page's top kept where it is or brought to the top. */
  const zoomTo = (m: DocZoom, at?: { x: number; y: number } | 'page-top' | 'keep-top', announce = true): void => {
    const v = pv.current?.view
    const c = viewportEl.current
    if (!v || !c || !v.pagesCount) return
    const cur = Math.max(0, current - 1)
    const s = typeof m === 'number' ? clampScale(m, fitPage(sizeAt1(cur) ?? { w: 816, h: 1056 }, vpSize()), PDF_STEPS) : scaleFor(m)
    const p = typeof at === 'object' ? at : { x: c.clientWidth / 2, y: c.clientHeight / 2 }
    const b = boxes()
    const i = at === 'page-top' || at === 'keep-top' ? cur : pageAt(b, c.scrollTop + p.y)
    const d = viewOf(i)?.div
    const box = d?.getBoundingClientRect()
    const vr = c.getBoundingClientRect()
    const fx = box ? (vr.left + p.x - box.left) / box.width : 0
    const fy = box ? (vr.top + p.y - box.top) / box.height : 0
    const keptTop = box ? box.top - vr.top : 0
    mode.current = m
    v.currentScale = s
    const after = d?.getBoundingClientRect()
    if (d && box && after) {
      if (at === 'page-top') {
        c.scrollTop = d.offsetTop - FIT_MARGIN
        // The column is as wide as the widest page, so a narrower page can sit off-centre.
        c.scrollLeft += after.left + after.width / 2 - (vr.left + c.clientWidth / 2)
      }
      else if (at === 'keep-top') c.scrollTop += after.top - vr.top - keptTop
      else {
        c.scrollLeft += after.left + fx * after.width - (vr.left + p.x)
        c.scrollTop += after.top + fy * after.height - (vr.top + p.y)
      }
    }
    const min = minOf()
    setZoomed((z) => (z && z.s === s && z.mode === m && z.min === min ? z : { s, mode: m, min }))
    if (announce) {
      clearTimeout(zoomSay.current)
      zoomSay.current = setTimeout(() => say(zoomSaid(s, m, min, percent)), ANNOUNCE_MS)
    }
    picker.current?.redraw()
    save()
  }
  const step = (dir: 1 | -1): void => {
    const z = zoomed
    if (!z) return
    if ((dir > 0 && z.s >= PDF_MAX - 1e-6) || (dir < 0 && z.s <= z.min + 1e-6)) return say(zoomSaid(z.s, z.mode, z.min, percent))
    zoomTo(dir > 0 ? stepUp(z.s, PDF_STEPS) : stepDown(z.s, z.min, PDF_STEPS))
  }
  const toggleFit = (): void => (mode.current === 'fit-width' ? zoomTo('fit-page', 'page-top') : zoomTo('fit-width', 'keep-top'))

  // Fit width and Fit page stay fits across a pane resize or Expand.
  useLayoutEffect(() => {
    const c = viewportEl.current
    if (!c || !doc) return
    let w = c.clientWidth
    let h = c.clientHeight
    const ro = new ResizeObserver(() => {
      if (c.clientWidth === w && c.clientHeight === h) return
      w = c.clientWidth
      h = c.clientHeight
      if (typeof mode.current !== 'number') zoomRef.current(mode.current, 'keep-top', false)
    })
    ro.observe(c)
    return () => ro.disconnect()
  }, [doc])
  const zoomRef = useRef(zoomTo)
  zoomRef.current = zoomTo

  // pdf.js's viewer, built once the library has loaded, and re-pointed at each document.
  const pageSay = useRef<ReturnType<typeof setTimeout>>()
  const sayPage = (n: number, total: number): void => {
    clearTimeout(pageSay.current)
    pageSay.current = setTimeout(() => say(`Page ${n.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`), ANNOUNCE_MS)
  }
  const focusPage = (page: number): void => viewOf(page - 1)?.div.focus({ preventScroll: true })
  const pushBack = (from: DocPlace | null): void => {
    const s = shownRef.current
    if (!from || s.t !== 'doc') return
    const b = useSession.getState().sessions[handleId]?.surfaces.tabs[tabId]?.back
    const pages = b?.pages && b.revision === s.revision ? b.pages : []
    setView(handleId, tabId, { back: { revision: s.revision, pages: [...pages, from].slice(-BACK_MAX) } })
  }
  const pageOfDest = async (d: PDFDocumentProxy, dest: unknown): Promise<{ page: number; explicit: unknown[] } | null> => {
    const explicit = typeof dest === 'string' ? await d.getDestination(dest).catch(() => null) : dest
    if (!Array.isArray(explicit)) return null
    const ref = explicit[0]
    const index = Number.isInteger(ref) ? (ref as number) : ref && typeof ref === 'object' ? await d.getPageIndex(ref).catch(() => -1) : -1
    return index >= 0 && index < d.numPages ? { page: index + 1, explicit } : null
  }
  /** A link or Contents jump: instant, with a place to come back to. */
  const jump = async (dest: unknown): Promise<void> => {
    const s = shownRef.current
    const v = pv.current?.view
    if (s.t !== 'doc' || !v) return
    const to = await pageOfDest(s.doc, dest)
    if (shownRef.current !== s) return
    if (!to) return say("This link's destination isn't in the PDF.")
    const from = placeNow()
    const before = viewportEl.current?.scrollTop
    v.scrollPageIntoView({ pageNumber: to.page, destArray: to.explicit, ignoreDestinationZoom: true })
    if (viewportEl.current?.scrollTop !== before) pushBack(from)
    focusPage(to.page)
    sayPage(to.page, s.pages)
  }
  const jumpRef = useRef(jump)
  jumpRef.current = jump
  const goBack = (): void => {
    const s = shownRef.current
    const b = useSession.getState().sessions[handleId]?.surfaces.tabs[tabId]?.back
    const pages = b?.pages
    const p = pages?.at(-1)
    if (!p || !pages || s.t !== 'doc' || b?.revision !== s.revision) return
    setView(handleId, tabId, { back: pages.length > 1 ? { revision: s.revision, pages: pages.slice(0, -1) } : undefined })
    goPlace(p)
    focusPage(p.page)
    sayPage(p.page, s.pages)
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

  const linkTarget = useLinkTarget((s) => s.target)
  const linkSettings = useRef({ hasBrowser, linkTarget })
  linkSettings.current = { hasBrowser, linkTarget }
  const onLayer = useRef<(page: number) => void>(() => {})
  const onDrawn = useRef<(page: number, error: unknown) => void>(() => {})
  const onRender = useRef<() => void>(() => {})
  const onPages = useRef<() => void>(() => {})
  const onFind = useRef<(total: number, cur: number) => void>(() => {})
  const onText = useRef<(page: number) => void>(() => {})
  useEffect(() => {
    const c = viewportEl.current
    const col = columnEl.current
    if (!c || !col) return
    const ac = new AbortController()
    let live = true
    void loadPdf().then(({ lib, viewer }) => {
      if (!live) return
      const bus = new viewer.EventBus()
      const dests = new Map<string, unknown>()
      let seq = 0
      class Links extends viewer.PDFLinkService {
        override getAnchorUrl(anchor: string): string {
          return anchor || '#'
        }
        override getDestinationHash(dest: string | unknown[]): string {
          const h = `#clui-dest-${++seq}`
          dests.set(h, dest)
          return h
        }
        override addLinkAttributes(link: HTMLAnchorElement, url: string): void {
          const scheme = URL.parse(url)?.protocol
          if (scheme === 'http:' || scheme === 'https:' || scheme === 'mailto:') {
            link.href = url
            link.dataset.external = ''
            link.title = linkTitle(url, linkSettings.current.hasBrowser, linkSettings.current.linkTarget)
            return
          }
          link.setAttribute('role', 'link')
          link.setAttribute('aria-disabled', 'true')
          link.tabIndex = 0
          link.title = scheme ? `Clui doesn't follow ${scheme.slice(0, -1)} links from a PDF.` : "Clui doesn't follow this kind of link from a PDF."
        }
        override async goToDestination(dest: string | unknown[]): Promise<void> {
          await jumpRef.current(dest)
        }
      }
      class Find extends viewer.PDFFindController {
        // The active match goes to the viewport's centre, where the count names it.
        override scrollMatchIntoView({ element, pageIndex, matchIndex }: { element: HTMLElement; pageIndex: number; matchIndex: number }): void {
          const sel = this._selected
          if (!this._scrollMatches || !element || !sel || matchIndex !== sel.matchIdx || pageIndex !== sel.pageIdx) return
          this._scrollMatches = false
          element.scrollIntoView({ block: 'center', inline: 'nearest' })
        }
      }
      const links = new Links({ eventBus: bus, ignoreDestinationZoom: true })
      const find = new Find({ linkService: links, eventBus: bus })
      // The viewer's typings leave out abortSignal, which removes its resize and scroll listeners.
      const options: ConstructorParameters<typeof viewer.PDFViewer>[0] & { abortSignal: AbortSignal } = {
        container: c,
        viewer: col,
        eventBus: bus,
        linkService: links,
        findController: find,
        annotationMode: lib.AnnotationMode.ENABLE,
        removePageBorders: true,
        abortSignal: ac.signal
      }
      const view = new viewer.PDFViewer(options)
      links.setViewer(view)
      bus.on('pagesinit', () => onPages.current())
      // pdf.js puts a redraw's canvas on the page before the draw finishes, so it's hidden when made, not when drawn.
      bus.on('pagerender', (e: { source: { canvas?: HTMLCanvasElement } }) => {
        e.source.canvas?.setAttribute('aria-hidden', 'true')
        onRender.current()
      })
      bus.on('pagerendered', (e: { pageNumber: number; error?: unknown }) => onDrawn.current(e.pageNumber, e.error))
      bus.on('textlayerrendered', (e: { pageNumber: number }) => onText.current(e.pageNumber))
      bus.on('annotationlayerrendered', (e: { pageNumber: number }) => onLayer.current(e.pageNumber))
      bus.on('updatefindmatchescount', (e: { matchesCount: { current: number; total: number } }) => onFind.current(e.matchesCount.total, e.matchesCount.current))
      // pdf.js reports a pending find with the previous query's count.
      bus.on('updatefindcontrolstate', (e: { state: number; matchesCount: { current: number; total: number } }) => {
        if (e.state !== viewer.FindState.PENDING) onFind.current(e.matchesCount.total, e.matchesCount.current)
      })
      pv.current = { view, bus, links, find, dests }
      setReady(true)
    })
    return () => {
      live = false
      ac.abort()
      pv.current?.view.setDocument(null)
      pv.current = null
    }
  }, [])

  // A document goes into the viewer once both exist. The old one's pages are held as a picture until the new current
  // page has drawn, so a reload never shows a blank frame.
  const cover = useRef<HTMLCanvasElement | null>(null)
  const coverFor = useRef<string | null>(null)
  const shownTask = useRef<PDFDocumentLoadingTask | null>(null)
  useLayoutEffect(() => {
    const v = pv.current
    const old = shownTask.current
    if (!ready || !v || old === (doc?.task ?? null)) return
    const c = viewportEl.current
    const frame = frameEl.current
    if (old && doc) place.current = placeNow() ?? place.current
    if (old && doc && c && frame) {
      const dpr = window.devicePixelRatio
      const canvas = document.createElement('canvas')
      canvas.width = c.clientWidth * dpr
      canvas.height = c.clientHeight * dpr
      canvas.className = 'pointer-events-none absolute left-0 top-0'
      canvas.style.width = `${c.clientWidth}px`
      canvas.style.height = `${c.clientHeight}px`
      canvas.setAttribute('aria-hidden', 'true')
      const g = canvas.getContext('2d')
      const vr = c.getBoundingClientRect()
      if (g) {
        g.fillStyle = getComputedStyle(c).backgroundColor
        g.fillRect(0, 0, canvas.width, canvas.height)
        for (const el of c.querySelectorAll<HTMLCanvasElement>('.canvasWrapper canvas')) {
          const r = el.getBoundingClientRect()
          if (r.bottom < vr.top || r.top > vr.bottom || !el.width) continue
          g.drawImage(el, (r.left - vr.left) * dpr, (r.top - vr.top) * dpr, r.width * dpr, r.height * dpr)
        }
      }
      cover.current?.remove()
      cover.current = canvas
      coverFor.current = doc.revision
      frame.append(canvas)
      // A page that never draws mustn't leave the old picture up.
      setTimeout(() => cover.current === canvas && uncover(), 1000)
    }
    shownTask.current = doc?.task ?? null
    v.links.setDocument(doc?.doc ?? null)
    v.view.setDocument(doc?.doc ?? null)
    if (old) void old.destroy()
  }, [ready, doc])
  const uncover = (): void => {
    cover.current?.remove()
    cover.current = null
    coverFor.current = null
  }

  // Pages pdf.js hasn't fetched stand in at page 1's size. A place set in code, and a fit, are applied again as each page
  // draws at its real size, until the place's own page has drawn or the user moves.
  const hold = useRef<{ page: number; go: () => void } | null>(null)
  onRender.current = () => {
    if (!hold.current) return
    if (typeof mode.current !== 'number') zoomTo(mode.current, undefined, false)
    hold.current.go()
  }

  onPages.current = () => {
    const s = shownRef.current
    if (s.t !== 'doc') return
    for (let i = 0; i < s.pages; i++) {
      const d = viewOf(i)?.div
      if (!d) continue
      d.setAttribute('role', 'group')
      d.setAttribute('aria-label', `Page ${i + 1}`)
      d.removeAttribute('data-l10n-id')
      d.removeAttribute('data-l10n-args')
      d.tabIndex = -1
    }
    setInited((n) => n + 1)
    zoomTo(mode.current, undefined, false)
    const p = place.current
    const want = location?.page
    if (want) applied.current = location ?? null
    const at = Math.min(s.pages, want ?? p?.page ?? 1)
    hold.current = want ? { page: at, go: () => toTop(at) } : p ? { page: at, go: () => goPlace({ page: at, offset: p.offset }) } : null
    if (hold.current) hold.current.go()
    else if (viewportEl.current) viewportEl.current.scrollTop = 0
    syncCurrent()
    if (findOpen.current && findRef.current) runFind(findRef.current, '')
  }

  onDrawn.current = (page, error) => {
    if (hold.current?.page === page) hold.current = null
    const s = shownRef.current
    const d = viewOf(page - 1)?.div
    if (s.t !== 'doc' || !d) return
    d.querySelector('[data-ui="pdf-page-error"]')?.remove()
    if (error) {
      const p = document.createElement('p')
      p.dataset.ui = 'pdf-page-error'
      p.className = 'absolute inset-0 flex items-center justify-center text-meta text-page-ink'
      p.textContent = `Clui couldn't draw page ${page}.`
      d.append(p)
    }
    if (coverFor.current === s.revision && page === current) uncover()
    if (version?.revision !== s.revision && !hashing.current) {
      hashing.current = true
      void window.clui
        .docVersion(handleId, path, s.revision)
        .catch((): Refusal => ({ ok: false, reason: 'unreadable' }))
        .then((r) => {
          hashing.current = false
          if (shownRef.current !== s) return
          if (r.ok) setVersion({ revision: s.revision, version: r.version })
          else scheduleLoad()
        })
    }
  }
  const hashing = useRef(false)

  onLayer.current = (page) => {
    const s = shownRef.current
    const v = pv.current
    const d = viewOf(page - 1)
    const layer = d?.div.querySelector('.annotationLayer')
    if (s.t !== 'doc' || !v || !d?.pdfPage || !layer) return
    for (const el of layer.querySelectorAll('[tabindex]')) if (!(el instanceof HTMLAnchorElement && el.getAttribute('aria-disabled'))) el.removeAttribute('tabindex')
    for (const a of layer.querySelectorAll<HTMLAnchorElement>('[data-internal-link] > a')) {
      const dest = v.dests.get(a.getAttribute('href') ?? '')
      if (dest === undefined) continue
      void pageOfDest(s.doc, dest).then((to) => {
        if (to) a.title = `Go to page ${to.page}`
      })
    }
    const bare = [...layer.querySelectorAll<HTMLElement>('section.linkAnnotation')].filter((sec) => !sec.querySelector('a'))
    if (!bare.length) return
    void d.pdfPage.getAnnotations().then((all: { id: string; unsafeUrl?: string }[]) => {
      for (const sec of bare) {
        const data = all.find((x) => x.id === sec.dataset.annotationId)
        const a = document.createElement('a')
        v.links.addLinkAttributes(a, data?.unsafeUrl ?? 'about:')
        if (!data?.unsafeUrl) a.title = "Clui doesn't follow this kind of link from a PDF."
        sec.append(a)
      }
    })
  }

  // Which page covers the viewport's centre, for the page button, Contents and the saved place.
  const syncCurrent = (): void => {
    const b = boxes()
    if (b.length) setCurrent(pageAt(b, centreY()) + 1)
  }
  const onScroll = (): void => {
    syncCurrent()
    picker.current?.redraw()
    save()
  }

  const settle = (next: Shown): void => {
    setStatus(owner, next.t === 'doc' ? 'binary' : next.t === 'missing' ? 'missing' : next.t === 'loading' ? 'loading' : 'error')
    setShown(next)
  }
  const selRef = useRef({ selection, attached: false })
  const clearSel = (): void => {
    if (!selRef.current.selection) return
    const inMessage = selRef.current.attached
    captureGen.current++
    setView(handleId, tabId, { selection: undefined })
    setNotice(inMessage ? 'removed' : 'cleared')
    say(NOTICE[inMessage ? 'removed' : 'cleared'])
  }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastLoad = useRef(0)
  const load = useCallback(async (): Promise<void> => {
    const gen = ++loadGen.current
    lastLoad.current = Date.now()
    const h = await window.clui.docOpen(handleId, path, HEAD_BYTES).catch((): Refusal => ({ ok: false, reason: 'unreadable' }))
    if (gen !== loadGen.current) return
    noteRead(handleId, path, h.ok ? null : h.reason)
    const prev = shownRef.current
    if (h.ok && prev.t === 'doc' && prev.revision === h.revision) return
    const fail = (next: Shown): void => {
      uncover()
      clearSel()
      settle(next)
    }
    if (!h.ok) return fail(h.reason === 'missing' ? { t: 'missing' } : { t: 'error', reason: h.reason, message: REASON[h.reason] })
    if (!h.size) return fail({ t: 'empty' })
    if (!h.head) return fail({ t: 'too-large', bytes: h.size })
    if (!isPdf(h.head)) return fail({ t: 'not-pdf' })
    const { lib } = await loadPdf()
    if (gen !== loadGen.current) return
    const { revision } = h
    let task: PDFDocumentLoadingTask | null = null
    // pdf.js asks for chunk-aligned ranges; a long one is read in CHUNK_MAX pieces, each delivered as it lands.
    class Ranges extends lib.PDFDataRangeTransport {
      override requestDataRange(begin: number, end: number): void {
        for (let at = begin; at < end; at += CHUNK_MAX) {
          const off = at
          void window.clui
            .docRead(handleId, path, revision, off, Math.min(CHUNK_MAX, end - off))
            .catch((): Refusal => ({ ok: false, reason: 'unreadable' }))
            .then((r) => {
              if (!task || task.destroyed) return
              if (r.ok) this.onDataRange(off, r.bytes)
              else scheduleLoad()
            })
        }
      }
    }
    task = lib.getDocument({
      range: new Ranges(h.size, h.head),
      rangeChunkSize: 64 * 1024,
      disableAutoFetch: true,
      disableStream: true,
      enableXfa: false,
      wasmUrl: pdfAssets('wasm'),
      standardFontDataUrl: pdfAssets('standard_fonts'),
      cMapUrl: pdfAssets('cmaps'),
      cMapPacked: true
    })
    const opened = await task.promise.then(
      (d) => d,
      (e: unknown) => e as { name?: string }
    )
    if (gen !== loadGen.current) return void task.destroy()
    if (!('numPages' in opened)) {
      void task.destroy()
      return fail(opened?.name === 'PasswordException' ? { t: 'locked' } : { t: 'damaged' })
    }
    if (prev.t === 'doc') {
      clearSel()
      setView(handleId, tabId, { back: undefined })
    }
    setVersion(null)
    settle({ t: 'doc', doc: opened, task, revision, pages: opened.numPages })
    // pdf.js draws an XFA form's placeholder page with XFA off; a form that is only XFA is the state instead.
    void opened.getMetadata().then(({ info }) => {
      const i = info as { IsXFAPresent?: boolean; IsAcroFormPresent?: boolean }
      if (gen === loadGen.current && i.IsXFAPresent && !i.IsAcroFormPresent) fail({ t: 'xfa' })
    }, () => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleId, path, tabId])

  const scheduleLoad = useCallback(() => {
    if (timer.current) return
    const wait = busyRef.current ? Math.max(0, TURN_RELOAD_MS - (Date.now() - lastLoad.current)) : 0
    timer.current = setTimeout(() => {
      timer.current = null
      void load()
    }, wait)
  }, [load])
  const busyRef = useRef(busy)
  busyRef.current = busy

  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SKELETON_MS)
    void load().finally(() => clearTimeout(t))
    return () => {
      clearTimeout(t)
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
    }
  }, [load])
  useEffect(
    () => () => {
      loadGen.current++
      captureGen.current++
      clearTimeout(saveTimer.current)
      clearTimeout(zoomSay.current)
      clearTimeout(pageSay.current)
      clearTimeout(idle.current)
      void shownTask.current?.destroy()
      cover.current?.remove()
      CSS.highlights.delete('pdf-selected')
      setStatus(owner, null)
    },
    [owner]
  )

  useEffect(() => {
    let id: string | null = null
    let live = true
    const off = window.clui.onFileChanged((e) => {
      if (e.handleId === handleId && e.id === id) scheduleLoad()
    })
    void window.clui.watchFile(handleId, path).then((w) => {
      if (!w.ok) return
      if (live) id = w.id
      else void window.clui.unwatchFile(handleId, w.id)
    })
    window.addEventListener('focus', scheduleLoad)
    return () => {
      live = false
      off()
      window.removeEventListener('focus', scheduleLoad)
      if (id) void window.clui.unwatchFile(handleId, id)
    }
  }, [handleId, path, watchGen, scheduleLoad])
  useEffect(() => {
    if (shown.t !== 'missing') return
    const t = setInterval(() => {
      void window.clui.statFile(handleId, path).then((s) => {
        if (!s.ok) return
        void load()
        setWatchGen((n) => n + 1)
      })
    }, MISSING_POLL_MS)
    return () => clearInterval(t)
  }, [shown.t, handleId, path, load])
  const reopen = (): void => {
    void load()
    setWatchGen((n) => n + 1)
  }

  // Claude's page arrives as the tab's location.
  const applied = useRef<typeof location | null>(null)
  useEffect(() => {
    if (!doc || !location?.page || applied.current === location) return
    applied.current = location
    const page = Math.min(doc.pages, location.page)
    hold.current = { page, go: () => toTop(page) }
    hold.current.go()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, location])

  // The pointed row sits in the gutter above Claude's page, and the page takes the outline.
  const [rowHost, setRowHost] = useState<HTMLElement | null>(null)
  const pointedPage = doc && highlight ? Math.min(highlight, doc.pages) : null
  const rowShown = useRef<typeof location | null>(null)
  useLayoutEffect(() => {
    const page = ready ? (pointedPage ?? 0) : 0
    const d = page ? viewOf(page - 1)?.div : null
    if (!d) return setRowHost(null)
    // The row takes its height before React renders into it, so the scroll below lands on it and scroll anchoring has
    // nothing to shift.
    const row = document.createElement('div')
    row.dataset.ui = 'pdf-pointed'
    row.className = 'mx-auto -mt-1 flex h-6 select-none items-center gap-1.5 text-meta text-dim'
    d.before(row)
    d.dataset.pointed = ''
    setRowHost(row)
    // The open that placed the page did so before the row was there.
    if (location?.page && applied.current === location && rowShown.current !== location) {
      rowShown.current = location
      toTop(page)
    }
    return () => {
      row.remove()
      delete d.dataset.pointed
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointedPage, ready, inited])

  // Text: the layers drawn now, the selection's place in them, and the kept form of it once focus leaves.
  const drawnLayers = (from: number, to: number): Layer[] => {
    const out: Layer[] = []
    for (let p = from; p <= to; p++) {
      const d = viewOf(p - 1)?.div
      const l = d && layerOf(p, d)
      if (l) out.push(l)
    }
    return out
  }
  const textRange = (sel: Sel): Range | null => {
    if (!sel.text) return null
    const layers = drawnLayers(sel.page, sel.endPage ?? sel.page)
    if (!layers.length || layers[0].page !== sel.page) return null
    const at = locate(layers, sel.text, sel.nth ?? 0, 0)
    if (!at) return null
    const r = document.createRange()
    r.setStart(...pointOf(layers[at.a.i], at.a.off))
    r.setEnd(...pointOf(layers[at.b.i], at.b.off))
    return r
  }
  const liveSelection = (): boolean => {
    const s = window.getSelection()
    return !!s && !s.isCollapsed && !!columnEl.current?.contains(s.anchorNode)
  }
  const paintText = (): void => {
    const r = selRef.current.selection?.text && !liveSelection() ? textRange(selRef.current.selection) : null
    if (r) CSS.highlights.set('pdf-selected', new Highlight(r))
    else CSS.highlights.delete('pdf-selected')
  }
  // pdf.js makes each text layer a tab stop; the viewport is the one, and Tab goes on to the links.
  onText.current = (page) => {
    viewOf(page - 1)?.div.querySelector('.textLayer')?.removeAttribute('tabindex')
    paintText()
  }
  useEffect(() => {
    paintText()
    document.addEventListener('selectionchange', paintText)
    return () => document.removeEventListener('selectionchange', paintText)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, doc])

  /** The native selection as a quote: its pages, collapsed text and occurrence. */
  const selectionNow = (): Sel | null => {
    const s = window.getSelection()
    const doc0 = shownRef.current
    if (!s || s.isCollapsed || !s.rangeCount || doc0.t !== 'doc' || !columnEl.current?.contains(s.anchorNode)) return null
    const r = s.getRangeAt(0)
    const pageOf = (n: Node): number => Number((n instanceof Element ? n : n.parentElement)?.closest<HTMLElement>('.page')?.dataset.pageNumber ?? 0)
    const a = pageOf(r.startContainer) || 1
    const b = pageOf(r.endContainer) || doc0.pages
    const layers = drawnLayers(a, b)
    if (!layers.length) return null
    const q = quoteBetween(layers, atOf(layers, r.startContainer, r.startOffset), atOf(layers, r.endContainer, r.endOffset))
    if (!q) return null
    const page = layers[q.i].page
    const end = layers[q.endI].page
    return { page, ...(end > page ? { endPage: end } : {}), text: q.text, nth: q.nth }
  }
  const emitted = useRef<string | null>(null)
  const setSelection = (next: Sel | null): void => {
    const s = shownRef.current
    if (s.t !== 'doc' || JSON.stringify(next) === selJson) return
    emitted.current = JSON.stringify(next)
    captureGen.current++
    setAdding(false)
    setNotice(null)
    setView(handleId, tabId, { selection: next ? { ...next } : undefined, highlight: undefined })
  }
  // A selection set from outside, a chip's, brings its page into view.
  useEffect(() => {
    if (!doc || !selection || selJson === emitted.current) return
    emitted.current = selJson
    const c = viewportEl.current
    const d = viewOf(selection.page - 1)?.div
    if (c && d && (d.offsetTop + d.offsetHeight < c.scrollTop || d.offsetTop > c.scrollTop + c.clientHeight)) toTop(selection.page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, selJson])

  /** Shift and an arrow: the next or previous text line joins the selection, from its anchor, across pages. */
  const kbd = useRef<{ anchor: [number, number]; focus: [number, number] } | null>(null)
  const stepLine = (dir: 1 | -1): void => {
    const s = shownRef.current
    const c = viewportEl.current
    if (s.t !== 'doc' || !c) return
    const vis = visiblePages()
    if (!vis.length) return
    const layers = drawnLayers(Math.max(1, vis[0]), Math.min(s.pages, vis.at(-1)! + 2))
    const lines = layers.flatMap((l) => linesOf(l.text).map(([a, b]) => ({ l, a, b })))
    if (!lines.length) return
    const key = (x: { l: Layer; a: number }): [number, number] => [x.l.page, x.a]
    const idx = (k: [number, number]): number => lines.findIndex((x) => x.l.page === k[0] && x.a === k[1])
    const sel0 = selRef.current.selection
    let cur = kbd.current && sel0?.text && idx(kbd.current.focus) >= 0 ? kbd.current : null
    const r0 = !cur && sel0?.text ? textRange(sel0) : null
    if (r0) {
      const lineAt = (at: At): number => lines.findIndex((x) => x.l === layers[at.i] && x.a <= at.off && at.off <= x.b)
      const ia = lineAt(atOf(layers, r0.startContainer, r0.startOffset))
      const ib = lineAt(atOf(layers, r0.endContainer, r0.endOffset))
      if (ia >= 0 && ib >= 0) cur = { anchor: key(lines[ia]), focus: key(lines[ib]) }
    }
    if (!cur) {
      const top = c.getBoundingClientRect().top
      const first = lines.find((x) => {
        const [n, o] = pointOf(x.l, x.a)
        const r = document.createRange()
        r.setStart(n, o)
        return r.getBoundingClientRect().top >= top
      })
      if (!first) return
      cur = { anchor: key(first), focus: key(first) }
    } else {
      const j = Math.min(lines.length - 1, Math.max(0, idx(cur.focus) + dir))
      cur = { anchor: cur.anchor, focus: key(lines[j]) }
    }
    kbd.current = cur
    const [ia, ib] = [idx(cur.anchor), idx(cur.focus)].sort((x, y) => x - y)
    const from = lines[ia]
    const to = lines[ib]
    const sel = window.getSelection()
    sel?.setBaseAndExtent(...pointOf(from.l, from.a), ...pointOf(to.l, to.b))
    const next = selectionNow()
    if (next) setSelection(next)
    const focusLine = lines[idx(cur.focus)]
    const [n] = pointOf(focusLine.l, focusLine.a)
    ;(n instanceof Element ? n : n.parentElement)?.scrollIntoView({ block: 'nearest' })
  }

  const pointing = usePointing(tabId)
  const asked = usePointRequest(tabId)
  const selSay = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => setPointBlocked(tabId, shown.t === 'loading' || doc ? null : NO_PAGE), [tabId, shown.t, doc])
  useEffect(() => () => setPointBlocked(tabId, null), [tabId])
  useLayoutEffect(() => {
    if (!asked || shown.t === 'loading' || !takePoint(tabId)) return
    if (pointing) {
      setPointing(tabId, false)
      clearTimeout(selSay.current)
      return say(POINT_OFF)
    }
    if (!doc) return say(NO_PAGE)
    setPointing(tabId, true)
    window.getSelection()?.removeAllRanges()
    viewportEl.current?.focus({ preventScroll: true })
    say(POINTING_SAID)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, shown.t, doc])
  useEffect(() => () => setPointing(tabId, false), [tabId])
  useEffect(() => {
    if (!doc && pointing) setPointing(tabId, false)
  }, [doc, pointing, tabId])

  // The picker's content is the page the selection is on, or the page a press lands on.
  const picked = useMemo<Picked>(() => (selection?.region ? { region: selection.region } : selection?.point ? { point: selection.point } : null), [selection])
  const pickPage = selection && !selection.text ? selection.page : current
  pageEl.current = (ready && viewOf(pickPage - 1)?.div) || null
  const basis = sizeAt1(pickPage - 1) ?? { w: 612, h: 792 }
  const pressPage = useRef(pickPage)

  // pdf.js measures a page box at 96 CSS px per inch; a PDF point is 1/72.
  const pageSize = (page: number): Size | null => {
    const s = sizeAt1(page - 1)
    return s ? { w: round4((s.w * 72) / 96), h: round4((s.h * 72) / 96) } : null
  }
  const input = useMemo<RefInput | null>(() => {
    if (!doc || !selection || version?.revision !== doc.revision) return null
    const base = { kind: 'doc' as const, path, sourceVersion: version.version, pages: doc.pages, page: selection.page }
    if (selection.text) {
      const q = quoteOf(selection.text)
      return { ...base, ...(selection.endPage ? { endPage: selection.endPage } : {}), text: { quote: q.quote, nth: selection.nth ?? 0, ...(q.elided ? { elided: true as const } : {}) } }
    }
    const size = pageSize(selection.page)
    if (!size) return null
    return { ...base, pageSize: size, ...(selection.region ? { region: selection.region } : { point: selection.point! }) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, selection, version, path])
  const key = input ? refKey(input) : null
  const isThis = (d: DraftReference): boolean => !!key && refKey(d.ref) === key
  const attached = useActive((s) => !!s && !!key && [s.contextRefs, ...s.queuedMessages.map((q) => q.refs)].some((l) => l.some(isThis)))
  const inTarget = useActive((s) => !!s && !!key && !!refsOf(s, s.referenceEditTarget)?.some(isThis))
  selRef.current = { selection, attached }
  const refsHere = useActive((s) => (s ? [s.contextRefs, ...s.queuedMessages.map((q) => q.refs)].flat().filter(({ ref: r }) => r.kind === 'doc' && r.path === path).length : 0))
  const prevHere = useRef({ selection, refsHere })
  useEffect(() => {
    const prev = prevHere.current
    prevHere.current = { selection, refsHere }
    if (prev.selection && !selection && refsHere < prev.refsHere) setNotice('removed')
  }, [selection, refsHere])

  const label = selection ? `${selection.text ? 'Text' : selection.region ? 'Region' : 'Point'} on ${docPages(selection)} selected` : ''
  const withPicture = !!selection?.region && picture
  const barLabel = label && `${label}${withPicture ? ' · with picture' : ''}`
  const spoken = label && `${label}${withPicture ? ', with picture' : ''}`
  const hadSel = useRef(false)
  useEffect(() => {
    if (!spoken && !hadSel.current) return
    hadSel.current = !!spoken
    const t = (selSay.current = setTimeout(() => say(spoken || 'Selection cleared'), ANNOUNCE_MS))
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spoken])

  /** A region's pixels, drawn fresh from the page so an evicted or soft canvas never decides them. Always JPEG: the
   *  page is drawn on white. */
  const cropOf = async (page: PDFPageProxy, r: NonNullable<Sel['region']>): Promise<DraftVisual | null> => {
    const v1 = page.getViewport({ scale: 1 })
    const long = Math.max(r.w * v1.width, r.h * v1.height)
    const k = Math.min(CROP_MAX_EDGE, 4 * long) / long
    const vp = page.getViewport({ scale: k })
    const w = Math.max(1, Math.round(r.w * vp.width))
    const h = Math.max(1, Math.round(r.h * vp.height))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const g = c.getContext('2d')
    if (!g) return null
    await page.render({ canvas: c, canvasContext: g, viewport: vp, transform: [1, 0, 0, 1, -r.x * vp.width, -r.y * vp.height] }).promise
    const url = c.toDataURL('image/jpeg', 0.85)
    return { id: crypto.randomUUID(), data: url.slice(url.indexOf(',') + 1), mimeType: 'image/jpeg', w, h }
  }
  const add = async (): Promise<void> => {
    const s = shownRef.current
    if (s.t !== 'doc' || !selection || !input) return
    clearTimeout(selSay.current)
    const gen = ++captureGen.current
    setAdding(true)
    const st = await window.clui.statFile(handleId, path).catch(() => null)
    if (gen !== captureGen.current) return
    if (!st?.ok || st.revision !== s.revision) {
      setAdding(false)
      setView(handleId, tabId, { selection: undefined })
      setNotice('cleared')
      say(NOTICE.cleared)
      return scheduleLoad()
    }
    const page = selection.region && picture ? await s.doc.getPage(selection.page).catch(() => null) : null
    const visual = page && selection.region ? await cropOf(page, selection.region).catch(() => null) : null
    if (gen !== captureGen.current) return
    setAdding(false)
    addFromSurface(handleId, input, say, visual ? { visual } : undefined)
  }
  const addRef = useRef(add)
  addRef.current = add

  // Keys and presses on the viewport. Registered in the capture phase, before the picker's own listeners, so paging
  // and text lines are this surface's, and a press tells the picker which page it's on.
  const latest = useRef({ pointing, selection, highlight, stepLine, add })
  latest.current = { pointing, selection, highlight, stepLine, add }
  const gutterDown = useRef<{ x: number; y: number } | null>(null)
  useEffect(() => {
    const c = viewportEl.current
    if (!c) return
    const pageUnder = (x: number, y: number): HTMLElement | null => {
      for (const d of c.querySelectorAll<HTMLElement>('.page')) {
        const r = d.getBoundingClientRect()
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return d
      }
      return null
    }
    const onDown = (e: PointerEvent): void => {
      if (!latest.current.pointing || e.button !== 0) return
      const d = pageUnder(e.clientX, e.clientY)
      pageEl.current = d
      pressPage.current = Number(d?.dataset.pageNumber ?? 0)
      gutterDown.current = d ? null : { x: e.clientX, y: e.clientY }
    }
    const onUp = (e: PointerEvent): void => {
      const g = gutterDown.current
      gutterDown.current = null
      if (!g) return
      pageEl.current = viewOf(currentRef.current - 1)?.div ?? null
      if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < CLICK_PX && latest.current.selection) setSelectionRef.current(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.target !== c) return
      const { pointing, selection, highlight } = latest.current
      const arrow = e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight'
      const stop = (): void => {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
      if (pointing) {
        const d = selection && !selection.text ? viewOf(selection.page - 1)?.div : viewOf(currentRef.current - 1)?.div
        if (d) pageEl.current = d
        pressPage.current = Number(d?.dataset.pageNumber ?? currentRef.current)
      } else {
        if (e.shiftKey && !e.altKey && !e.metaKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          stop()
          return latest.current.stepLine(e.key === 'ArrowDown' ? 1 : -1)
        }
        if (arrow && (e.shiftKey || e.altKey)) return void e.stopImmediatePropagation()
        if (selection?.text && e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey) {
          stop()
          return void latest.current.add()
        }
        if (e.key === 'Escape' && (selection?.text || (!selection && highlight))) {
          stop()
          window.getSelection()?.removeAllRanges()
          if (selection) return setSelectionRef.current(null)
          return setView(handleId, tabId, { highlight: undefined })
        }
      }
      const s = shownRef.current
      if (s.t !== 'doc' || e.altKey || e.shiftKey || e.ctrlKey) return
      const b = boxes()
      const top = c.scrollTop
      const to =
        e.metaKey && e.key === 'ArrowUp'
          ? 0
          : e.metaKey && e.key === 'ArrowDown'
            ? b.length - 1
            : e.metaKey
              ? null
              : e.key === 'PageDown'
                ? nextPage(b, top)
                : e.key === 'PageUp'
                  ? prevPage(b, top)
                  : e.key === 'Home'
                    ? 0
                    : e.key === 'End'
                      ? b.length - 1
                      : null
      if (to === null || !b.length) return
      stop()
      c.scrollTop = b[to].top
      sayPage(to + 1, s.pages)
    }
    const moved = (): void => {
      hold.current = null
    }
    const user = ['wheel', 'pointerdown', 'keydown'] as const
    for (const t of user) c.addEventListener(t, moved, { capture: true, passive: true })
    c.addEventListener('pointerdown', onDown, true)
    c.addEventListener('pointerup', onUp, true)
    c.addEventListener('keydown', onKey, true)
    return () => {
      for (const t of user) c.removeEventListener(t, moved, true)
      c.removeEventListener('pointerdown', onDown, true)
      c.removeEventListener('pointerup', onUp, true)
      c.removeEventListener('keydown', onKey, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const setSelectionRef = useRef(setSelection)
  setSelectionRef.current = setSelection
  const currentRef = useRef(current)
  currentRef.current = current

  // Pinch and ⌘-wheel scale the drawn pages by transform while the gesture runs, then commit the zoom once at rest.
  const idle = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    const c = viewportEl.current
    const col = columnEl.current
    if (!c || !col) return
    let g: { s0: number; k: number; x: number; y: number } | null = null
    const onWheel = (e: WheelEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || shownRef.current.t !== 'doc') return
      e.preventDefault()
      const v = pv.current?.view
      if (!v) return
      const vr = c.getBoundingClientRect()
      if (!g) {
        const cr = col.getBoundingClientRect()
        g = { s0: v.currentScale, k: 1, x: e.clientX - vr.left, y: e.clientY - vr.top }
        col.style.transformOrigin = `${e.clientX - cr.left}px ${e.clientY - cr.top}px`
      }
      const min = minOf()
      g.k = clampScale(g.s0 * g.k * Math.exp(-e.deltaY * 0.01), min, PDF_STEPS) / g.s0
      col.style.transform = `scale(${g.k})`
      clearTimeout(idle.current)
      idle.current = setTimeout(() => {
        const done = g
        g = null
        col.style.transform = ''
        col.style.transformOrigin = ''
        if (done && done.k !== 1) zoomRef.current(done.s0 * done.k, { x: done.x, y: done.y })
      }, GESTURE_IDLE_MS)
    }
    c.addEventListener('wheel', onWheel, { passive: false })
    return () => c.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Dragging across text keeps the native selection for copying; on release it becomes the tab's selection.
  const down = useRef<{ x: number; y: number } | null>(null)
  const onMouseUp = (): void => {
    if (pointing) return
    const next = selectionNow()
    if (next) {
      kbd.current = null
      setSelection(next)
    }
  }
  const onClick = (e: ReactMouseEvent): void => {
    const at = down.current
    down.current = null
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('.annotationLayer a') : null
    if (a) {
      if (a.dataset.external !== undefined) {
        e.preventDefault()
        void openLink(a.href, e.metaKey || e.ctrlKey)
      } else if (a.getAttribute('aria-disabled') || !a.closest('[data-internal-link]')) e.preventDefault()
      return
    }
    if (pointing || !selection || !at || e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    if (Math.hypot(e.clientX - at.x, e.clientY - at.y) > 3 || !window.getSelection()?.isCollapsed) return
    kbd.current = null
    setSelection(null)
  }

  // A user open focuses whatever it settles into: the pages, else the state's first action.
  useEffect(() => {
    if (shown.t === 'loading') return
    const via = takeSurfaceFocus(tabId)
    if (!via) return
    const el = doc ? viewportEl.current : (stateEl.current?.querySelector<HTMLElement>('button') ?? viewportEl.current)
    // TypeScript's DOM lib doesn't declare focusVisible yet; Chromium takes it.
    const opts: FocusOptions & { focusVisible?: boolean } = { preventScroll: true, focusVisible: via === 'keyboard' }
    el?.focus(opts)
  }, [shown.t, doc, tabId])

  // Find: pdf.js's controller over every page's text, its marks restyled to the two-tone edge.
  const returnTo = useRef<HTMLElement | null>(null)
  const openBar = useCallback((which: 'find' | 'goto') => {
    if (!returnTo.current) returnTo.current = document.activeElement as HTMLElement | null
    setBar(which)
  }, [])
  const [found, setFound] = useState<{ total: number; cur: number } | null>(null)
  // Text extraction runs once per document, on its first find.
  const [extracted, setExtracted] = useState<{ doc: PDFDocumentProxy; empty: boolean } | null>(null)
  const findRef = useRef<string>(tab?.viewState?.kind === 'doc' ? (tab.viewState.find ?? '') : '')
  const findOpen = useRef(false)
  const runFind = (q: string, type: '' | 'again', prev = false): void => {
    const v = pv.current
    const s = shownRef.current
    if (!v || s.t !== 'doc') return
    v.bus.dispatch('find', { source: null, type, query: q, caseSensitive: false, entireWord: false, highlightAll: true, findPrevious: prev, matchDiacritics: false })
    if (type || !q) return
    void (v.find._firstPageCapability?.promise as Promise<void> | undefined)?.then(() =>
      Promise.all(v.find._extractTextPromises as Promise<unknown>[]).then(() => {
        if (shownRef.current === s) setExtracted({ doc: s.doc, empty: (v.find._pageContents as string[]).every((t) => !t) })
      })
    )
  }
  const { query, setQuery, deferred, input: findInput } = useFind(
    bar === 'find',
    (on) => (on ? openBar('find') : setBar(null)),
    () => shownRef.current.t === 'doc',
    (by) => runFind(findRef.current, 'again', by < 0)
  )
  findOpen.current = bar === 'find'
  onFind.current = (total, cur) => setFound({ total, cur })
  useEffect(() => {
    findRef.current = bar === 'find' ? deferred : ''
    setFound(null)
    if (bar !== 'find' || !deferred) pv.current?.bus.dispatch('findbarclose', { source: null })
    else runFind(deferred, '')
    if (bar === 'find') save()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bar, deferred, doc])
  useEffect(() => {
    const v = tab?.viewState?.kind === 'doc' ? tab.viewState.find : undefined
    if (v) setQuery(v)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Go to page shares the docked bar with find.
  const gotoInput = useRef<HTMLInputElement>(null)
  const [gotoText, setGotoText] = useState('')
  const [gotoBad, setGotoBad] = useState(false)
  const closeBar = (refocus: 'region' | 'back'): void => {
    setBar(null)
    setGotoBad(false)
    const back = returnTo.current
    returnTo.current = null
    requestAnimationFrame(() => (refocus === 'back' && back?.isConnected ? back : viewportEl.current)?.focus())
  }
  useEffect(() => {
    const onGoto = (): void => {
      if (shownRef.current.t !== 'doc') return
      openBar('goto')
      requestAnimationFrame(() => {
        gotoInput.current?.focus()
        gotoInput.current?.select()
      })
    }
    window.addEventListener(FILE_GOTO_EVENT, onGoto)
    return () => window.removeEventListener(FILE_GOTO_EVENT, onGoto)
  }, [openBar])
  const submitGoto = (): void => {
    const n = /^\s*(\d+)\s*$/.exec(gotoText) ? Number(gotoText) : 0
    if (!doc || n < 1 || n > doc.pages) return setGotoBad(true)
    toTop(n)
    sayPage(n, doc.pages)
    closeBar('region')
  }

  // Contents: the PDF's outline, read after the first paint, its destinations resolved when it first opens.
  type Item = { title: string; depth: number; dest: unknown; url?: string; page?: number }
  const [outline, setOutline] = useState<Item[] | null>(null)
  useEffect(() => {
    setOutline(null)
    if (!doc) return
    let live = true
    type Node0 = { title: string; dest: unknown; url: string | null; items: Node0[] }
    void doc.doc.getOutline().then(
      (o: Node0[] | null) => {
        if (!live || !o?.length) return
        const out: Item[] = []
        const walk = (ns: Node0[], depth: number): void => {
          for (const n of ns) {
            out.push({ title: stripControls(n.title).replace(/\s+/g, ' ').trim(), depth, dest: n.dest, ...(n.url ? { url: n.url } : {}) })
            walk(n.items, depth + 1)
          }
        }
        walk(o, 0)
        setOutline(out)
      },
      () => {}
    )
    return () => {
      live = false
    }
  }, [doc])
  const resolving = useRef(false)
  const contents = usePopover({
    placement: 'down',
    align: 'end',
    onOpenChange: (open) => {
      if (!open) return
      const s = shownRef.current
      if (outline && s.t === 'doc' && !resolving.current && outline.every((it) => it.page === undefined)) {
        resolving.current = true
        void Promise.all(outline.map((it) => (it.dest ? pageOfDest(s.doc, it.dest).then((t) => t?.page) : undefined))).then((pages) => {
          resolving.current = false
          if (shownRef.current === s) setOutline((o) => o?.map((it, i) => ({ ...it, page: pages[i] ?? 0 })) ?? null)
        })
      }
      requestAnimationFrame(() => {
        const pop = contents.popRef.current
        ;(pop?.querySelector<HTMLElement>('[aria-current="location"]') ?? pop?.querySelector<HTMLElement>('button'))?.focus()
        pop?.querySelector('[aria-current="location"]')?.scrollIntoView({ block: 'nearest' })
      })
    }
  })
  const currentItem = outline ? outline.findLastIndex((it) => !!it.page && it.page <= current) : -1
  const onContentsKey = (e: ReactKeyboardEvent): void => {
    const all = [...(contents.popRef.current?.querySelectorAll<HTMLElement>('button') ?? [])]
    const i = all.indexOf(document.activeElement as HTMLElement)
    const to = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : null
    if (to === null || !all.length) return
    e.preventDefault()
    all[Math.min(all.length - 1, Math.max(0, to))].focus()
  }
  const contentsJump = (it: Item, meta: boolean): void => {
    contents.close({ returnFocus: false })
    if (it.url) return void openLink(it.url, meta)
    void jump(it.dest)
  }
  const nested = useMemo(() => {
    type Tree = { it: Item; i: number; kids: Tree[] }
    const root: Tree[] = []
    const stack: Tree[] = []
    outline?.forEach((it, i) => {
      const t: Tree = { it, i, kids: [] }
      while (stack.length > it.depth) stack.pop()
      ;(stack.at(-1)?.kids ?? root).push(t)
      stack.push(t)
    })
    return root
  }, [outline])

  const openApp = (): void => void openDefault(handleId, path)
  const z = zoomed
  const atMin = !!z && z.s <= z.min + 1e-6
  const atMax = !!z && z.s >= PDF_MAX - 1e-6
  const fitLabel = z?.mode === 'fit-width' ? 'Fit page' : 'Fit width'
  const total = found?.total ?? 0
  const settled = !!doc && extracted?.doc === doc.doc
  const noText = settled && !!extracted?.empty
  const totalText = total >= FIND_MAX ? '10,000+' : `${total.toLocaleString('en-US')}${settled ? '' : '+'}`
  // pdf.js counts a new query only after its own delay, so extraction can settle before the first count arrives.
  const countText = !deferred ? '' : noText ? 'No text' : total ? `${found?.cur || 1} of ${totalText}` : settled && found ? 'No matches' : ''
  const statusText = !deferred || !settled ? '' : noText ? 'This PDF has no text to search. It may be scanned.' : !found ? '' : total ? `Match ${found.cur || 1} of ${totalText}` : 'No matches'

  const state = ((): JSX.Element | null => {
    if (shown.t === 'loading') return slow ? <p className="text-meta text-dim">{`Loading ${name}`}</p> : null
    if (shown.t === 'doc') return null
    const head = (title: string, body?: string): JSX.Element => (
      <>
        <p className="text-ui font-medium text-content">{title}</p>
        {body && <p className="max-w-[60ch] text-ui text-dim">{body}</p>}
      </>
    )
    const app = (
      <Button variant="secondary" size="sm" onClick={openApp}>
        Open in default app
      </Button>
    )
    switch (shown.t) {
      case 'empty':
        return head(`${name} is empty`)
      case 'locked':
        return (
          <>
            {head(`${name} is password protected`, "Clui doesn't open password-protected PDFs. Open it in your default app to enter the password.")}
            <div className="flex gap-2">{app}</div>
          </>
        )
      case 'damaged':
        return (
          <>
            {head(`Couldn't open ${name}`, "It isn't a readable PDF. The file may be damaged or incomplete.")}
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => void load()}>
                Try again
              </Button>
              {app}
            </div>
          </>
        )
      case 'not-pdf':
        return (
          <>
            {head(`Clui can't show ${name}`, "Its contents aren't a PDF.")}
            <div className="flex gap-2">{app}</div>
          </>
        )
      case 'xfa':
        return (
          <>
            {head(`Clui can't show ${name}`, "It's an XFA form, which Clui doesn't draw.")}
            <div className="flex gap-2">{app}</div>
          </>
        )
      case 'too-large':
        return (
          <>
            {head(`${name} is too large to show here`, `It's ${Math.round(shown.bytes / 1024 / 1024)} MB. Clui shows PDFs up to 200 MB.`)}
            <div className="flex gap-2">{app}</div>
          </>
        )
      default: {
        const d: Doc = shown.t === 'missing' ? { t: 'missing' } : { t: 'error', reason: shown.reason, message: shown.message }
        return <DocState handleId={handleId} tabId={tabId} path={path} doc={d} load={load} reopen={reopen} />
      }
    }
  })()

  const pointedRow =
    rowHost && highlight && doc
      ? createPortal(
          <>
            <IconTarget className="h-3 w-3" />
            {highlight > doc.pages ? `Claude pointed to page ${highlight}. This PDF has ${pageCount(doc.pages)}.` : `Claude pointed to page ${highlight}`}
          </>,
          rowHost
        )
      : null

  const renderItems = (ts: { it: Item; i: number; kids: unknown[] }[]): JSX.Element => (
    <ul>
      {ts.map(({ it, i, kids }) => (
        <li key={i}>
          {it.dest || it.url ? (
            <button
              type="button"
              title={it.title}
              aria-current={i === currentItem ? 'location' : undefined}
              onClick={(e) => contentsJump(it, e.metaKey || e.ctrlKey)}
              style={{ paddingLeft: 8 + Math.min(it.depth, 5) * 12 }}
              className={`relative flex min-h-7 w-full items-center truncate rounded px-2 text-left text-ui text-content pointer-fine:hover:bg-row-hover ${i === currentItem ? 'font-medium' : ''}`}
            >
              {i === currentItem && <span aria-hidden="true" className="absolute inset-y-1 left-0.5 w-0.5 rounded-full bg-dim" />}
              <span className="truncate">{it.title}</span>
            </button>
          ) : (
            <span title={it.title} style={{ paddingLeft: 8 + Math.min(it.depth, 5) * 12 }} className="flex min-h-7 items-center truncate px-2 text-ui text-dim">
              {it.title}
            </span>
          )}
          {kids.length ? renderItems(kids as { it: Item; i: number; kids: unknown[] }[]) : null}
        </li>
      ))}
    </ul>
  )

  return (
    <div data-ui="pdf-surface" className="flex h-full min-h-0 flex-col bg-bg pt-(--top-h)">
      {bar && (
        <div className="flex h-9 shrink-0 items-center border-b border-border bg-bg px-1">
          {bar === 'find' ? (
            <FindField
              ui="pdf-find"
              inputRef={findInput}
              value={query}
              onChange={setQuery}
              onEnter={(shift) => runFind(deferred, 'again', shift)}
              onClose={() => {
                setQuery('')
                closeBar('region')
              }}
              onPrev={() => runFind(deferred, 'again', true)}
              onNext={() => runFind(deferred, 'again')}
              stepDisabled={!total}
              countText={countText}
              statusText={statusText}
              placeholder="Find in PDF"
              label={`Find in ${name}`}
            />
          ) : (
            <FindField
              ui="pdf-goto-bar"
              inputRef={gotoInput}
              value={gotoText}
              onChange={(v) => {
                setGotoText(v)
                setGotoBad(false)
              }}
              onEnter={submitGoto}
              onClose={() => closeBar('back')}
              countText={doc ? (gotoBad ? `Enter 1 to ${doc.pages.toLocaleString('en-US')}` : `of ${doc.pages.toLocaleString('en-US')}`) : ''}
              countId={`goto-hint-${tabId}`}
              countClass={gotoBad ? 'text-err' : 'text-dim'}
              placeholder="Page number"
              label="Go to page"
              icon={<IconHash className="h-3.5 w-3.5 shrink-0 text-dim" />}
              invalid={gotoBad}
              numeric
              closeLabel="Close go to page"
            />
          )}
        </div>
      )}
      <div data-ui="pdf-toolbar" className="flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-b border-border px-1">
        {doc && (
          <button
            type="button"
            data-ui="pdf-page"
            aria-label={`Page ${current.toLocaleString('en-US')} of ${doc.pages.toLocaleString('en-US')}, go to page`}
            title="Go to page ⌘L"
            onClick={() => window.dispatchEvent(new Event(FILE_GOTO_EVENT))}
            className={`${TEXT_BUTTON} tabular-nums`}
          >
            {`Page ${current.toLocaleString('en-US')} of ${doc.pages.toLocaleString('en-US')}`}
          </button>
        )}
        <span className="min-w-0 flex-1" />
        {doc && z && (
          <div className="flex shrink-0 flex-wrap items-center gap-0.5">
            {outline && (
              <button type="button" data-ui="pdf-contents" {...contents.triggerProps} aria-haspopup="dialog" title="Contents" className={TEXT_BUTTON}>
                Contents
              </button>
            )}
            <ZoomGroup s={z.s} atMin={atMin} atMax={atMax} max={PDF_MAX} onStep={step}>
              <button type="button" data-ui="pdf-fit" title={`${fitLabel} ⌘0`} onClick={toggleFit} className={TEXT_BUTTON}>
                {fitLabel}
              </button>
            </ZoomGroup>
          </div>
        )}
      </div>
      {outline && (
        <div {...contents.popoverProps} className="pop-base pop glass-thick max-h-[min(480px,70vh)] w-[min(320px,calc(100%-16px))] overflow-auto rounded-lg py-1" onKeyDown={onContentsKey}>
          <nav aria-label={`Contents of ${name}`} className="px-1">
            {renderItems(nested)}
          </nav>
        </div>
      )}
      <div ref={frameEl} className="pdf-frame relative min-h-0 flex-1">
        <div
          ref={viewportEl}
          role="region"
          aria-label={doc ? `${name}, PDF, ${pageCount(doc.pages)}` : name}
          aria-busy={shown.t === 'loading' || undefined}
          aria-keyshortcuts={KEYS}
          tabIndex={0}
          data-ui="pdf-viewport"
          data-beside-header=""
          data-pointing={pointing || undefined}
          {...(shown.t === 'loading' ? {} : { 'data-pane-title': '' })}
          onScroll={onScroll}
          onMouseDown={(e) => {
            down.current = { x: e.clientX, y: e.clientY }
          }}
          onMouseUp={onMouseUp}
          onClick={onClick}
          onAuxClick={(e) => e.preventDefault()}
          className={`pdf-viewport absolute inset-0 overflow-auto bg-page-gutter focus-visible:outline-none ${pointing ? 'cursor-crosshair' : ''}`}
        >
          <div ref={columnEl} className="pdfViewer pdf-column" />
          {state && (
            <div ref={stateEl} className={STATE_BODY}>
              {state}
            </div>
          )}
        </div>
        {doc && (
          <RegionPicker
            ref={picker}
            viewport={viewportEl}
            content={pageEl}
            basis={basis}
            selection={picked}
            pointing={pointing}
            onChange={(next) => {
              const page = pressPage.current || pickPage
              setSelection(next ? { page, ...next } : null)
            }}
            onAdd={() => void addRef.current()}
            onEnd={() => {
              setPointing(tabId, false)
              clearTimeout(selSay.current)
              say(POINT_OFF)
            }}
            panning={() => false}
          />
        )}
      </div>
      {pointedRow}
      {notice && <SelectionNotice notice={notice} copy={NOTICE} onDismiss={() => setNotice(null)} />}
      {doc && selection ? (
        <SelectionBar label={barLabel} attached={inTarget} onAdd={() => void add()} busy={adding || !input} />
      ) : doc && pointing ? (
        <SelectionBar label={POINT_HINT} blocked={POINT_HINT} onBlocked={() => say(POINT_HINT)} attached={false} onAdd={() => {}} />
      ) : null}
      <span data-ui="pdf-live" className="sr-only" aria-live="polite">
        {said}
      </span>
    </div>
  )
}
