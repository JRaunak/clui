import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { refsOf, useActive, useSession } from '../../store'
import type { DraftReference, SourceVersion } from '../../../../shared/context'
import type { Refusal } from '../../../../shared/files'
import {
  a1Of,
  CELL_CEILING,
  CELL_FULL_MAX,
  clampA1,
  colIndex,
  colName,
  COPY_MAX,
  CSV_BYTES_MAX,
  isDelimited,
  isWorkbook,
  parseA1,
  qualified,
  VALUES_MAX,
  type A1,
  type Border,
  type BookFailure,
  type CellDetail,
  type CellStyle,
  type Rect,
  type SheetCell,
  type SheetGeo,
  type SheetWindow
} from '../../../../shared/sheets'
import type { Delimiter } from '../../../../shared/surfaces'
import { isOds, type Flight, type LoFacts } from '../../../../shared/office'
import { FindField } from '../FindField'
import { IconChevron } from '../Icon'
import { Menu } from '../Menu'
import { PointedRow } from '../Markdown'
import { addFromSurface } from '../ContextChips'
import { PANE_BTN } from './PaneHeader'
import { ANNOUNCE_MS, SelectionBar } from './SelectionBar'
import { BANNER, baseOf, DocState, FIND_MAX, openDefault, REASON, SelectionNotice, setStatus, SKELETON_MS, STATE_BODY, TEXT_BTN, useFind, VIEW_SETTLE_MS, viewSourceAt, type Doc } from './fileDoc'
import { NotShown, SheetTabs } from './SheetStrip'
import { ConvertingBody, useConversion, type Done } from './Converting'
import { unpackDetail } from '../../lib/docxView'
import { isNumber, oneLine, type CsvFacts } from '../../lib/csv'
import { openCsv, type CsvSource } from '../../lib/csvSource'
import { openBook, type BookSource } from '../../lib/bookSource'
import { readable, type RGB } from '../../lib/fileColor'
import {
  bookGaps,
  bookReadout,
  cellCount,
  colAt,
  colRange,
  delimiterName,
  fmt,
  heightOf,
  hiddenSaid,
  millions,
  offsetsOf,
  prefix,
  readAs,
  readout,
  ROW_H,
  rowAt,
  rowHeaderW,
  rowWindow,
  scrollSpace,
  scrollToCol,
  scrollToRow,
  selectedLabel,
  selectedSaid,
  sheetGaps,
  topOf,
  type Off
} from '../../lib/sheetView'
import { useSay } from '../../lib/useSay'
import { viaOf } from '../../lib/motion'
import { noteRead } from '../../lib/blockedFiles'
import { POINT_OFF, SHEET_POINT_HINT } from '../../lib/refCopy'
import { setPointing, takePoint, takeSurfaceFocus, usePointing, usePointRequest } from '../../lib/surfaceFocus'

const HEAD_H = 24
/** A workbook row's default height: 15pt. */
const XROW = 20
const cut = (t: number, r: number, b: number, l: number): string => `inset(${t}px ${r}px ${b}px ${l}px)`
const OVER = 3
// A fetched window reaches this far past what's drawn, so ordinary scrolling never waits on the worker.
const MARGIN_ROWS = 60
const MARGIN_COLS = 12
const TURN_RELOAD_MS = 300
const MISSING_POLL_MS = 2000
const AUTOSCROLL_MAX = 4
const KEYS = 'Meta+Shift+A Meta+F Meta+A Meta+C'
const POINTING_SAID = 'Pointing. Click a cell or drag across cells to select. Shift and an arrow key extends. Enter adds it.'
const NOTICE = {
  cleared: 'The file changed on disk, so the selection was cleared.',
  removed: 'The file changed on disk, so the selection was cleared and removed from the message.'
}
const COPY_LIMIT = `Copy is limited to ${fmt(COPY_MAX)} cells. Select fewer.`
const DELIMS: Delimiter[] = [',', ';', '\t', '|']
const MB = 1024 * 1024
const FILL = 'color-mix(in oklab, var(--color-accent) 12%, transparent)'
const SAVED_TITLE = 'Clui never calculates formulas. This is the result last saved in the file, and it can be out of date.'
const UNCALC_TITLE = 'The file has no saved result for this formula, and Clui never calculates formulas.'

type Shown = { t: 'loading' } | { t: 'grid' } | { t: 'empty' } | { t: 'unsupported'; detail: string } | { t: 'doc'; doc: Doc } | { t: 'failed'; failure: BookFailure } | { t: 'stopped' } | { t: 'needs-lo' } | { t: 'flight'; flight: Flight }
type Cell = { r: number; c: number }
/** One open of a CSV: its worker and what it has indexed. */
type Load = { src: CsvSource | null; facts: CsvFacts | null }
type Win = { src: unknown; key: string; r0: number; r1: number; c0: number; c1: number; records: number; cells: Map<string, SheetCell>; fields: Map<number, number>; merges: SheetWindow['merges'] }
type Box = { top: number; left: number; width: number; height: number; open: { t: boolean; r: boolean; b: boolean; l: boolean } }
type Bar = CellDetail & { at: string }

const UNSUPPORTED: Record<string, string> = {
  xls: "It's an older Excel workbook (.xls). Clui shows .xlsx, .xlsm, .csv and .tsv files.",
  xlsb: "It's a binary Excel workbook (.xlsb). Clui shows .xlsx, .xlsm, .csv and .tsv files."
}
const LIBREOFFICE = 'https://www.libreoffice.org/'
/** Spec 13's saved-results sentences would describe LibreOffice's XLSX, not the .ods, so these replace them. */
const odsGaps = (by: string, f: LoFacts): string[] => [
  `Converted from OpenDocument by ${by}. Some formatting can differ.`,
  'LibreOffice recalculated this workbook, so values may differ from the saved ones.',
  ...(f.linkedSheets ? [f.linkedSheets === 1 ? "1 sheet linked from another file isn't shown." : `${fmt(f.linkedSheets)} sheets linked from other files aren't shown.`] : []),
  ...bookGaps({ macros: f.macros, links: f.links, recalc: false })
]

// Text widths at the grid's font, for spills and number fit; cleared when full rather than growing without end.
const widthCache = new Map<string, number>()
let measureCtx: CanvasRenderingContext2D | null = null
function textW(s: string, font: string): number {
  const key = `${font}\0${s}`
  const hit = widthCache.get(key)
  if (hit !== undefined) return hit
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx) return s.length * 7
  measureCtx.font = font
  const w = measureCtx.measureText(s).width
  if (widthCache.size > 20_000) widthCache.clear()
  widthCache.set(key, w)
  return w
}

/** A field's text on one line, its breaks marked with a faint ↵ that isn't read out. */
function shownText(v: string): ReactNode {
  if (!v.includes('\n')) return v
  return v.split(/\r?\n/).flatMap((part, i) => (i ? [<span key={i} aria-hidden="true" className="text-faint">{' ↵ '}</span>, part] : [part]))
}

const inRect = (r: number, c: number, a: Rect | null): boolean => !!a && r >= a.r0 && r <= a.r1 && c >= a.c0 && c <= a.c1
const BORDER: Record<Exclude<Border, 0>, string> = {
  1: '1px solid var(--color-control-edge)',
  2: '1px dotted var(--color-control-edge)',
  3: '1px dashed var(--color-control-edge)',
  4: '2px solid var(--color-dim)',
  5: '3px double var(--color-dim)'
}
// What a workbook writes for its automatic text and paper colours, not a Clui colour.
const AUTO_INK = '#000000'
const AUTO_PAPER = '#ffffff'
/** The theme's background as sRGB bytes, which the file colours are moved against. */
function themeBg(): RGB {
  const c = document.createElement('canvas')
  c.width = c.height = 1
  const x = c.getContext('2d')
  if (!x) return [22, 22, 23]
  x.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim()
  x.fillRect(0, 0, 1, 1)
  const [r, g, b] = x.getImageData(0, 0, 1, 1).data
  return [r, g, b]
}
/** A file style as CSS: fills and their own text pair verbatim; text on an unfilled cell moved to 4.5:1 on `bg`, and
 *  `auto`, black and white there taken as Clui's content ink. */
function cssOf(st: CellStyle | undefined, bg: RGB): CSSProperties {
  if (!st) return {}
  const out: CSSProperties = {}
  if (st.fill) {
    out.background = st.fill
    out.color = st.ink ?? AUTO_INK
  } else if (st.ink && st.ink !== AUTO_INK && st.ink !== AUTO_PAPER) out.color = readable(st.ink, bg, 4.5)
  if (st.b) out.fontWeight = 600
  if (st.i) out.fontStyle = 'italic'
  const lines = [st.u && 'underline', st.s && 'line-through'].filter(Boolean).join(' ')
  if (lines) out.textDecoration = `${lines}${st.u === 2 ? ' double' : ''}`
  return out
}

/**
 * A CSV, TSV or Excel workbook as a grid: column letters and row numbers, a formula bar for the cell you're on, a range
 * selection that becomes a `sheet` reference, and find. A CSV is indexed by a worker on the page; a workbook is parsed
 * in its own process and held by a worker. The grid draws only the rows and columns in view and asks for their cells.
 */
export function SheetSurface({ handleId, tabId }: { handleId: string; tabId: string }): JSX.Element {
  const tab = useActive((s) => s?.surfaces.tabs[tabId])
  const path = tab?.key ?? ''
  const name = baseOf(path)
  const ods = isOds(path)
  const xlsx = isWorkbook(path) || ods
  const owner = `${handleId}\0${path}`
  const busy = useActive((s) => !!s?.busy)
  const setView = useSession((s) => s.setSurfaceView)
  const view = tab?.viewState?.kind === 'sheet' ? tab.viewState : undefined
  const selRange = tab?.selection?.range
  const highlight = tab?.highlight
  const location = tab?.location
  const gridId = useId().replace(/:/g, '')
  const [said, say] = useSay()

  const [shown, setShown] = useState<Shown>({ t: 'loading' })
  const [slow, setSlow] = useState(false)
  const [cur, setCur] = useState<Load | null>(null)
  const [facts, setFacts] = useState<CsvFacts | null>(null)
  const [book, setBook] = useState<BookSource | null>(null)
  const [sheetI, setSheetI] = useState(0)
  const [geo, setGeo] = useState<SheetGeo | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  // An .ods converts to XLSX first, then reads as any workbook does.
  const [odsFlight, setOdsFlight] = useState<{ revision: string; facts: LoFacts } | null>(null)
  const libre = useConversion(handleId, path, odsFlight?.revision ?? null, { onStale: () => scheduleLoad(), onMissing: () => void load() })
  const [updating, setUpdating] = useState(false)
  const [version, setVersion] = useState<{ revision: string; version?: SourceVersion; refused?: Refusal['reason'] } | null>(null)
  const [notice, setNotice] = useState<'cleared' | 'removed' | 'copy' | null>(null)
  const curRef = useRef<Load | null>(null)
  const bookRef = useRef<BookSource | null>(null)
  const opening = useRef<{ stop(): void } | null>(null)
  const pending = useRef<Load | null>(null)
  const loadGen = useRef(0)
  const src = cur?.src ?? null
  const live = xlsx ? book : src
  const scroller = useRef<HTMLDivElement | null>(null)
  const root = useRef<HTMLDivElement | null>(null)
  const font = useRef('')
  const [bg, setBg] = useState<RGB>([22, 22, 23])
  const sheetName = xlsx ? book?.facts.sheets[sheetI]?.name : undefined

  // The active sheet's shape. A CSV's rows are an estimate until its index is done, so the scrollbar doesn't race the read.
  const records = xlsx ? (geo?.rows ?? 0) : (facts?.records ?? 0)
  const cols = Math.max(1, xlsx ? (geo?.cols ?? 1) : (facts?.cols ?? 1))
  const header = !xlsx && !!facts && (view?.header ?? facts.detected.header)
  const fr = xlsx ? (geo?.frozen.rows ?? 0) : header && records > 0 ? 1 : 0
  const fc = xlsx ? (geo?.frozen.cols ?? 0) : 0
  const rows = xlsx ? records : !facts ? 0 : facts.done || !facts.bytes ? records : Math.max(records, Math.round((records * facts.total) / facts.bytes))
  const exact = xlsx || !!facts?.done
  const showHidden = !!view?.showHidden
  const hidR = useMemo(() => new Set(geo && !showHidden ? geo.hiddenRows : []), [geo, showHidden])
  const hidC = useMemo(() => new Set(geo && !showHidden ? geo.hiddenCols : []), [geo, showHidden])
  const merges = useMemo(() => {
    const out: Rect[] = []
    const m = geo?.merges
    if (m) for (let i = 0; i < m.length; i += 4) out.push({ r0: m[i], c0: m[i + 1], r1: m[i + 2], c1: m[i + 3] })
    return out
  }, [geo])
  const mergeAt = (r: number, c: number): Rect | null => merges.find((m) => inRect(r, c, m)) ?? null
  const styles = book?.facts.styles

  const settle = (next: Shown): void => {
    setStatus(owner, next.t === 'loading' ? 'loading' : next.t === 'doc' ? next.doc.t : next.t === 'grid' ? 'binary' : 'error')
    setShown(next)
  }

  // Selection state lives on the tab as A1; the anchor and active cell are this view's.
  const sel = useMemo(() => (selRange && (!xlsx || tab?.selection?.sheet === sheetName) ? parseA1(selRange) : null), [selRange, xlsx, tab?.selection?.sheet, sheetName])
  const selRect = useMemo(() => (sel ? clampA1(sel, Math.max(1, records), cols) : null), [sel, records, cols])
  // The active cell stays at the anchor as a range grows; `end` is the corner that moves.
  const [active, setActive] = useState<Cell | null>(null)
  const anchor = useRef<Cell | null>(null)
  const end = useRef<Cell | null>(null)
  const [focused, setFocused] = useState(false)
  const selSay = useRef<ReturnType<typeof setTimeout>>()
  const pointing = usePointing(tabId)
  const asked = usePointRequest(tabId)

  const own = useRef<string | undefined>(undefined)
  const writeSel = useCallback(
    (a: A1 | null) => {
      setNotice(null)
      own.current = a ? a1Of(a) : undefined
      setView(handleId, tabId, {
        selection: a ? { range: a1Of(a), ...(sheetName !== undefined ? { sheet: sheetName } : {}), ...(version?.version ? { sourceVersion: version.version } : {}) } : undefined,
        highlight: undefined
      })
    },
    [handleId, tabId, setView, version, sheetName]
  )

  const clearSel = (): void => {
    if (!curSelRef.current) return
    const inMessage = attachedRef.current
    setView(handleId, tabId, { selection: undefined })
    setNotice(inMessage ? 'removed' : 'cleared')
    say(NOTICE[inMessage ? 'removed' : 'cleared'])
  }
  const curSelRef = useRef(selRange)
  curSelRef.current = selRange

  // Whether the selection is a reference in the draft or a queued message, at this version.
  const isThis = ({ ref: r }: DraftReference): boolean => r.kind === 'sheet' && r.path === path && r.range === selRange && r.sheet === sheetName && r.sourceVersion === version?.version
  const attached = useActive((s) => !!s && !!selRange && [s.contextRefs, ...s.queuedMessages.map((q) => q.refs)].some((l) => l.some(isThis)))
  const inTarget = useActive((s) => !!s && !!selRange && !!refsOf(s, s.referenceEditTarget)?.some(isThis))
  const attachedRef = useRef(attached)
  attachedRef.current = attached

  // Reads and re-reads. A re-read keeps the old grid until the new revision can paint.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastLoad = useRef(0)
  const [watchGen, setWatchGen] = useState(0)
  const delimiterRef = useRef(view?.delimiter)
  delimiterRef.current = view?.delimiter

  const show = (l: Load): void => {
    if (!l.facts || !l.src) return
    if (curRef.current === l) return setFacts(l.facts)
    if (pending.current !== l || (!l.facts.records && !l.facts.done)) return
    pending.current = null
    curRef.current?.src?.close()
    curRef.current = l
    setCur(l)
    setFacts(l.facts)
    setUpdating(false)
    setVersion(null)
    setFound(null)
    clearSel()
    settle(l.facts.records ? { t: 'grid' } : { t: 'empty' })
  }

  // A workbook's sheet by name, so a re-read and a restored tab keep the one the user was on.
  const sheetWanted = useRef<string | undefined>(view?.sheet)
  const loadBook = async (gen: number, from?: Done): Promise<void> => {
    opening.current?.stop()
    setProgress(null)
    const o = openBook(handleId, path, (f) => gen === loadGen.current && setProgress(f), from)
    opening.current = o
    const r = await o.done
    if (opening.current === o) opening.current = null
    if (gen !== loadGen.current) return r.t === 'ready' ? r.src.close() : undefined
    if (r.t === 'refused') {
      noteRead(handleId, path, r.refusal.reason)
      setUpdating(false)
      return settle(refusal(r.refusal))
    }
    noteRead(handleId, path, null)
    if (r.t !== 'ready') {
      bookRef.current?.close()
      bookRef.current = null
      setBook(null)
      setUpdating(false)
      return settle(r.t === 'empty' ? { t: 'empty' } : r.t === 'stopped' ? { t: 'stopped' } : { t: 'failed', failure: r.failure })
    }
    if (r.src.revision === bookRef.current?.revision) {
      setUpdating(false)
      return r.src.close()
    }
    const s = r.src
    const want = sheetWanted.current ?? highlightSheet.current
    const named = s.facts.sheets.findIndex((x) => x.name === want)
    const at = named < 0 ? s.facts.active : named
    const g = await s.ask('geo', { s: at })
    if (gen !== loadGen.current) return s.close()
    const old = bookRef.current
    bookRef.current = s
    old?.close()
    places.current.clear()
    setBook(s)
    setSheetI(at)
    setGeo(g)
    setVersion({ revision: s.revision, version: s.version })
    setUpdating(false)
    setFound(null)
    if (old) clearSel()
    settle({ t: 'grid' })
  }

  const load = useCallback(async (): Promise<void> => {
    const gen = ++loadGen.current
    lastLoad.current = Date.now()
    if (isOds(path)) {
      const r = await window.clui.officeOpen(handleId, path).catch((): Refusal => ({ ok: false, reason: 'unreadable' }))
      if (gen !== loadGen.current) return
      noteRead(handleId, path, r.ok ? null : r.reason)
      if (!r.ok) return settle(refusal(r))
      if (r.t === 'convert') {
        if (bookRef.current) setUpdating(true)
        return setOdsFlight((f) => (f?.revision === r.revision ? f : { revision: r.revision, facts: r.facts }))
      }
      setOdsFlight(null)
      return settle(r.t === 'needs-lo' ? { t: 'needs-lo' } : r.t === 'empty' ? { t: 'empty' } : { t: 'flight', flight: r })
    }
    if (isWorkbook(path)) {
      if (bookRef.current) setUpdating(true)
      return loadBook(gen)
    }
    if (!isDelimited(path)) {
      const st = await window.clui.statFile(handleId, path).catch((): Refusal => ({ ok: false, reason: 'unreadable' }))
      if (gen !== loadGen.current) return
      noteRead(handleId, path, st.ok ? null : st.reason)
      const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
      return settle(st.ok ? { t: 'unsupported', detail: UNSUPPORTED[ext] ?? UNSUPPORTED.xls } : refusal(st))
    }
    const l: Load = { src: null, facts: null }
    const delimiter = delimiterRef.current ?? (/\.tsv$/i.test(path) ? '\t' : undefined)
    const s = await openCsv(
      handleId,
      path,
      { font: font.current || '13px -apple-system, system-ui, sans-serif', ...(delimiter ? { delimiter } : {}) },
      (f) => {
        l.facts = f
        if (gen === loadGen.current || curRef.current === l) show(l)
      },
      (r) => {
        if (r.reason === 'changed') return scheduleLoad()
        if (curRef.current === l) settle(refusal(r))
      }
    )
    if (!('ask' in s)) {
      if (gen !== loadGen.current) return
      noteRead(handleId, path, s.reason)
      pending.current?.src?.close()
      pending.current = null
      setUpdating(false)
      return settle(refusal(s))
    }
    noteRead(handleId, path, null)
    if (gen !== loadGen.current || s.revision === curRef.current?.src?.revision) return s.close()
    l.src = s
    pending.current?.src?.close()
    pending.current = l
    if (curRef.current?.src) setUpdating(true)
    show(l)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleId, path])

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
    // The grid's font, measured on a stand-in, since a workbook's grid isn't there until it's read. The `font`
    // shorthand reads back empty once tabular-nums is set, so it's built from its parts.
    const el = root.current
    if (el && !font.current) {
      const probe = el.appendChild(document.createElement('span'))
      probe.className = 'font-sans text-label tabular-nums'
      const cs = getComputedStyle(probe)
      font.current = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
      probe.remove()
    }
    setSlow(false)
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
      curRef.current?.src?.close()
      pending.current?.src?.close()
      opening.current?.stop()
      bookRef.current?.close()
      clearTimeout(selSay.current)
      clearTimeout(saveTimer.current)
      setStatus(owner, null)
    },
    [owner]
  )
  const stopReading = (): void => {
    loadGen.current++
    opening.current?.stop()
    opening.current = null
    settle({ t: 'stopped' })
  }
  useEffect(() => {
    if (libre.done) void loadBook(++loadGen.current, libre.done)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libre.done])
  const retry = (): void => {
    settle({ t: 'loading' })
    setSlow(false)
    const t = setTimeout(() => setSlow(true), SKELETON_MS)
    void load().finally(() => clearTimeout(t))
  }

  // The file colours move against the theme's background, so they follow a theme change.
  useEffect(() => {
    setBg(themeBg())
    const mo = new MutationObserver(() => setBg(themeBg()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
    return () => mo.disconnect()
  }, [])

  // Watched while shown; focus reconciles, since watch events are hints.
  useEffect(() => {
    let id: string | null = null
    let alive = true
    const off = window.clui.onFileChanged((e) => {
      if (e.handleId === handleId && e.id === id) scheduleLoad()
    })
    void window.clui.watchFile(handleId, path).then((w) => {
      if (!w.ok) return
      if (alive) id = w.id
      else void window.clui.unwatchFile(handleId, w.id)
    })
    window.addEventListener('focus', scheduleLoad)
    return () => {
      alive = false
      off()
      window.removeEventListener('focus', scheduleLoad)
      if (id) void window.clui.unwatchFile(handleId, id)
    }
  }, [handleId, path, watchGen, scheduleLoad])
  useEffect(() => {
    if (shown.t !== 'doc' || shown.doc.t !== 'missing') return
    const t = setInterval(() => {
      void window.clui.statFile(handleId, path).then((s) => {
        if (!s.ok) return
        void load()
        setWatchGen((n) => n + 1)
      })
    }, MISSING_POLL_MS)
    return () => clearInterval(t)
  }, [shown, handleId, path, load])

  // The version a CSV reference records: main hashes the bytes of the revision this grid read, once it's all in. A
  // workbook's comes with its open.
  useEffect(() => {
    if (!src || !facts?.done || version?.revision === src.revision) return
    const rev = src.revision
    void window.clui
      .docVersion(handleId, path, rev)
      .catch((): Refusal => ({ ok: false, reason: 'unreadable' }))
      .then((r) => {
        if (curRef.current?.src?.revision !== rev) return
        if (r.ok) setVersion({ revision: rev, version: r.version })
        else if (r.reason === 'changed') scheduleLoad()
        else setVersion({ revision: rev, refused: r.reason })
      })
  }, [src, facts?.done, version, handleId, path, scheduleLoad])

  // Geometry. Rows split into the frozen band and the scrolling body, columns into frozen and scrolling; hidden ones
  // are zero wide or tall unless the user shows them.
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const widths = useMemo(() => (xlsx ? (geo ? Array.from(geo.widths, (w, c) => (hidC.has(c) ? 0 : w)) : undefined) : facts?.widths), [xlsx, geo, hidC, facts?.widths])
  const off = useMemo(() => offsetsOf(widths, cols), [widths, cols])
  const rowPx = useCallback((r: number): number => (hidR.has(r) ? 0 : (geo?.heights?.[r] ?? XROW)), [geo, hidR])
  const body = Math.max(0, rows - fr)
  const bandOff: Off = useMemo(() => (xlsx ? prefix(fr, rowPx) : null), [xlsx, fr, rowPx])
  const bodyOff: Off = useMemo(() => (xlsx ? prefix(body, (j) => rowPx(fr + j)) : null), [xlsx, body, fr, rowPx])
  const rhW = rowHeaderW(rows)
  const fw = off[fc]
  const bandH = HEAD_H + topOf(bandOff, fr)
  const viewH = Math.max(0, box.h - bandH)
  const viewW = Math.max(0, box.w - rhW)
  const space = scrollSpace(body, viewH, bodyOff)
  const rw = rowWindow(pos.top, viewH, body, space.k, OVER, bodyOff)
  const [c0raw, c1] = colRange(off, fw + pos.left, Math.max(0, viewW - fw), OVER)
  const c0 = Math.max(fc, c0raw)
  const blockTop = pos.top + bandH + topOf(bodyOff, rw.r0) - rw.v
  const blockH = topOf(bodyOff, rw.r1 + 1) - topOf(bodyOff, rw.r0)
  const contentW = rhW + off[cols]
  const rowH = (r: number): number => (r < fr ? heightOf(bandOff, r) : heightOf(bodyOff, r - fr))

  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [shown.t])
  // The same frame as the scroll, so a scrollbar jump never paints the rows of the old place.
  const onScroll = (): void => {
    const el = scroller.current
    if (!el) return
    flushSync(() => setPos({ top: el.scrollTop, left: el.scrollLeft }))
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(saveView, VIEW_SETTLE_MS)
  }
  const geoRef = useRef({ rw, bandH, fr, fc, fw, rhW, off, bandOff, bodyOff, k: space.k, body, viewH, viewW, records, cols, pos })
  geoRef.current = { rw, bandH, fr, fc, fw, rhW, off, bandOff, bodyOff, k: space.k, body, viewH, viewW, records, cols, pos }

  // The window of cells: fetched with a margin, one request at a time, refetched as a CSV's index grows into it.
  const [win, setWin] = useState<Win | null>(null)
  const contentKey = xlsx ? `${sheetI}` : `${facts?.delimiter}\0${facts?.encoding}\0${facts?.done}`
  const fetching = useRef(false)
  const [fetchGen, setFetchGen] = useState(0)
  const wantR0 = fr + rw.r0
  const wantR1 = Math.min(records - 1, fr + rw.r1)
  useEffect(() => {
    if (!live || !records || fetching.current) return
    const w = win
    const fresh = !!w && w.src === live && w.key === contentKey && !(w.r1 >= w.records - 1 && records > w.records)
    if (fresh && w.r0 <= wantR0 && w.r1 >= wantR1 && w.c0 <= c0 && w.c1 >= c1) return
    const r0 = Math.max(0, wantR0 - MARGIN_ROWS)
    const r1 = Math.min(records - 1, wantR1 + MARGIN_ROWS)
    const a = Math.max(0, c0 - MARGIN_COLS)
    const b = Math.min(cols - 1, c1 + MARGIN_COLS)
    fetching.current = true
    const at = { records, key: contentKey, s: sheetI }
    const asked = xlsx ? book!.ask('window', { s: sheetI, r0, r1, c0: a, c1: b, fr, fc }) : src!.ask('window', { r0, r1, c0: a, c1: b, pin: fr ? [0] : [] })
    void asked.then((res: SheetWindow | null) => {
      fetching.current = false
      const now = xlsx ? bookRef.current : curRef.current?.src
      // A superseded window (another sheet, another revision) asks again for the place now in view.
      if (now !== live || !res || (xlsx && at.s !== sheetIRef.current)) return setFetchGen((n) => n + 1)
      const cells = new Map<string, SheetCell>()
      for (const c of res.cells) cells.set(`${c.row},${c.col}`, c)
      const fields = new Map<number, number>()
      res.fields?.forEach((n, i) => fields.set(r0 + i, n))
      setWin({ src: live, key: at.key, r0, r1, c0: a, c1: b, records: at.records, cells, fields, merges: res.merges })
    })
  }, [live, records, contentKey, wantR0, wantR1, c0, c1, cols, fr, fc, win, xlsx, book, src, sheetI, fetchGen])
  const sheetIRef = useRef(sheetI)
  sheetIRef.current = sheetI

  const valueAt = (r: number, c: number): string => win?.cells.get(`${r},${c}`)?.value ?? ''
  const cellId = (r: number, c: number): string => `${gridId}-r${r}c${c}`

  /** A range grown to hold every merge it touches, as Excel grows it. */
  const grown = (a: Rect): Rect => {
    const g = { ...a }
    for (let changed = true; changed; ) {
      changed = false
      for (const m of merges) {
        if (m.r0 > g.r1 || m.r1 < g.r0 || m.c0 > g.c1 || m.c1 < g.c0) continue
        if (m.r0 < g.r0 || m.r1 > g.r1 || m.c0 < g.c0 || m.c1 > g.c1) {
          g.r0 = Math.min(g.r0, m.r0)
          g.r1 = Math.max(g.r1, m.r1)
          g.c0 = Math.min(g.c0, m.c0)
          g.c1 = Math.max(g.c1, m.c1)
          changed = true
        }
      }
    }
    return g
  }
  const select = (a: Cell, f: Cell, shape: A1['shape'] = 'cells'): void => {
    anchor.current = a
    end.current = f
    const r = { r0: Math.min(a.r, f.r), r1: Math.max(a.r, f.r), c0: Math.min(a.c, f.c), c1: Math.max(a.c, f.c) }
    writeSel(shape === 'rows' ? { ...r, shape, c0: 0, c1: Infinity } : shape === 'cols' ? { ...r, shape, r0: 0, r1: Infinity } : { ...grown(r), shape })
  }
  const usedRange = (): void => {
    if (!records) return
    anchor.current = { r: 0, c: 0 }
    setActive({ r: 0, c: 0 })
    writeSel({ shape: 'cells', r0: 0, c0: 0, r1: records - 1, c1: cols - 1 })
  }
  /** A cell inside a merge stands for the merge's anchor. */
  const anchored = (c: Cell): Cell => {
    const m = mergeAt(c.r, c.c)
    return m ? { r: m.r0, c: m.c0 } : c
  }

  const reveal = (c: Cell): void => {
    const el = scroller.current
    const g = geoRef.current
    if (!el) return
    const top = c.r < g.fr ? null : scrollToRow(c.r - g.fr, el.scrollTop, g.viewH, g.body, g.k, g.bodyOff)
    const left = c.c < g.fc ? null : scrollToCol(g.off, c.c, el.scrollLeft, g.viewW, g.fw)
    if (top !== null) el.scrollTop = top
    if (left !== null) el.scrollLeft = left
    if (top !== null || left !== null) onScroll()
  }

  // Where a pointer is: a row and a column, -1 on a header; clamped into the sheet when it's past an edge.
  const cellAt = (x: number, y: number): { r: number; c: number; head: 'corner' | 'col' | 'row' | null } => {
    const el = scroller.current!
    const b = el.getBoundingClientRect()
    const g = geoRef.current
    const px = Math.max(0, Math.min(el.clientWidth - 1, x - b.left))
    const py = Math.max(0, Math.min(el.clientHeight - 1, y - b.top))
    const c = px < g.rhW ? -1 : Math.min(g.cols - 1, px < g.rhW + g.fw ? colAt(g.off, px - g.rhW) : colAt(g.off, px - g.rhW + g.pos.left))
    const r = py < HEAD_H ? -1 : py < g.bandH ? rowAt(g.bandOff, py - HEAD_H, g.fr) : g.fr + rowAt(g.bodyOff, py - g.bandH + g.rw.v, g.body)
    const rr = r < 0 ? -1 : Math.min(Math.max(0, g.records - 1), r)
    return { r: rr, c, head: r < 0 && c < 0 ? 'corner' : r < 0 ? 'col' : c < 0 ? 'row' : null }
  }

  const drag = useRef<{ shape: A1['shape']; from: Cell; x: number; y: number; raf: number } | null>(null)
  const onMouseDown = (e: ReactMouseEvent): void => {
    const el = scroller.current
    if (e.button !== 0 || !el || !records) return
    const b = el.getBoundingClientRect()
    if (e.clientX - b.left >= el.clientWidth || e.clientY - b.top >= el.clientHeight) return
    e.preventDefault()
    el.focus({ preventScroll: true })
    const at = cellAt(e.clientX, e.clientY)
    if (at.head === 'corner') return usedRange()
    const shape: A1['shape'] = at.head === 'col' ? 'cols' : at.head === 'row' ? 'rows' : 'cells'
    const here = { r: Math.max(0, at.r), c: Math.max(0, at.c) }
    const from = e.shiftKey && anchor.current ? anchor.current : here
    if (!e.shiftKey || !anchor.current) setActive(anchored(here))
    select(from, here, shape)
    drag.current = { shape, from, x: e.clientX, y: e.clientY, raf: 0 }
    const move = (ev: MouseEvent): void => {
      const d = drag.current
      if (!d) return
      d.x = ev.clientX
      d.y = ev.clientY
      const to = cellAt(ev.clientX, ev.clientY)
      select(d.from, { r: Math.max(0, to.r), c: Math.max(0, to.c) }, d.shape)
    }
    // One row or column a frame per 24px past the edge, up to four.
    const tick = (): void => {
      const d = drag.current
      if (!d || !scroller.current) return
      const s = scroller.current
      const r = s.getBoundingClientRect()
      const g = geoRef.current
      const step = (past: number): number => (past > 0 ? Math.min(AUTOSCROLL_MAX, Math.ceil(past / ROW_H)) : 0)
      const dy = step(d.y - r.bottom) - step(r.top + g.bandH - d.y)
      const dx = step(d.x - r.right) - step(r.left + g.rhW + g.fw - d.x)
      if (dy && d.shape !== 'cols') s.scrollTop += (dy * ROW_H) / g.k
      if (dx && d.shape !== 'rows') s.scrollLeft += dx * 64
      if (dx || dy) {
        onScroll()
        move(new MouseEvent('mousemove', { clientX: d.x, clientY: d.y }))
      }
      d.raf = requestAnimationFrame(tick)
    }
    const up = (): void => {
      if (drag.current) cancelAnimationFrame(drag.current.raf)
      drag.current = null
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    drag.current.raf = requestAnimationFrame(tick)
  }
  useEffect(() => () => cancelAnimationFrame(drag.current?.raf ?? 0), [])

  const withValues = xlsx && !!sel && cellCount(sel, Math.max(1, records), cols) <= VALUES_MAX
  // The announcement trails the keys and drags that make a selection.
  const hadSel = useRef(false)
  useEffect(() => {
    if (!sel && !hadSel.current) return
    hadSel.current = !!sel
    const t = (selSay.current = setTimeout(() => say(sel ? selectedSaid(sel, Math.max(1, records), cols, sheetName, withValues) : 'Selection cleared'), ANNOUNCE_MS))
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selRange])

  const copyText = (r: Rect): Promise<string> => (xlsx ? book!.ask('copy', { s: sheetI, ...r }) : src!.ask('copy', r))
  const add = async (): Promise<void> => {
    const s = xlsx ? bookRef.current : curRef.current?.src
    if (!sel || !s || !version?.version || !selRect) return
    clearTimeout(selSay.current)
    setAdding(true)
    const st = await window.clui.statFile(handleId, path).catch(() => null)
    if ((xlsx ? bookRef.current : curRef.current?.src) !== s) return setAdding(false)
    if (!st?.ok || st.revision !== s.revision) {
      setAdding(false)
      clearSel()
      return scheduleLoad()
    }
    const lines = xlsx ? undefined : await src!.ask('lines', { r0: selRect.r0, r1: selRect.r1 })
    const values = withValues ? await copyText(selRect) : undefined
    setAdding(false)
    if ((xlsx ? bookRef.current : curRef.current?.src) !== s) return
    addFromSurface(
      handleId,
      { kind: 'sheet', path, sourceVersion: version.version, ...(sheetName !== undefined ? { sheet: sheetName } : {}), range: a1Of(sel), ...(lines ? { lines } : {}), ...(values !== undefined ? { values } : {}), ...(ods && libre.done ? { converted: { by: libre.done.by } } : {}) },
      say
    )
  }
  const [adding, setAdding] = useState(false)

  const copy = async (): Promise<void> => {
    if (!sel || !live || !selRect) return
    const n = cellCount(sel, Math.max(1, records), cols)
    if (n > COPY_MAX) {
      setNotice('copy')
      return say(COPY_LIMIT)
    }
    const text = await copyText(selRect)
    await navigator.clipboard.writeText(text)
    say(`Copied ${fmt(n)} ${n === 1 ? 'cell' : 'cells'}`)
  }

  // Point: focus the grid and say how to select.
  useLayoutEffect(() => {
    if (!asked || shown.t === 'loading' || !takePoint(tabId)) return
    if (pointing) {
      setPointing(tabId, false)
      clearTimeout(selSay.current)
      return say(POINT_OFF)
    }
    if (shown.t !== 'grid') return
    setPointing(tabId, true)
    scroller.current?.focus({ preventScroll: true })
    say(POINTING_SAID)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, shown.t])
  useEffect(() => () => setPointing(tabId, false), [tabId])

  // A user open focuses the grid once there's one.
  useLayoutEffect(() => {
    if (shown.t !== 'grid' || !scroller.current) return
    if (takeSurfaceFocus(tabId)) scroller.current.focus({ preventScroll: true })
  }, [shown.t, tabId])

  /** One step from row or column `x` along `d`, past hidden ones; null at the sheet's edge. */
  const stepPast = (x: number, d: number, n: number, hidden: Set<number>): number | null => {
    for (let y = x + d; y >= 0 && y < n; y += d) if (!hidden.has(y)) return y
    return null
  }
  const lastShown = (n: number, hidden: Set<number>, d: number): number => {
    let y = d < 0 ? 0 : n - 1
    while (hidden.has(y) && y >= 0 && y < n) y -= d
    return Math.max(0, Math.min(n - 1, y))
  }
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.target !== e.currentTarget || !records) return
    const meta = e.metaKey || e.ctrlKey
    if (meta && !e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      return usedRange()
    }
    if (meta && !e.shiftKey && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      return void copy()
    }
    if (e.key === 'Enter' && !meta && !e.altKey && !e.shiftKey && sel) {
      e.preventDefault()
      return void add()
    }
    if (e.key === 'Escape') {
      if (!sel && !pointing) return
      e.preventDefault()
      if (sel) return writeSel(null)
      setPointing(tabId, false)
      clearTimeout(selSay.current)
      return say(POINT_OFF)
    }
    const dir: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageUp: [-1, 0], PageDown: [1, 0] }
    const d = dir[e.key]
    if (!d || e.altKey) return
    e.preventDefault()
    const at = active ?? topLeft()
    const from = e.shiftKey && sel ? (end.current ?? at) : at
    // The active cell comes back into view before it moves.
    reveal(at)
    // A merge is one cell: a step leaves from its far side.
    const m = mergeAt(from.r, from.c)
    const fromR = m ? (d[0] > 0 ? m.r1 : m.r0) : from.r
    const fromC = m ? (d[1] > 0 ? m.c1 : m.c0) : from.c
    const page = e.key.startsWith('Page') ? Math.max(1, rw.r1 - rw.r0 - 2 * OVER - 1) : 1
    let r = from.r
    let c = from.c
    if (d[0]) {
      r = fromR
      for (let i = 0; i < page; i++) r = stepPast(r, d[0], records, hidR) ?? r
    }
    if (d[1]) c = stepPast(fromC, d[1], cols, hidC) ?? fromC
    if (meta && d[0]) r = lastShown(records, hidR, d[0])
    if (meta && d[1]) c = lastShown(cols, hidC, d[1])
    const to = { r: Math.max(0, Math.min(records - 1, r)), c: Math.max(0, Math.min(cols - 1, c)) }
    reveal(to)
    if (e.shiftKey) {
      if (!active) setActive(at)
      return select(sel ? (anchor.current ?? at) : at, to)
    }
    const next = anchored(to)
    setActive(next)
    if (sel) select(next, next)
    else anchor.current = end.current = next
  }

  // Keyboard focus with nothing active makes the top-left visible cell active, unselected.
  const topLeft = (): Cell => ({ r: Math.min(records - 1, fr + rw.first), c: Math.max(fc, colAt(off, fw + pos.left)) })
  const onFocus = (e: FocusEvent): void => {
    if (e.target !== e.currentTarget) return
    setFocused(true)
    if (!active && records) setActive(anchored(topLeft()))
  }

  // Sheets. Each keeps its scroll, selection and active cell for the life of the tab; the tab saves the active one.
  const places = useRef(new Map<number, { top: number; left: number; range?: string; active: Cell | null }>())
  const highlightSheet = useRef<string | undefined>(undefined)
  highlightSheet.current = highlight?.sheet ?? location?.sheet ?? tab?.selection?.sheet
  const activeRef = useRef(active)
  activeRef.current = active
  // Where the next sheet's geometry lands once it's drawn: its saved place, or the cell the file opens it at.
  const landNext = useRef<{ top: number; left: number } | { cell: Cell } | null>(null)
  const toSheet = async (i: number, quiet = false): Promise<void> => {
    const s = bookRef.current
    if (!s || i === sheetIRef.current || !s.facts.sheets[i]) return
    const el = scroller.current
    places.current.set(sheetIRef.current, { top: el?.scrollTop ?? 0, left: el?.scrollLeft ?? 0, ...(curSelRef.current ? { range: curSelRef.current } : {}), active: activeRef.current })
    sheetIRef.current = i
    setSheetI(i)
    const g = await s.ask('geo', { s: i })
    if (bookRef.current !== s || sheetIRef.current !== i) return
    const back = places.current.get(i)
    const name = s.facts.sheets[i].name
    sheetWanted.current = name
    landNext.current = back ? { top: back.top, left: back.left } : g.top ? { cell: g.top } : { top: 0, left: 0 }
    setGeo(g)
    setWin(null)
    setActive(back?.active ?? null)
    anchor.current = end.current = back?.active ?? null
    own.current = back?.range
    const v = useSession.getState().sessions[handleId]?.surfaces.tabs[tabId]?.viewState
    setView(handleId, tabId, {
      selection: back?.range ? { range: back.range, sheet: name, sourceVersion: s.version } : undefined,
      viewState: { ...(v?.kind === 'sheet' ? v : { topRow: 0, leftCol: 0, rowOffset: 0, colOffset: 0 }), kind: 'sheet', sheet: name }
    })
    if (!quiet) say(`${name}, ${fmt(g.rows)} ${g.rows === 1 ? 'row' : 'rows'}, ${fmt(g.cols)} ${g.cols === 1 ? 'column' : 'columns'}`)
  }
  useLayoutEffect(() => {
    const n = landNext.current
    const el = scroller.current
    if (!n || !el || !geo) return
    landNext.current = null
    if ('cell' in n) return landAt(n.cell)
    el.scrollTop = n.top
    el.scrollLeft = n.left
    onScroll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo, bodyOff])
  // Claude's highlight, Claude's place or an opened chip brings its sheet forward, once each: switching away after
  // isn't undone.
  const brought = useRef(new WeakSet<object>())
  useEffect(() => {
    if (!book) return
    for (const x of [highlight, location, tab?.selection]) {
      if (!x?.sheet || brought.current.has(x)) continue
      brought.current.add(x)
      const i = book.facts.sheets.findIndex((s) => s.name === x.sheet)
      if (i >= 0) void toSheet(i, true)
      return
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, highlight, location, tab?.selection])

  /** Scrolls a cell to the top left of the scrolling panes. */
  const landAt = (c: Cell): void => {
    const el = scroller.current
    if (!el) return
    const g = geoRef.current
    el.scrollTop = Math.max(0, topOf(g.bodyOff, Math.max(c.r, g.fr) - g.fr) / g.k)
    el.scrollLeft = Math.max(0, g.off[Math.max(c.c, g.fc)] - g.fw)
    onScroll()
  }

  // Claude's place: lines become the rows that hold them, then a range scrolls its first cell to the top left.
  const hlHere = !xlsx || highlight?.sheet === undefined || highlight.sheet === sheetName
  const hl = highlight?.range && hlHere ? parseA1(highlight.range) : null
  useEffect(() => {
    const s = src
    const lines = highlight?.lines
    if (xlsx || !s || !lines || highlight?.range || !facts) return
    let alive = true
    void Promise.all([s.ask('record', { line: lines.start }), s.ask('record', { line: lines.end })]).then(([a, b]) => {
      if (!alive || curRef.current?.src !== s || a < 0 || (b < 0 && !facts.done)) return
      const r1 = b < 0 ? records - 1 : b
      setView(handleId, tabId, { highlight: { lines, range: `${a + 1}:${r1 + 1}` }, location: { cell: `A${a + 1}` } })
    })
    return () => {
      alive = false
    }
  }, [xlsx, src, highlight, facts, records, handleId, tabId, setView])
  const landed = useRef<unknown>(null)
  useEffect(() => {
    const cell = location?.cell ? parseA1(location.cell) : null
    const el = scroller.current
    if (!cell || !el || landed.current === location || !records || cell.r0 >= records) return
    if (xlsx && location?.sheet !== undefined && location.sheet !== sheetName) return
    landed.current = location
    landAt({ r: cell.r0, c: cell.c0 })
    setActive(anchored({ r: cell.r0, c: cell.c0 }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, records, off, sheetName])

  // A selection set from outside, a chip opened, comes into view.
  useEffect(() => {
    if (!selRect || selRange === own.current || !records) return
    own.current = selRange
    anchor.current = { r: selRect.r0, c: selRect.c0 }
    end.current = { r: selRect.r1, c: selRect.c1 }
    setActive(anchored({ r: selRect.r0, c: selRect.c0 }))
    reveal({ r: selRect.r0, c: selRect.c0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selRange, records, sheetName])

  // The place it keeps: the top row and left column, and for a CSV Source's line for it, so Source opens there.
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  const saveView = (): void => {
    const g = geoRef.current
    if (!g.records) return
    const topRow = Math.min(g.records - 1, g.fr + g.rw.first)
    const v = useSession.getState().sessions[handleId]?.surfaces.tabs[tabId]?.viewState
    const keep = v?.kind === 'sheet' ? v : undefined
    const leftCol = colAt(g.off, g.fw + g.pos.left)
    setView(handleId, tabId, { viewState: { ...keep, kind: 'sheet', ...(sheetNameRef.current !== undefined ? { sheet: sheetNameRef.current } : {}), topRow, leftCol, rowOffset: 0, colOffset: 0 } })
    const s = curRef.current?.src
    if (xlsx || !s) return
    void s.ask('lines', { r0: topRow, r1: topRow }).then(({ start }) => {
      if (curRef.current?.src === s) setView(handleId, tabId, { sourceView: { kind: 'file', topLine: start, offsetPx: 0, scrollLeft: 0 } })
    })
  }
  const sheetNameRef = useRef(sheetName)
  sheetNameRef.current = sheetName
  // Back where it was: a CSV at the record holding Source's top line, which the grid itself wrote when last shown; a
  // workbook at its saved row and column, or where the file opens.
  const restored = useRef(false)
  useEffect(() => {
    const el = scroller.current
    if (restored.current || !live || !records || !el || !box.h) return
    if (location?.cell || selRange) return void (restored.current = true)
    if (xlsx) {
      restored.current = true
      if (view && view.sheet === sheetName && (view.topRow || view.leftCol)) landAt({ r: view.topRow, c: view.leftCol })
      else if (geo?.top) landAt(geo.top)
      return
    }
    const line = tab?.sourceView?.topLine ?? 1
    if (line <= 1 || !src || !facts) return void (restored.current = true)
    let alive = true
    void src.ask('record', { line }).then((r) => {
      if (!alive) return
      if (r < 0) return void (restored.current = facts.done)
      restored.current = true
      const g = geoRef.current
      el.scrollTop = Math.max(0, ((r - g.fr) * ROW_H) / g.k)
      el.scrollLeft = off[view?.leftCol ?? 0] ?? 0
      onScroll()
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, records, box.h])

  // Read as: the delimiter re-indexes, the header only changes the freeze and weight.
  const announceAs = useRef<Delimiter | null>(null)
  const readWith = (d: Delimiter): void => {
    if (!src || !facts || d === facts.delimiter) return
    announceAs.current = d
    // The re-read's own announcement says the selection went; a trailing "Selection cleared" would talk over it.
    hadSel.current = false
    const v = view ?? { kind: 'sheet' as const, topRow: 0, leftCol: 0, rowOffset: 0, colOffset: 0 }
    const { delimiter: _d, ...rest } = v
    setView(handleId, tabId, { viewState: d === facts.detected.delimiter ? rest : { ...rest, delimiter: d } })
    writeSel(null)
    setFound(null)
    src.delimit(d)
  }
  useEffect(() => {
    if (!facts || announceAs.current !== facts.delimiter) return
    announceAs.current = null
    say(`Read as ${delimiterName(facts.delimiter).toLowerCase()}, ${fmt(facts.cols)} ${facts.cols === 1 ? 'column' : 'columns'}`)
  }, [facts, say])
  const setHeader = (on: boolean): void => {
    if (!facts) return
    const v = view ?? { kind: 'sheet' as const, topRow: 0, leftCol: 0, rowOffset: 0, colOffset: 0 }
    const { header: _h, ...rest } = v
    setView(handleId, tabId, { viewState: on === facts.detected.header ? rest : { ...rest, header: on } })
  }
  const toggleHidden = (): void => {
    const v = view ?? { kind: 'sheet' as const, topRow: 0, leftCol: 0, rowOffset: 0, colOffset: 0 }
    const { showHidden: _s, ...rest } = v
    setView(handleId, tabId, { viewState: showHidden ? rest : { ...rest, showHidden: true } })
  }

  // Find, in the worker. Matches stream in; the count says so while it's still scanning.
  const [findOpen, setFindOpen] = useState(false)
  const [found, setFound] = useState<{ q: string; hits: number[]; done: boolean; more: boolean } | null>(null)
  const [findAt, setFindAt] = useState(0)
  const stepFind = (by: number): void => {
    const n = (found?.hits.length ?? 0) / 2
    if (!n) return
    const i = (findAt + by + n) % n
    setFindAt(i)
    const at = { r: found!.hits[i * 2], c: found!.hits[i * 2 + 1] }
    setActive(at)
    reveal(at)
  }
  const { query, setQuery, deferred, input: findInput } = useFind(findOpen, setFindOpen, () => shown.t === 'grid', stepFind)
  useEffect(() => {
    const s = live
    if (!s || !findOpen || !deferred) {
      s?.stopFind()
      return setFound(null)
    }
    setFindAt(0)
    const acc = { q: deferred, hits: [] as number[], done: false, more: false }
    const onHits = (hits: number[], done: boolean, more: boolean): void => {
      acc.hits = acc.hits.concat(hits)
      setFound({ ...acc, done, more })
    }
    if (xlsx) (s as BookSource).find(sheetI, deferred, FIND_MAX, showHidden, onHits)
    else (s as CsvSource).find(deferred, FIND_MAX, onHits)
    return () => s.stopFind()
  }, [live, xlsx, findOpen, deferred, facts?.delimiter, sheetI, showHidden])
  const marks = useMemo(() => {
    const m = new Set<string>()
    if (!found) return m
    for (let i = 0; i < found.hits.length; i += 2) m.add(`${found.hits[i]},${found.hits[i + 1]}`)
    return m
  }, [found])
  const activeMatch = found && found.hits.length ? `${found.hits[findAt * 2]},${found.hits[findAt * 2 + 1]}` : null
  // The first match comes into view as soon as there is one.
  const firstHit = found?.hits.length ? `${found.q}\0${found.hits[0]},${found.hits[1]}` : ''
  useEffect(() => {
    if (found?.hits.length) reveal({ r: found.hits[0], c: found.hits[1] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstHit])
  const closeFind = (): void => {
    setQuery('')
    setFindOpen(false)
    const at = activeMatch?.split(',').map(Number)
    scroller.current?.focus({ preventScroll: true })
    if (at) {
      const c = { r: at[0], c: at[1] }
      setActive(c)
      select(c, c)
    }
  }

  // The formula bar: the active cell's whole value, read from the worker.
  const [bar, setBar] = useState<Bar | null>(null)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    if (!live || !active) return setBar(null)
    let alive = true
    const at = `${colName(active.c)}${active.r + 1}`
    const got: Promise<CellDetail | null> = xlsx ? book!.ask('cell', { s: sheetI, r: active.r, c: active.c }) : src!.ask('cell', { r: active.r, c: active.c })
    void got.then((v) => {
      if (alive && v) setBar({ at, ...v })
    })
    return () => {
      alive = false
    }
  }, [live, xlsx, book, src, active, sheetI, facts?.delimiter, facts?.encoding])
  const valueEl = useRef<HTMLDivElement | null>(null)
  const [clipped, setClipped] = useState(false)
  useLayoutEffect(() => {
    const el = valueEl.current
    setClipped(!!bar && (bar.value.includes('\n') || (!!el && el.scrollWidth > el.clientWidth)))
  }, [bar, box.w])

  const ink = focused ? 'var(--color-ring)' : 'var(--color-dim)'
  const heads = selRect
  const colHeadOn = (c: number): boolean => !!heads && c >= heads.c0 && c <= heads.c1
  const rowHeadOn = (r: number): boolean => !!heads && r >= heads.r0 && r <= heads.r1
  const inView = (r: number, c: number): boolean => (r < fr || (r - fr >= rw.r0 && r - fr <= rw.r1)) && (c < fc || (c >= c0 && c <= c1))
  const activeVisible = !!active && inView(active.r, active.c)
  // Headers mark where hidden rows or columns are with a line, beside the numbers' skip; shown, a line on each end
  // brackets the run.
  const fileHidR = useMemo(() => new Set(geo?.hiddenRows ?? []), [geo])
  const fileHidC = useMemo(() => new Set(geo?.hiddenCols ?? []), [geo])
  const gapBefore = (n: number, file: Set<number>): boolean => (showHidden ? file.has(n) && !file.has(n - 1) : file.has(n - 1))
  const gapAfter = (n: number, file: Set<number>): boolean => showHidden && file.has(n) && !file.has(n + 1)
  const gapLine = (n: number, file: Set<number>, axis: 'row' | 'col'): CSSProperties | undefined => {
    const [s, e] = axis === 'row' ? ['inset 0 2px 0', 'inset 0 -2px 0'] : ['inset 2px 0 0', 'inset -2px 0 0']
    const lines = [gapBefore(n, file) && s, gapAfter(n, file) && e].filter(Boolean).map((x) => `${x} var(--color-dim)`)
    return lines.length ? { boxShadow: lines.join(', ') } : undefined
  }

  // Merges in the window, by every cell they cover there.
  const covered = useMemo(() => {
    const m = new Map<string, SheetWindow['merges'][number]>()
    for (const x of win?.merges ?? []) for (let r = x.row; r < x.row + x.rows && r <= (win?.r1 ?? 0); r++) for (let c = x.col; c < x.col + x.cols && c <= (win?.c1 ?? 0); c++) m.set(`${r},${c}`, x)
    return m
  }, [win])

  /** The text a cell or merge draws, its alignment, and whether it spills or shows `#`. */
  const content = (cell: SheetCell | undefined, w: number, headRow: boolean, c: number): { node: ReactNode; num: boolean; h: string; tw: number; fits: boolean; nc: boolean; st?: CellStyle } => {
    const v = cell?.value ?? ''
    const st = cell?.styleId !== undefined ? styles?.[cell.styleId] : undefined
    const nc = cell?.valueState === 'not-calculated'
    const num = !!v && !nc && (xlsx ? !!cell?.num : headRow ? !!facts?.numeric?.[c] : isNumber(v))
    const h = st?.h ?? (nc ? 'left' : num ? 'right' : cell?.centre ? 'center' : 'left')
    const tw = v ? textW(oneLine(v), font.current) : 0
    const pad = 12 + (st?.indent ?? 0) * 8
    const fits = tw <= w - pad
    const node = v && !fits && num && !headRow && !st?.wrap ? '#'.repeat(Math.max(1, Math.floor((w - 12) / Math.max(1, textW('#', font.current))))) : st?.wrap ? v : shownText(v)
    return { node, num, h, tw, fits, nc, ...(st ? { st } : {}) }
  }
  const borderCss = (st: CellStyle | undefined, gridlines: boolean): CSSProperties => {
    const bd = st?.bd
    const line = gridlines ? '1px solid var(--color-border)' : undefined
    return { borderRight: bd?.[1] ? BORDER[bd[1] as 1] : line, borderBottom: bd?.[2] ? BORDER[bd[2] as 1] : line }
  }
  /** A file's top and left borders sit on the gridlines its neighbours draw. */
  const nearBorders = (st: CellStyle | undefined): JSX.Element | null =>
    st?.bd && (st.bd[0] || st.bd[3]) ? <span aria-hidden="true" className="pointer-events-none absolute -left-px -top-px bottom-0 right-0" style={{ borderTop: st.bd[0] ? BORDER[st.bd[0] as 1] : undefined, borderLeft: st.bd[3] ? BORDER[st.bd[3] as 1] : undefined }} /> : null
  const gridlines = !xlsx || geo?.gridlines !== false
  const vAlign = (st: CellStyle | undefined): string => (!xlsx ? 'items-center' : st?.v === 'top' ? 'items-start' : st?.v === 'middle' ? 'items-center' : 'items-end')

  const renderCell = (r: number, c: number, hgt: number, headRow: boolean, n: number | undefined, frozenCol: boolean): JSX.Element => {
    const cell = win?.cells.get(`${r},${c}`)
    const m = covered.get(`${r},${c}`)
    const w = off[c + 1] - off[c]
    const left = rhW + off[c]
    const merged = m && (m.rows > 1 || m.cols > 1)
    const key = `${r},${c}`
    if (merged) {
      const a = m.anchor
      const label = `${colName(m.col)}${m.row + 1} to ${colName(m.col + m.cols - 1)}${m.row + m.rows}, merged, ${a?.value ? a.value.replace(/\r?\n/g, ' new line ') : 'empty'}`
      return <div key={c} id={cellId(r, c)} role="gridcell" aria-colindex={c + 2} aria-selected={inRect(r, c, selRect) || undefined} aria-label={label} className="absolute top-0" style={{ left, width: w, height: hgt }} />
    }
    const v = cell?.value ?? ''
    const x = content(cell, w, headRow, c)
    const spillable = !!v && !x.fits && !x.st?.wrap && x.h !== 'center' && x.h !== 'justify' && !(x.num && !headRow)
    let spill: { left: number; width: number } | null = null
    if (spillable) {
      // Text spills over empty neighbours in the drawn window, never across the frozen edge, a merge or a fill, and ends
      // in an ellipsis where it stops.
      const lo = frozenCol ? 0 : Math.max(c0, fc)
      const hi = frozenCol ? fc - 1 : c1
      const free = (k: number): boolean => !valueAt(r, k) && !covered.has(`${r},${k}`) && !(win?.cells.get(`${r},${k}`)?.styleId !== undefined && styles?.[win!.cells.get(`${r},${k}`)!.styleId!]?.fill)
      let a = c
      let b = c
      const room = (): number => off[b + 1] - off[a]
      if (x.h === 'right') while (a - 1 >= lo && free(a - 1) && room() < x.tw + 12) a--
      else while (b + 1 <= hi && free(b + 1) && room() < x.tw + 12) b++
      spill = { left: off[a] - off[c], width: room() }
    }
    const truncated = !!v && !x.fits && (!spill || spill.width < x.tw + 12)
    const markCls = activeMatch === key ? 'bg-content text-bg' : marks.has(key) ? 'bg-border-strong text-content' : ''
    const missing = n !== undefined && c >= n
    const label =
      x.nc ? `${colName(c)}${r + 1}, formula ${v}, not calculated` : `${colName(c)}${r + 1}, ${v ? v.replace(/\r?\n/g, ' new line ') : 'empty'}${cell?.valueState === 'cached-formula' ? ', formula' : ''}`
    const css = markCls ? {} : cssOf(x.st, bg)
    const fillBg = css.background as string | undefined
    const indent = x.st?.indent ? { [x.h === 'right' ? 'paddingRight' : 'paddingLeft']: 6 + x.st.indent * 8 } : {}
    const text = (
      <span
        className={`min-w-0 flex-1 ${x.st?.wrap ? 'max-h-full overflow-hidden whitespace-pre-wrap break-words' : 'truncate'} ${x.h === 'right' ? 'text-right' : x.h === 'center' ? 'text-center' : x.h === 'justify' ? 'text-justify' : ''} ${headRow ? 'font-medium' : ''} ${x.nc ? 'font-mono text-faint' : ''}`}
      >
        {x.node}
      </span>
    )
    return (
      <div
        key={c}
        id={cellId(r, c)}
        role="gridcell"
        aria-colindex={c + 2}
        aria-selected={inRect(r, c, selRect) || undefined}
        aria-label={label}
        data-missing={missing || undefined}
        title={truncated || cell?.long ? v.slice(0, 1000) : undefined}
        className={`absolute top-0 flex px-1.5 ${x.st?.bar ? 'items-start leading-4' : vAlign(x.st)} ${markCls} ${frozenCol && !markCls && !fillBg ? 'bg-bg' : ''}`}
        style={{ left, width: w, height: hgt, ...css, ...borderCss(x.st, gridlines), ...indent }}
      >
        {spill ? (
          <span
            className={`absolute top-0 z-[1] flex h-[calc(100%-1px)] px-1.5 ${vAlign(x.st)} ${markCls || (fillBg ? '' : 'bg-bg')}`}
            style={{ left: spill.left, width: spill.width, ...(fillBg ? { background: `linear-gradient(to ${x.h === 'right' ? 'left' : 'right'}, ${fillBg} ${w}px, var(--color-bg) ${w}px)` } : {}), ...indent }}
          >
            {text}
          </span>
        ) : (
          text
        )}
        {x.st?.bar && <span aria-hidden="true" className="pointer-events-none absolute bottom-0 left-0.5 h-1" style={{ width: Math.max(0, (w - 4) * x.st.bar.f), background: readable(x.st.bar.color, bg, 3) }} />}
        {nearBorders(x.st)}
      </div>
    )
  }

  const renderRow = (r: number, top: number, band: boolean): JSX.Element => {
    const n = win?.fields.get(r)
    const hgt = rowH(r)
    const headRow = band && header
    const frozenCells: JSX.Element[] = []
    for (let c = 0; c < fc; c++) if (off[c + 1] > off[c]) frozenCells.push(renderCell(r, c, hgt, headRow, n, true))
    const cells: JSX.Element[] = []
    for (let c = c0; c <= c1; c++) if (off[c + 1] > off[c]) cells.push(renderCell(r, c, hgt, headRow, n, false))
    return (
      <div key={r} role="row" aria-rowindex={r + 2} className="absolute left-0" style={{ top, height: hgt, width: contentW }}>
        <div className="sticky left-0 z-[3] h-full" style={{ width: rhW + fw }}>
          <div
            role="rowheader"
            aria-colindex={1}
            className={`absolute left-0 top-0 flex h-full items-center justify-end border-b border-r border-border pr-2 text-meta ${rowHeadOn(r) ? 'bg-row-selected font-medium text-content' : 'bg-tool text-faint'}`}
            style={{ width: rhW, ...gapLine(r, fileHidR, 'row') }}
          >
            {r + 1}
          </div>
          {frozenCells}
        </div>
        {cells}
      </div>
    )
  }

  // Marks: one piece per pane of a range, in that pane's layer. A range that runs on past a pane's edge draws no side
  // there, and its outline is drawn again above the frozen edges so the edge never cuts it.
  const bodyY = (r: number): number => topOf(bodyOff, r - fr) - topOf(bodyOff, rw.r0)
  const bandY = (r: number): number => HEAD_H + topOf(bandOff, r)
  const lo = fr + Math.max(0, rw.r0 - 2)
  const hi = Math.min(rows - 1, fr + rw.r1 + 2)
  const piece = (a: Rect | null, band: boolean, frozenCols: boolean): Box | null => {
    if (!a) return null
    const r0 = Math.max(a.r0, band ? 0 : lo)
    const r1 = Math.min(a.r1, band ? fr - 1 : hi)
    const cc0 = Math.max(a.c0, frozenCols ? 0 : fc)
    const cc1 = Math.min(a.c1, frozenCols ? fc - 1 : cols - 1)
    if (r0 > r1 || cc0 > cc1) return null
    const y = band ? bandY : bodyY
    const top = y(r0)
    return {
      top,
      height: y(r1) + rowH(r1) - top,
      left: rhW + off[cc0],
      width: off[cc1 + 1] - off[cc0],
      open: { t: !band && a.r0 < fr, b: band && a.r1 >= fr, l: !frozenCols && a.c0 < fc, r: frozenCols && a.c1 >= fc }
    }
  }
  const clipOf = (p: Box): string => cut(p.open.t ? 0 : -3, p.open.r ? 0 : -3, p.open.b ? 0 : -3, p.open.l ? 0 : -3)
  const ring = (p: Box | null, key?: string, clip?: string): JSX.Element | null =>
    p && (
      <div
        key={key}
        className="pointer-events-none absolute z-[2]"
        style={{ top: p.top, left: p.left, width: p.width, height: p.height, clipPath: clip ?? clipOf(p), boxShadow: `inset 0 0 0 1px var(--color-bg), 0 0 0 2px ${ink}` }}
      />
    )
  const frame = (p: Box | null, ui?: string, clip?: string): JSX.Element | null =>
    p ? <div key={ui ?? 'f'} data-ui={ui} aria-hidden="true" className="pointer-events-none absolute z-[2]" style={{ top: p.top, left: p.left, width: p.width, height: p.height, clipPath: clip ?? 'none', boxShadow: `inset 0 0 0 1px ${ink}` }} /> : null
  const dashed = (p: Box | null, key: string, ui?: string, clip?: string): JSX.Element | null =>
    p ? <div key={key} data-ui={ui} aria-hidden="true" className="pointer-events-none absolute z-[2] border-2 border-dashed border-dim" style={{ top: p.top, left: p.left, width: p.width, height: p.height, clipPath: clip ?? clipOf(p), borderTopWidth: p.open.t ? 0 : undefined, borderRightWidth: p.open.r ? 0 : undefined, borderBottomWidth: p.open.b ? 0 : undefined, borderLeftWidth: p.open.l ? 0 : undefined }} /> : null
  const single = !!selRect && selRect.r0 === selRect.r1 && selRect.c0 === selRect.c1
  const singleMerge = !!selRect && !!active && !!mergeAt(active.r, active.c) && (() => {
    const m = mergeAt(active.r, active.c)!
    return m.r0 === selRect.r0 && m.r1 === selRect.r1 && m.c0 === selRect.c0 && m.c1 === selRect.c1
  })()
  const activeRect: Rect | null = active ? (mergeAt(active.r, active.c) ?? { r0: active.r, r1: active.r, c0: active.c, c1: active.c }) : null
  const hlRect = hl ? clampA1(hl, Math.max(1, records), cols) : null
  const fillPiece = (p: Box | null, hole: Box | null, key: string): JSX.Element | null => {
    if (!p) return null
    const path = hole ? `path(evenodd, 'M0 0H${p.width}V${p.height}H0Z M${hole.left - p.left} ${hole.top - p.top}h${hole.width}v${hole.height}h${-hole.width}Z')` : undefined
    return <div key={key} className="pointer-events-none absolute z-[2]" style={{ top: p.top, left: p.left, width: p.width, height: p.height, background: FILL, clipPath: path }} />
  }
  type Pane = { band: boolean; frozen: boolean }
  const marksOf = ({ band, frozen }: Pane): { sel: Box | null; hl: Box | null; act: Box | null } => {
    const actShown = !!active && activeVisible && !((single || singleMerge) && inRect(active.r, active.c, selRect))
    return { sel: piece(selRect, band, frozen), hl: piece(hlRect, band, frozen), act: actShown ? piece(activeRect, band, frozen) : null }
  }
  const paneMarks = (p: Pane): JSX.Element[] => {
    const m = marksOf(p)
    const hole = activeRect && inRect(activeRect.r0, activeRect.c0, selRect) && !single && !singleMerge ? piece(activeRect, p.band, p.frozen) : null
    return [
      <div key="range" data-ui="sheet-range" aria-hidden="true">
        {!single && !singleMerge && fillPiece(m.sel, hole, 'fill')}
        {ring(m.sel)}
      </div>,
      dashed(m.hl, 'hl', 'sheet-claude'),
      frame(m.act, 'sheet-active')
    ].filter((x): x is JSX.Element => !!x)
  }
  const mergePieces = ({ band, frozen }: Pane): JSX.Element[] =>
    (win?.merges ?? []).flatMap((m) => {
      const a: Rect = { r0: m.row, r1: m.row + m.rows - 1, c0: m.col, c1: m.col + m.cols - 1 }
      if (a.r0 === a.r1 && a.c0 === a.c1) return []
      const p = piece(a, band, frozen)
      if (!p) return []
      const holdsAnchor = inRect(m.row, m.col, { r0: band ? 0 : lo, r1: band ? fr - 1 : hi, c0: frozen ? 0 : fc, c1: frozen ? fc - 1 : cols - 1 })
      const x = content(m.anchor, p.width, false, m.col)
      const key = `${m.row},${m.col}`
      const markCls = activeMatch === key ? 'bg-content text-bg' : marks.has(key) ? 'bg-border-strong text-content' : ''
      const css = markCls ? {} : cssOf(x.st, bg)
      const edge = (id: number | undefined, side: 1 | 2): Border => (id === undefined ? x.st?.bd?.[side] : styles?.[id]?.bd?.[side]) ?? 0
      return [
        <div
          key={`m${m.row},${m.col}`}
          data-ui="sheet-merge"
          aria-hidden="true"
          className={`pointer-events-none absolute z-[1] flex overflow-hidden px-1.5 ${vAlign(x.st)} ${markCls || (css.background ? '' : 'bg-bg')}`}
          style={{ top: p.top, left: p.left, width: p.width, height: p.height, ...css, ...borderCss({ bd: [0, p.open.r ? 0 : edge(m.right, 1), p.open.b ? 0 : edge(m.bottom, 2), 0] }, gridlines) }}
        >
          {holdsAnchor && (
            <span className={`min-w-0 flex-1 ${x.st?.wrap ? 'max-h-full overflow-hidden whitespace-pre-wrap break-words' : 'truncate'} ${x.h === 'right' ? 'text-right' : x.h === 'center' ? 'text-center' : ''} ${x.nc ? 'font-mono text-faint' : ''}`}>{x.node}</span>
          )}
        </div>
      ]
    })

  // The frozen edges: control-edge between two bg keylines, so each holds 3:1 over any fill below it.
  const edgeX = rhW + fw
  /** Outlines again across the column split, in a frozen layer, cut to the edge's three pixels: a scrolling piece moved
   *  to where it shows, its left side only while its first column sits at the split. An open end is pushed past the cut. */
  const acrossX = (p: Box | null, scrolling: boolean): { p: Box; clip: string } | null => {
    if (!p) return null
    const left = (scrolling ? p.left - pos.left : p.left) - (p.open.l ? 4 : 0)
    const width = p.width + (p.open.l ? 4 : 0) + (p.open.r ? 4 : 0)
    const from = scrolling && (p.open.l || left < edgeX) ? edgeX : edgeX - 2
    const l = Math.max(-3, from - left)
    const r = Math.max(-3, left + width - (edgeX + 1))
    if (l + r >= width) return null
    return { p: { ...p, left, width }, clip: cut(p.open.t ? 0 : -3, r, p.open.b ? 0 : -3, l) }
  }
  // Outlines again across the row split, in the band: a body piece moved into band space, its top side only while its
  // first row sits at the split rather than scrolled under the band. An open end is pushed past the cut, or the ring's
  // inner bg keyline would paint across the edge.
  const bodyDy = bandH + topOf(bodyOff, rw.r0) - rw.v
  const acrossY = (p: Box | null, isBody: boolean, frozenCols: boolean): { p: Box; clip: string } | null => {
    if (!p) return null
    const top = (isBody ? p.top + bodyDy : p.top) - (p.open.t ? 4 : 0)
    const height = p.height + (p.open.t ? 4 : 0) + (p.open.b ? 4 : 0)
    const from = isBody && (p.open.t || top < bandH) ? bandH : bandH - 2
    const t = Math.max(-3, from - top)
    const b = Math.max(-3, top + height - (bandH + 1))
    if (t + b >= height) return null
    // The band scrolls sideways with the cells, so a frozen piece shifts by the scroll, and a scrolling one stops at
    // the frozen columns, or crosses the column edge too while its first column sits at the split.
    const left = (frozenCols ? p.left + pos.left : p.left) - (p.open.l ? 4 : 0)
    const width = p.width + (p.open.l ? 4 : 0) + (p.open.r ? 4 : 0)
    const stop = p.open.l || p.left - pos.left < edgeX ? edgeX : edgeX - 2
    const l = !frozenCols && fc ? Math.max(-3, stop + pos.left - left) : -3
    const r = frozenCols && p.open.r ? Math.max(-3, left + width - (edgeX + pos.left)) : -3
    return { p: { ...p, top, height, left, width }, clip: cut(t, r, b, l) }
  }

  const bodyRows: JSX.Element[] = []
  if (win) for (let j = rw.r0; j <= rw.r1; j++) if (fr + j < records && rowPx(fr + j) > 0) bodyRows.push(renderRow(fr + j, topOf(bodyOff, j) - topOf(bodyOff, rw.r0), false))
  const bandRows: JSX.Element[] = []
  if (win) for (let r = 0; r < fr && r < records; r++) if (rowPx(r) > 0) bandRows.push(renderRow(r, bandY(r), true))

  const PANES = { tl: { band: true, frozen: true }, tr: { band: true, frozen: false }, bl: { band: false, frozen: true }, br: { band: false, frozen: false } }
  const outlinesY = fr > 0 && (
    <div data-ui="sheet-edge-outlines" aria-hidden="true" className="pointer-events-none absolute inset-0 z-[6]">
      {(['tl', 'tr', 'bl', 'br'] as const).flatMap((k) => {
        const pane = PANES[k]
        if (pane.frozen && !fc) return []
        const m = marksOf(pane)
        const sel = acrossY(m.sel, !pane.band, pane.frozen)
        const hlx = acrossY(m.hl, !pane.band, pane.frozen)
        const act = acrossY(m.act, !pane.band, pane.frozen)
        return [ring(sel?.p ?? null, `s${k}`, sel?.clip), dashed(hlx?.p ?? null, `h${k}`, undefined, hlx?.clip), act ? frame(act.p, undefined, act.clip) : null].filter(Boolean) as JSX.Element[]
      })}
    </div>
  )
  /** A frozen-columns layer: the pane's merges and marks, the column edge, and the scrolling pane's outlines again on it. */
  const frozenLayer = (band: boolean, height: number): JSX.Element | null => {
    if (!fc) return null
    const outline = (key: string, scrolling: boolean): JSX.Element[] => {
      const m = marksOf({ band, frozen: !scrolling })
      const [s, h, a] = [acrossX(m.sel, scrolling), acrossX(m.hl, scrolling), acrossX(m.act, scrolling)]
      return [ring(s?.p ?? null, `${key}s`, s?.clip), dashed(h?.p ?? null, `${key}h`, undefined, h?.clip), a ? frame(a.p, undefined, a.clip) : null].filter((x): x is JSX.Element => !!x)
    }
    return (
      <div aria-hidden="true" className="pointer-events-none sticky left-0 z-[4]" style={{ width: edgeX + 2, height }}>
        {mergePieces({ band, frozen: true })}
        {paneMarks({ band, frozen: true })}
        <div data-ui="sheet-frozen-edge-col" className="absolute bottom-0 top-0 z-[5] w-0.75 border-x border-bg bg-control-edge" style={{ left: edgeX - 2 }} />
        <div className="absolute inset-0 z-[6]">
          {outline('f', false)}
          {outline('s', true)}
        </div>
      </div>
    )
  }

  const ragged = !!facts && facts.minFields !== facts.cols
  const gaps = xlsx && geo ? sheetGaps(ods ? { ...geo.gaps, uncalculated: 0 } : geo.gaps) : []
  const wbGaps = !xlsx || !book ? [] : ods && odsFlight && libre.done ? odsGaps(libre.done.by, odsFlight.facts) : bookGaps({ ...book.facts, macros: book.facts.macros || /\.xlsm$/i.test(path) })
  const hiddenText = xlsx && geo ? hiddenSaid(geo.hiddenRows.length, geo.hiddenCols.length) : null
  const status = updating ? 'Updating' : xlsx ? (geo ? bookReadout(geo.rows, geo.cols) : '') : !facts ? '' : readout(rows, exact, facts.cols, ragged, facts.encoding)
  const statusTitle = xlsx || !facts ? status : [status, ragged && `Rows have between ${facts.minFields} and ${facts.cols} fields.`, facts.encoding === 'Windows-1252' && "Not valid UTF-8, so it's read as Windows-1252."].filter(Boolean).join(' ')
  const barLabel = sel ? selectedLabel(sel, Math.max(1, records), cols, sheetName, withValues) : ''
  const blocked = version?.refused ? (version.refused === 'too-large' ? `Clui can't reference ${name}: it's larger than 200 MB.` : REASON[version.refused] || `Couldn't read ${name}.`) : undefined
  const total = (found?.hits.length ?? 0) / 2
  const countText = !deferred || !found ? '' : !total ? (found.done ? 'No matches' : '') : found.more ? `${findAt + 1} of 10,000+` : found.done ? `${findAt + 1} of ${fmt(total)}` : `${fmt(total)} so far`

  const openBtn = (
    <button type="button" className={TEXT_BTN} onClick={() => void openDefault(handleId, path)}>
      Open in default app
    </button>
  )
  const state = (head: string, detail: string | null, ...buttons: JSX.Element[]): JSX.Element => (
    <div className={STATE_BODY}>
      <p className="text-ui font-medium text-content">{head}</p>
      {detail && <p className="max-w-[60ch] text-ui text-dim">{detail}</p>}
      {!!buttons.length && <div className="flex gap-1">{buttons}</div>}
    </div>
  )
  const tryAgain = (
    <button key="again" type="button" className={TEXT_BTN} onClick={retry}>
      Try again
    </button>
  )
  let body2: JSX.Element | null = null
  if (shown.t === 'doc') body2 = <DocState handleId={handleId} tabId={tabId} path={path} doc={shown.doc} load={load} reopen={() => (void load(), setWatchGen((n) => n + 1))} />
  else if (shown.t === 'unsupported') body2 = state(`Clui can't show ${name}`, shown.detail, openBtn)
  else if (shown.t === 'empty') body2 = state(`${name} is empty`, null)
  else if (shown.t === 'needs-lo')
    body2 = state(
      `${name} needs LibreOffice to show here`,
      "Clui reads OpenDocument spreadsheets by converting them with LibreOffice, which isn't on this Mac.",
      openBtn,
      <button key="about" type="button" className={TEXT_BTN} onClick={() => void window.clui.openExternal(LIBREOFFICE)}>
        About LibreOffice
      </button>
    )
  else if (shown.t === 'flight') {
    const f = shown.flight
    body2 =
      f.t === 'locked'
        ? state(`${name} is password protected`, "Clui doesn't open encrypted workbooks.", openBtn)
        : f.t === 'too-large'
          ? state(`${name} is too large to convert here`, `It's ${Math.ceil(f.bytes / MB)} MB. Clui converts workbooks up to 100 MB.`, openBtn)
          : f.t === 'unpacks'
            ? state(`${name} is too large to open here`, unpackDetail(f, 'workbooks'), openBtn)
            : state(`Couldn't open ${name}`, "The file is damaged or isn't a valid OpenDocument file.", openBtn)
  } else if (ods && !book && (libre.conv.t === 'failed' || libre.conv.t === 'timeout' || libre.conv.t === 'stopped')) {
    const again = (
      <button key="again" type="button" className={TEXT_BTN} onClick={() => libre.again()}>
        {libre.conv.t === 'stopped' ? 'Convert again' : 'Try again'}
      </button>
    )
    body2 =
      libre.conv.t === 'failed'
        ? state(`Couldn't convert ${name}`, "LibreOffice couldn't convert it. The file may be damaged or use features it can't read.", again, openBtn)
        : libre.conv.t === 'timeout'
          ? state(`${name} took too long to convert`, 'Clui stops a conversion after a minute.', again, openBtn)
          : state(`Stopped converting ${name}.`, null, again, openBtn)
  } else if (ods && !libre.done && libre.shown && (libre.conv.t === 'waiting' || libre.conv.t === 'running'))
    body2 = (
      <div className={STATE_BODY} data-ui="sheet-converting">
        <ConvertingBody name={name} conv={libre.conv} onStop={libre.stop} />
      </div>
    )
  else if (shown.t === 'stopped') body2 = state(`Stopped reading ${name}.`, null, tryAgain, openBtn)
  else if (shown.t === 'failed') {
    const f = shown.failure
    body2 =
      f.t === 'too-many'
        ? state(`${name} is too large to show here`, `It has ${millions(f.cells)} cells. Clui shows workbooks up to ${CELL_CEILING / 1e6} million.`, openBtn)
        : f.t === 'memory'
          ? state(`${name} is too large to show here`, 'Clui ran out of memory reading it.', openBtn)
          : f.t === 'encrypted'
            ? state(`${name} is password protected`, "Clui doesn't open encrypted workbooks.", openBtn)
            : f.t === 'old'
              ? state(`Clui can't show ${name}`, UNSUPPORTED.xls, openBtn)
              : state(`Couldn't open ${name}`, "The workbook is damaged or isn't a valid Excel file.", tryAgain, openBtn)
  } else if (shown.t === 'loading' && xlsx && slow && (!ods || !!libre.done))
    body2 = (
      <div className={STATE_BODY} data-ui="sheet-reading">
        <p className="text-ui font-medium text-content">{`Reading ${name}`}</p>
        <div className="flex items-center gap-2">
          <div role="progressbar" aria-label={`Reading ${name}`} {...(progress !== null ? { 'aria-valuenow': Math.round(progress * 100), 'aria-valuemin': 0, 'aria-valuemax': 100 } : {})} className="h-1 w-40 overflow-hidden bg-border">
            <div className="h-full origin-left bg-content" style={{ transform: `scaleX(${progress ?? 0.3})` }} />
          </div>
          {progress !== null && <span className="text-meta tabular-nums text-dim">{`${Math.round(progress * 100)}%`}</span>}
        </div>
        <button type="button" className={TEXT_BTN} onClick={stopReading}>
          Stop
        </button>
      </div>
    )

  const gridShown = shown.t === 'grid' || (shown.t === 'loading' && !xlsx)
  const grid = shown.t === 'grid'
  const emptySheet = grid && xlsx && !!geo && !geo.rows
  // Lines the index hasn't mapped to rows yet, or past the last record, say so without a mark.
  const hlRows = hl && highlight?.range ? (hl.shape === 'rows' && !xlsx ? (hl.r0 === hl.r1 ? `row ${fmt(hl.r0 + 1)}` : `rows ${highlight.range}`) : qualified(highlight.range, xlsx ? highlight.sheet : undefined)) : null
  const hlLabel = highlight?.lines ? `Claude pointed to ${rangeLines(highlight.lines)}${hlRows ? `, ${hlRows}` : ''}` : hlRows ? `Claude pointed to ${hlRows}` : null
  const findLabel = xlsx && sheetName ? `Find in ${sheetName} of ${name}` : `Find in ${name}`

  return (
    <div ref={root} data-ui="sheet-surface" className="flex h-full min-h-0 flex-col bg-bg pt-(--top-h)">
      {findOpen && grid && (
        <div className="flex h-9 shrink-0 items-center border-b border-border bg-bg px-1">
          <FindField
            ui="sheet-find"
            inputRef={findInput}
            value={query}
            onChange={setQuery}
            onEnter={(shift) => stepFind(shift ? -1 : 1)}
            onClose={closeFind}
            onPrev={() => stepFind(-1)}
            onNext={() => stepFind(1)}
            stepDisabled={!total}
            countText={countText}
            statusText={countText ? (total ? `Match ${countText}` : countText) : ''}
            placeholder="Find in sheet"
            label={findLabel}
          />
        </div>
      )}
      {grid && (
        <div data-ui="sheet-formula" className="@container/fb flex min-h-9 shrink-0 flex-wrap items-start border-b border-border">
          <div className="w-24 shrink-0 truncate border-r border-border px-2 py-2 font-mono text-code text-content">{bar?.at ?? ''}</div>
          {bar ? (
            <>
              <div
                ref={valueEl}
                className={`min-w-0 flex-1 select-text px-2 py-2 font-mono text-code text-content ${expanded ? 'max-h-40 overflow-y-auto whitespace-pre-wrap break-words' : 'truncate'}`}
              >
                {expanded ? bar.value : bar.value.replace(/\r?\n/g, ' ')}
              </div>
              <FormulaNote bar={bar} />
              {(clipped || expanded) && (
                <button
                  type="button"
                  className={`${PANE_BTN} mx-1 my-1 shrink-0`}
                  aria-expanded={expanded}
                  aria-label={expanded ? 'Show less' : `Show all of ${bar.at}`}
                  title={expanded ? 'Show less' : `Show all of ${bar.at}`}
                  onClick={() => setExpanded((x) => !x)}
                >
                  <IconChevron className={`h-4 w-4 ${expanded ? '-rotate-90' : 'rotate-90'}`} />
                </button>
              )}
            </>
          ) : (
            <div className="min-w-0 flex-1 px-2 py-2 text-meta text-faint">Select a cell to see its value and formula.</div>
          )}
        </div>
      )}
      {grid && hlLabel && (
        <div data-ui="sheet-pointed" className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border px-3">
          <PointedRow label={hlLabel}>
            {highlight?.lines && (
              <button type="button" className={TEXT_BTN} onClick={(e) => viewSourceAt(handleId, tabId, highlight.lines!.start, viaOf(e), highlight.lines!.end > highlight.lines!.start ? highlight.lines!.end : undefined)}>
                Show in Source
              </button>
            )}
          </PointedRow>
        </div>
      )}
      {grid && facts?.unclosed !== undefined && (
        <div data-ui="sheet-banner" className={BANNER}>
          {`Row ${fmt(facts.unclosed + 1)} opens a quote that never closes, so the rest of the file is one field.`}
          <button type="button" className={TEXT_BTN} onClick={(e) => viewSourceAt(handleId, tabId, 1, viaOf(e))}>
            Show source
          </button>
        </div>
      )}
      {grid && facts && facts.size > CSV_BYTES_MAX && facts.done && (
        <div data-ui="sheet-banner" className={BANNER}>
          {`Showing the first ${fmt(records)} rows. ${name} is ${fmt(Math.round(facts.size / MB))} MB and Clui reads up to ${CSV_BYTES_MAX / MB} MB of a CSV.`}
          {openBtn}
        </div>
      )}
      {body2}
      {emptySheet && (
        <div className={`${STATE_BODY} min-h-0 flex-1`}>
          <p className="text-ui text-dim">This sheet is empty.</p>
        </div>
      )}
      {gridShown && !emptySheet && (
        <div
          ref={scroller}
          role="grid"
          aria-label={xlsx && sheetName ? `${sheetName}, ${name}` : name}
          aria-readonly="true"
          aria-multiselectable="true"
          aria-busy={shown.t === 'loading' || !win || undefined}
          aria-rowcount={rows + 1}
          aria-colcount={cols + 1}
          aria-activedescendant={active && activeVisible ? cellId(active.r, active.c) : undefined}
          aria-keyshortcuts={KEYS}
          tabIndex={0}
          data-ui="sheet-grid"
          data-beside-header=""
          {...(grid ? { 'data-pane-title': '' } : {})}
          onScroll={onScroll}
          onMouseDown={onMouseDown}
          onKeyDown={onKeyDown}
          onFocus={onFocus}
          onBlur={(e) => e.target === e.currentTarget && setFocused(false)}
          onCopy={(e) => {
            e.preventDefault()
            void copy()
          }}
          className="relative min-h-0 flex-1 select-none overflow-auto font-sans text-label tabular-nums text-content outline-none"
        >
          {shown.t === 'loading' ? (
            slow && <p className="px-4 py-6 text-meta text-dim">{`Loading ${name}`}</p>
          ) : (
            <div className="relative" style={{ width: contentW, height: bandH + space.height }}>
              <div className="sticky top-0 z-20 bg-bg" style={{ height: bandH, width: contentW }}>
                <div role="row" aria-rowindex={1} className="absolute left-0 top-0 h-6" style={{ width: contentW }}>
                  <div className="sticky left-0 z-[3] h-6" style={{ width: rhW + fw }}>
                    <div role="columnheader" aria-colindex={1} aria-label="Select all" className="absolute left-0 top-0 h-6 border-b border-r border-border bg-tool" style={{ width: rhW }} />
                    {Array.from({ length: fc }, (_, c) => colHead(c))}
                  </div>
                  {Array.from({ length: Math.max(0, c1 - c0 + 1) }, (_, i) => colHead(c0 + i))}
                </div>
                {bandRows}
                {mergePieces(PANES.tr)}
                {paneMarks(PANES.tr)}
                {frozenLayer(true, bandH)}
                {fr > 0 && <div data-ui="sheet-frozen-edge" aria-hidden="true" className="pointer-events-none absolute inset-x-0 -bottom-px z-[5] h-0.75 border-y border-bg bg-control-edge" />}
                {outlinesY}
              </div>
              <div className="absolute left-0" style={{ top: blockTop, width: contentW, height: blockH }}>
                {bodyRows}
                {mergePieces(PANES.br)}
                {paneMarks(PANES.br)}
                {frozenLayer(false, blockH)}
              </div>
            </div>
          )}
        </div>
      )}
      {grid && (facts || book) && (
        <div data-ui="sheet-strip" className="flex h-8 shrink-0 items-stretch border-t border-border bg-tool">
          {xlsx && book ? (
            <SheetTabs sheets={book.facts.sheets} active={sheetI} onSelect={(i) => void toSheet(i)} />
          ) : facts ? (
            <div className="flex min-w-0 flex-1 items-center px-1">
              <Menu
                label={`How ${name} is read`}
                align="start"
                placement="up"
                trigger={{
                  className: `${TEXT_BTN} flex items-center gap-1 text-label`,
                  'aria-label': `How ${name} is read: ${readAs(facts.delimiter, header).toLowerCase()}`,
                  'data-ui': 'sheet-read-as'
                }}
                items={[
                  ...DELIMS.map((d) => ({
                    key: d,
                    label: delimiterName(d),
                    type: 'radio' as const,
                    checked: facts.delimiter === d,
                    ...(facts.detected.delimiter === d ? { hint: 'Detected' } : {}),
                    onClick: () => readWith(d)
                  })),
                  {
                    key: 'header',
                    label: 'First row is a header',
                    type: 'checkbox' as const,
                    checked: header,
                    ...(facts.detected.header ? { hint: 'Detected' } : {}),
                    onClick: () => setHeader(!header)
                  }
                ]}
              >
                {readAs(facts.delimiter, header)}
                <IconChevron className="h-3.5 w-3.5 -rotate-90" />
              </Menu>
            </div>
          ) : null}
          <div className="flex shrink-0 items-center gap-1 px-1">
            <span data-ui="sheet-readout" className="truncate px-2 text-meta tabular-nums text-dim" title={statusTitle}>
              {status}
            </span>
            {xlsx && (
              <NotShown
                name={name}
                sheet={gaps}
                book={wbGaps}
                hidden={hiddenText && geo ? { text: hiddenText, shown: showHidden, n: geo.hiddenRows.length + geo.hiddenCols.length } : null}
                onHidden={toggleHidden}
                onOpen={() => void openDefault(handleId, path)}
              />
            )}
          </div>
        </div>
      )}
      {notice && <SelectionNotice notice={notice === 'copy' ? 'cleared' : notice} copy={notice === 'copy' ? { cleared: COPY_LIMIT, removed: COPY_LIMIT } : NOTICE} onDismiss={() => setNotice(null)} />}
      {grid && sel ? (
        <SelectionBar label={barLabel} attached={inTarget} onAdd={() => void add()} busy={adding || (!version && !blocked)} blocked={blocked} onBlocked={() => blocked && say(blocked)} />
      ) : grid && pointing ? (
        <SelectionBar label={SHEET_POINT_HINT} blocked={SHEET_POINT_HINT} onBlocked={() => say(SHEET_POINT_HINT)} attached={false} onAdd={() => {}} />
      ) : null}
      <span data-ui="sheet-live" className="sr-only" aria-live="polite">
        {said}
      </span>
    </div>
  )

  function colHead(c: number): JSX.Element | null {
    if (off[c + 1] <= off[c]) return null
    return (
      <div
        key={c}
        role="columnheader"
        aria-colindex={c + 2}
        className={`absolute top-0 flex h-6 items-center justify-center border-b border-r border-border text-meta ${colHeadOn(c) ? 'bg-row-selected font-medium text-content' : 'bg-tool text-faint'}`}
        style={{ left: rhW + off[c], width: off[c + 1] - off[c], ...gapLine(c, fileHidC, 'col') }}
      >
        {colName(c)}
      </div>
    )
  }
}

const rangeLines = ({ start, end }: { start: number; end: number }): string => (end > start ? `lines ${fmt(start)} to ${fmt(end)}` : `line ${fmt(start)}`)

/** What the value doesn't say: an empty field, a field the record doesn't have, a value cut at 64 KB, a workbook
 *  number's display text, a formula's saved result or its lack of one, a link, a merge. */
function FormulaNote({ bar }: { bar: Bar }): JSX.Element | null {
  const col = bar.at.match(/^[A-Z]+/)?.[0] ?? 'A'
  const row = Number(bar.at.slice(col.length))
  const parts: { text: string; title?: string }[] = []
  if (bar.long) parts.push({ text: `Showing the first ${CELL_FULL_MAX / 1024} KB of this cell.` })
  else if (bar.state === 'not-calculated') parts.push({ text: 'Not calculated', title: UNCALC_TITLE })
  else if (bar.state === 'cached-formula') parts.push({ text: `Saved result: ${bar.shown ?? ''}`, title: SAVED_TITLE })
  else if (bar.shown !== undefined) parts.push({ text: `Shown as ${bar.shown}` })
  else if (bar.link) parts.push({ text: `Link: ${bar.link}` })
  else if (!bar.value) parts.push({ text: bar.fields !== undefined && colIndex(col) >= bar.fields ? `No field here. Row ${fmt(row)} has ${fmt(bar.fields)} ${bar.fields === 1 ? 'field' : 'fields'}.` : 'Empty' })
  if (bar.merged) parts.push({ text: `Merged ${bar.merged}` })
  if (!parts.length) return null
  return (
    <div className="flex min-w-0 shrink-0 gap-2 px-2 py-2 text-meta text-dim @max-[360px]/fb:basis-full @max-[360px]/fb:pt-0">
      {parts.map((p, i) => (
        <Fragment key={p.text}>
          {i > 0 && <span aria-hidden="true">·</span>}
          <span title={p.title} className={p.text.startsWith('Link:') ? 'max-w-[40ch] truncate' : undefined}>
            {p.text}
          </span>
        </Fragment>
      ))}
    </div>
  )
}

const refusal = (r: Refusal): Shown => ({ t: 'doc', doc: r.reason === 'missing' ? { t: 'missing' } : { t: 'error', reason: r.reason, message: REASON[r.reason] } })
