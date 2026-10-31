import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { refsOf, useActive, useSession } from '../../store'
import type { DraftReference, SourceVersion } from '../../../../shared/context'
import type { Refusal } from '../../../../shared/files'
import { a1Of, CELL_FULL_MAX, clampA1, colIndex, colName, COPY_MAX, CSV_BYTES_MAX, isDelimited, parseA1, type A1, type SheetCell, type SheetWindow } from '../../../../shared/sheets'
import type { Delimiter } from '../../../../shared/surfaces'
import { FindField } from '../FindField'
import { IconChevron } from '../Icon'
import { Menu } from '../Menu'
import { PointedRow } from '../Markdown'
import { addFromSurface } from '../ContextChips'
import { PANE_BTN } from './PaneHeader'
import { ANNOUNCE_MS, SelectionBar } from './SelectionBar'
import { BANNER, baseOf, DocState, FIND_MAX, openDefault, REASON, SelectionNotice, setStatus, SKELETON_MS, STATE_BODY, TEXT_BTN, useFind, VIEW_SETTLE_MS, viewSourceAt, type Doc } from './fileDoc'
import { isNumber, oneLine, type CsvFacts } from '../../lib/csv'
import { openCsv, type CsvSource } from '../../lib/csvSource'
import { cellCount, colAt, colRange, delimiterName, fmt, offsetsOf, readAs, readout, ROW_H, rowHeaderW, rowWindow, scrollSpace, scrollToCol, scrollToRow, selectedLabel, selectedSaid } from '../../lib/sheetView'
import { useSay } from '../../lib/useSay'
import { viaOf } from '../../lib/motion'
import { noteRead } from '../../lib/blockedFiles'
import { POINT_OFF, SHEET_POINT_HINT } from '../../lib/refCopy'
import { setPointing, takePoint, takeSurfaceFocus, usePointing, usePointRequest } from '../../lib/surfaceFocus'

const HEAD_H = 24
const cut = (top: number, bottom: number): string => `inset(${top}px -3px ${bottom}px -3px)`
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

type Shown = { t: 'loading' } | { t: 'grid' } | { t: 'empty' } | { t: 'unsupported'; detail: string } | { t: 'doc'; doc: Doc }
type Cell = { r: number; c: number }
/** One open of the file: its worker and what it has indexed. */
type Load = { src: CsvSource | null; facts: CsvFacts | null }
type Win = { src: CsvSource; key: string; r0: number; r1: number; c0: number; c1: number; records: number; cells: Map<string, SheetCell>; fields: Map<number, number> }

const UNSUPPORTED: Record<string, string> = {
  xls: "It's an older Excel workbook (.xls). Clui shows .xlsx, .xlsm, .csv and .tsv files.",
  xlsb: "It's a binary Excel workbook (.xlsb). Clui shows .xlsx, .xlsm, .csv and .tsv files.",
  ods: "Clui doesn't show OpenDocument spreadsheets."
}

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

const inRect = (r: number, c: number, a: { r0: number; r1: number; c0: number; c1: number } | null): boolean => !!a && r >= a.r0 && r <= a.r1 && c >= a.c0 && c <= a.c1

/**
 * A CSV or TSV as a grid: column letters and row numbers, a formula bar for the cell you're on, a range selection that
 * becomes a `sheet` reference, and find. The file is indexed off the main thread; the grid draws only the rows and
 * columns in view and asks the worker for their cells.
 */
export function SheetSurface({ handleId, tabId }: { handleId: string; tabId: string }): JSX.Element {
  const tab = useActive((s) => s?.surfaces.tabs[tabId])
  const path = tab?.key ?? ''
  const name = baseOf(path)
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
  const [updating, setUpdating] = useState(false)
  const [version, setVersion] = useState<{ revision: string; version?: SourceVersion; refused?: Refusal['reason'] } | null>(null)
  const [notice, setNotice] = useState<'cleared' | 'removed' | 'copy' | null>(null)
  const curRef = useRef<Load | null>(null)
  const pending = useRef<Load | null>(null)
  const loadGen = useRef(0)
  const src = cur?.src ?? null
  const scroller = useRef<HTMLDivElement | null>(null)
  const font = useRef('')

  const records = facts?.records ?? 0
  const cols = Math.max(1, facts?.cols ?? 1)
  const header = !!facts && (view?.header ?? facts.detected.header)
  const frozen = header && records > 0 ? 1 : 0
  // An estimate until the index is done, so the scrollbar doesn't race the read.
  const rows = !facts ? 0 : facts.done || !facts.bytes ? records : Math.max(records, Math.round((records * facts.total) / facts.bytes))
  const exact = !!facts?.done

  const settle = (next: Shown): void => {
    setStatus(owner, next.t === 'loading' ? 'loading' : next.t === 'doc' ? next.doc.t : next.t === 'grid' ? 'binary' : 'error')
    setShown(next)
  }

  // Selection state lives on the tab as A1; the anchor and active cell are this view's.
  const sel = useMemo(() => (selRange ? parseA1(selRange) : null), [selRange])
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
      setView(handleId, tabId, { selection: a ? { range: a1Of(a), ...(version?.version ? { sourceVersion: version.version } : {}) } : undefined, highlight: undefined })
    },
    [handleId, tabId, setView, version]
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
  const isThis = ({ ref: r }: DraftReference): boolean => r.kind === 'sheet' && r.path === path && r.range === selRange && r.sourceVersion === version?.version
  const attached = useActive((s) => !!s && !!selRange && [s.contextRefs, ...s.queuedMessages.map((q) => q.refs)].some((l) => l.some(isThis)))
  const inTarget = useActive((s) => !!s && !!selRange && !!refsOf(s, s.referenceEditTarget)?.some(isThis))
  const attachedRef = useRef(attached)
  attachedRef.current = attached

  // Reads and re-reads. A re-read keeps the old grid until the new revision's first window can paint.
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

  const load = useCallback(async (): Promise<void> => {
    const gen = ++loadGen.current
    lastLoad.current = Date.now()
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
    // The `font` shorthand reads back empty once tabular-nums is set, so it's built from its parts.
    const cs = scroller.current && getComputedStyle(scroller.current)
    font.current = cs ? `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}` : ''
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
      clearTimeout(selSay.current)
      clearTimeout(saveTimer.current)
      setStatus(owner, null)
    },
    [owner]
  )

  // Watched while shown; focus reconciles, since watch events are hints.
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

  // The version a reference records: main hashes the bytes of the revision this grid read, once it's all in.
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

  const [box, setBox] = useState({ w: 0, h: 0 })
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const off = useMemo(() => offsetsOf(facts?.widths, cols), [facts?.widths, cols])
  const rhW = rowHeaderW(rows)
  const bandH = HEAD_H + frozen * ROW_H
  const body = Math.max(0, rows - frozen)
  const viewH = Math.max(0, box.h - bandH)
  const viewW = Math.max(0, box.w - rhW)
  const space = scrollSpace(body, viewH)
  const rw = rowWindow(pos.top, viewH, body, space.k, OVER)
  const [c0, c1] = colRange(off, pos.left, viewW, OVER)
  const blockTop = pos.top + bandH + rw.r0 * ROW_H - rw.v
  const contentW = rhW + off[cols]

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
  const geo = useRef({ rw, bandH, frozen, rhW, off, k: space.k, body, viewH, viewW, records, cols, pos })
  geo.current = { rw, bandH, frozen, rhW, off, k: space.k, body, viewH, viewW, records, cols, pos }

  // The window of cells: fetched with a margin, one request at a time, refetched as the index grows into it.
  const [win, setWin] = useState<Win | null>(null)
  const contentKey = `${facts?.delimiter}\0${facts?.encoding}\0${facts?.done}`
  const fetching = useRef(false)
  const wantR0 = frozen + rw.r0
  const wantR1 = Math.min(records - 1, frozen + rw.r1)
  useEffect(() => {
    if (!src || !records || fetching.current) return
    const w = win
    const fresh = !!w && w.src === src && w.key === contentKey && !(w.r1 >= w.records - 1 && records > w.records)
    if (fresh && w.r0 <= wantR0 && w.r1 >= wantR1 && w.c0 <= c0 && w.c1 >= c1) return
    const r0 = Math.max(0, wantR0 - MARGIN_ROWS)
    const r1 = Math.min(records - 1, wantR1 + MARGIN_ROWS)
    const a = Math.max(0, c0 - MARGIN_COLS)
    const b = Math.min(cols - 1, c1 + MARGIN_COLS)
    fetching.current = true
    const at = { records, key: contentKey }
    void src.ask('window', { r0, r1, c0: a, c1: b, pin: frozen ? [0] : [] }).then((res: SheetWindow) => {
      fetching.current = false
      if (curRef.current?.src !== src) return
      const cells = new Map<string, SheetCell>()
      for (const c of res.cells) cells.set(`${c.row},${c.col}`, c)
      const fields = new Map<number, number>()
      res.fields?.forEach((n, i) => fields.set(r0 + i, n))
      setWin({ src, key: at.key, r0, r1, c0: a, c1: b, records: at.records, cells, fields })
    })
  }, [src, records, contentKey, wantR0, wantR1, c0, c1, cols, frozen, win])

  const valueAt = (r: number, c: number): string => (win?.cells.get(`${r},${c}`)?.value ?? '')
  const cellId = (r: number, c: number): string => `${gridId}-r${r}c${c}`

  const select = (a: Cell, f: Cell, shape: A1['shape'] = 'cells'): void => {
    anchor.current = a
    end.current = f
    const r = { r0: Math.min(a.r, f.r), r1: Math.max(a.r, f.r), c0: Math.min(a.c, f.c), c1: Math.max(a.c, f.c) }
    writeSel(shape === 'rows' ? { ...r, shape, c0: 0, c1: Infinity } : shape === 'cols' ? { ...r, shape, r0: 0, r1: Infinity } : { ...r, shape })
  }
  const usedRange = (): void => {
    if (!records) return
    anchor.current = { r: 0, c: 0 }
    setActive({ r: 0, c: 0 })
    writeSel({ shape: 'cells', r0: 0, c0: 0, r1: records - 1, c1: cols - 1 })
  }

  const reveal = (c: Cell): void => {
    const el = scroller.current
    const g = geo.current
    if (!el) return
    const top = c.r < g.frozen ? null : scrollToRow(c.r - g.frozen, el.scrollTop, g.viewH, g.body, g.k)
    const left = scrollToCol(g.off, c.c, el.scrollLeft, g.viewW)
    if (top !== null) el.scrollTop = top
    if (left !== null) el.scrollLeft = left
    if (top !== null || left !== null) onScroll()
  }

  // Where a pointer is: a record and a column, -1 on a header; clamped into the sheet when it's past an edge.
  const cellAt = (x: number, y: number): { r: number; c: number; head: 'corner' | 'col' | 'row' | null } => {
    const el = scroller.current!
    const b = el.getBoundingClientRect()
    const g = geo.current
    const px = Math.max(0, Math.min(el.clientWidth - 1, x - b.left))
    const py = Math.max(0, Math.min(el.clientHeight - 1, y - b.top))
    const c = px < g.rhW ? -1 : Math.min(g.cols - 1, colAt(g.off, px - g.rhW + g.pos.left))
    const r = py < HEAD_H ? -1 : py < g.bandH ? Math.floor((py - HEAD_H) / ROW_H) : g.frozen + Math.floor((py - g.bandH + g.rw.v) / ROW_H)
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
    if (!e.shiftKey || !anchor.current) setActive(here)
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
      const g = geo.current
      const step = (past: number): number => (past > 0 ? Math.min(AUTOSCROLL_MAX, Math.ceil(past / ROW_H)) : 0)
      const dy = step(d.y - r.bottom) - step(r.top + g.bandH - d.y)
      const dx = step(d.x - r.right) - step(r.left + g.rhW - d.x)
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

  // The announcement trails the keys and drags that make a selection.
  const hadSel = useRef(false)
  useEffect(() => {
    if (!sel && !hadSel.current) return
    hadSel.current = !!sel
    const t = (selSay.current = setTimeout(() => say(sel ? selectedSaid(sel, Math.max(1, records), cols) : 'Selection cleared'), ANNOUNCE_MS))
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selRange])

  const add = async (): Promise<void> => {
    const s = curRef.current?.src
    if (!sel || !s || !version?.version || !selRect) return
    clearTimeout(selSay.current)
    setAdding(true)
    const st = await window.clui.statFile(handleId, path).catch(() => null)
    if (curRef.current?.src !== s) return setAdding(false)
    if (!st?.ok || st.revision !== s.revision) {
      setAdding(false)
      clearSel()
      return scheduleLoad()
    }
    const lines = await s.ask('lines', { r0: selRect.r0, r1: selRect.r1 })
    setAdding(false)
    if (curRef.current?.src !== s) return
    addFromSurface(handleId, { kind: 'sheet', path, sourceVersion: version.version, range: a1Of(sel), lines }, say)
  }
  const [adding, setAdding] = useState(false)

  const copy = async (): Promise<void> => {
    const s = curRef.current?.src
    if (!sel || !s || !selRect) return
    const n = cellCount(sel, Math.max(1, records), cols)
    if (n > COPY_MAX) {
      setNotice('copy')
      return say(COPY_LIMIT)
    }
    const text = await s.ask('copy', selRect)
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
    const page = e.key.startsWith('Page') ? Math.max(1, Math.floor(viewH / ROW_H) - 1) : 1
    let r = from.r + d[0] * page
    let c = from.c + d[1]
    if (meta && d[0]) r = d[0] < 0 ? 0 : records - 1
    if (meta && d[1]) c = d[1] < 0 ? 0 : cols - 1
    const to = { r: Math.max(0, Math.min(records - 1, r)), c: Math.max(0, Math.min(cols - 1, c)) }
    reveal(to)
    if (e.shiftKey) {
      if (!active) setActive(at)
      return select(sel ? (anchor.current ?? at) : at, to)
    }
    setActive(to)
    if (sel) select(to, to)
    else anchor.current = end.current = to
  }

  // Keyboard focus with nothing active makes the top-left visible cell active, unselected.
  const topLeft = (): Cell => ({ r: Math.min(records - 1, frozen + rw.first), c: colAt(off, pos.left) })
  const onFocus = (e: FocusEvent): void => {
    if (e.target !== e.currentTarget) return
    setFocused(true)
    if (!active && records) setActive(topLeft())
  }

  // Claude's place: lines become the rows that hold them, then a range scrolls its first cell to the top left.
  const hl = highlight?.range ? parseA1(highlight.range) : null
  useEffect(() => {
    const s = src
    const lines = highlight?.lines
    if (!s || !lines || highlight?.range || !facts) return
    let live = true
    void Promise.all([s.ask('record', { line: lines.start }), s.ask('record', { line: lines.end })]).then(([a, b]) => {
      if (!live || curRef.current?.src !== s || a < 0 || (b < 0 && !facts.done)) return
      const r1 = b < 0 ? records - 1 : b
      setView(handleId, tabId, { highlight: { lines, range: `${a + 1}:${r1 + 1}` }, location: { cell: `A${a + 1}` } })
    })
    return () => {
      live = false
    }
  }, [src, highlight, facts, records, handleId, tabId, setView])
  const landed = useRef<unknown>(null)
  useEffect(() => {
    const cell = location?.cell ? parseA1(location.cell) : null
    const el = scroller.current
    if (!cell || !el || landed.current === location || !records || cell.r0 >= records) return
    landed.current = location
    const g = geo.current
    const r = Math.max(cell.r0, g.frozen)
    el.scrollTop = Math.max(0, ((r - g.frozen) * ROW_H) / g.k)
    el.scrollLeft = off[cell.c0] ?? 0
    onScroll()
    setActive({ r: cell.r0, c: cell.c0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location, records, off])

  // A selection set from outside, a chip opened, comes into view.
  useEffect(() => {
    if (!selRect || selRange === own.current || !records) return
    own.current = selRange
    anchor.current = { r: selRect.r0, c: selRect.c0 }
    end.current = { r: selRect.r1, c: selRect.c1 }
    setActive({ r: selRect.r0, c: selRect.c0 })
    reveal({ r: selRect.r0, c: selRect.c0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selRange, records])

  // The place it keeps: the top record, and Source's line for it, so Source opens where the grid was.
  const saveTimer = useRef<ReturnType<typeof setTimeout>>()
  const saveView = (): void => {
    const s = curRef.current?.src
    const g = geo.current
    if (!s || !g.records) return
    const topRow = Math.min(g.records - 1, g.frozen + g.rw.first)
    const v = useSession.getState().sessions[handleId]?.surfaces.tabs[tabId]?.viewState
    const keep = v?.kind === 'sheet' ? v : undefined
    setView(handleId, tabId, { viewState: { ...keep, kind: 'sheet', topRow, leftCol: colAt(g.off, g.pos.left), rowOffset: 0, colOffset: 0 } })
    void s.ask('lines', { r0: topRow, r1: topRow }).then(({ start }) => {
      if (curRef.current?.src === s) setView(handleId, tabId, { sourceView: { kind: 'file', topLine: start, offsetPx: 0, scrollLeft: 0 } })
    })
  }
  // Back at the record holding Source's top line, which the grid itself wrote when it was last shown.
  const restored = useRef(false)
  useEffect(() => {
    const el = scroller.current
    const line = tab?.sourceView?.topLine ?? 1
    if (restored.current || !src || !facts?.records || !el || !box.h) return
    if (location?.cell || selRange || line <= 1) return void (restored.current = true)
    let live = true
    void src.ask('record', { line }).then((r) => {
      if (!live) return
      if (r < 0) return void (restored.current = facts.done)
      restored.current = true
      const g = geo.current
      el.scrollTop = Math.max(0, ((r - g.frozen) * ROW_H) / g.k)
      el.scrollLeft = off[view?.leftCol ?? 0] ?? 0
      onScroll()
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, facts?.records, box.h])

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

  // Find, over the index in the worker. Matches stream in; the count says so while it's still scanning.
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
    const s = src
    if (!s || !findOpen || !deferred) {
      s?.stopFind()
      return setFound(null)
    }
    setFindAt(0)
    const acc = { q: deferred, hits: [] as number[], done: false, more: false }
    s.find(deferred, FIND_MAX, (hits, done, more) => {
      acc.hits = acc.hits.concat(hits)
      setFound({ ...acc, done, more })
    })
    return () => s.stopFind()
  }, [src, findOpen, deferred, facts?.delimiter])
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
  const [bar, setBar] = useState<{ at: string; value: string; long: boolean; fields: number } | null>(null)
  const [expanded, setExpanded] = useState(false)
  useEffect(() => {
    const s = src
    if (!s || !active) return setBar(null)
    let live = true
    const at = `${colName(active.c)}${active.r + 1}`
    void s.ask('cell', { r: active.r, c: active.c }).then((v) => {
      if (live) setBar({ at, ...v })
    })
    return () => {
      live = false
    }
  }, [src, active, facts?.delimiter, facts?.encoding])
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
  const activeVisible = !!active && (active.r < frozen || (active.r - frozen >= rw.r0 && active.r - frozen <= rw.r1)) && active.c >= c0 && active.c <= c1

  const renderRow = (r: number, top: number, frozenRow: boolean): JSX.Element => {
    const n = win?.fields.get(r)
    const cells: JSX.Element[] = []
    const headRow = frozenRow && header
    for (let c = c0; c <= c1; c++) {
      const cell = win?.cells.get(`${r},${c}`)
      const v = cell?.value ?? ''
      const w = off[c + 1] - off[c]
      const num = !!v && (headRow ? !!facts?.numeric?.[c] : isNumber(v))
      const line = oneLine(v)
      const tw = v ? textW(line, font.current) : 0
      const fits = tw <= w - 12
      let spill: { left: number; width: number } | null = null
      let shownV: ReactNode = shownText(v)
      if (v && !fits && num && !headRow) shownV = '#'.repeat(Math.max(1, Math.floor((w - 12) / Math.max(1, textW('#', font.current)))))
      else if (v && !fits) {
        // Text spills over empty neighbours in the drawn window, and ends in an ellipsis where it stops.
        let a = c
        let b = c
        const room = (): number => off[b + 1] - off[a]
        if (num) while (a - 1 >= c0 && !valueAt(r, a - 1) && room() < tw + 12) a--
        else while (b + 1 <= c1 && !valueAt(r, b + 1) && room() < tw + 12) b++
        spill = { left: off[a] - off[c], width: room() }
      }
      const truncated = !!v && !fits && (!spill || spill.width < tw + 12)
      const marked = marks.has(`${r},${c}`)
      const markCls = activeMatch === `${r},${c}` ? 'bg-content text-bg' : marked ? 'bg-border-strong text-content' : ''
      const missing = n !== undefined && c >= n
      const label = `${colName(c)}${r + 1}, ${v ? v.replace(/\r?\n/g, ' new line ') : 'empty'}`
      const text = (
        <span className={`min-w-0 flex-1 truncate ${num ? 'text-right' : ''} ${headRow ? 'font-medium' : ''}`}>{shownV}</span>
      )
      cells.push(
        <div
          key={c}
          id={cellId(r, c)}
          role="gridcell"
          aria-colindex={c + 2}
          aria-selected={inRect(r, c, selRect) || undefined}
          aria-label={label}
          data-missing={missing || undefined}
          title={truncated || cell?.long ? v.slice(0, 1000) : undefined}
          className={`absolute top-0 flex h-6 items-center border-b border-r border-border px-1.5 ${markCls}`}
          style={{ left: rhW + off[c], width: w }}
        >
          {spill ? (
            <span
              className={`absolute top-0 z-[1] flex h-[calc(100%-1px)] items-center px-1.5 ${markCls || 'bg-bg'}`}
              style={{ left: spill.left, width: spill.width }}
            >
              {text}
            </span>
          ) : (
            text
          )}
        </div>
      )
    }
    return (
      <div key={r} role="row" aria-rowindex={r + 2} className="absolute left-0 h-6" style={{ top, width: contentW }}>
        <div
          role="rowheader"
          aria-colindex={1}
          className={`sticky left-0 z-[3] flex h-6 items-center justify-end border-b border-r border-border pr-2 text-meta ${rowHeadOn(r) ? 'bg-row-selected font-medium text-content' : 'bg-tool text-faint'}`}
          style={{ width: rhW }}
        >
          {r + 1}
        </div>
        {cells}
      </div>
    )
  }

  /** A range's rectangle inside one pane, its records `lo` to `hi`; `y` maps a record to the pane's top offset. */
  const piece = (a: { r0: number; r1: number; c0: number; c1: number }, lo: number, hi: number, y: (r: number) => number, open: { top: boolean; bottom: boolean }) => {
    const r0 = Math.max(a.r0, lo)
    const r1 = Math.min(a.r1, hi)
    if (r0 > r1) return null
    const top = y(r0)
    const height = y(r1) + ROW_H - top
    const left = rhW + off[Math.max(0, a.c0)]
    const width = off[Math.min(cols, a.c1 + 1)] - off[Math.max(0, a.c0)]
    // A range that runs on past this pane's edge draws no edge there.
    return { top, height, left, width, open, clip: cut(open.top ? 0 : -3, open.bottom ? 0 : -3) }
  }
  type Box = NonNullable<ReturnType<typeof piece>>
  const ring = (p: Box | null, key?: string): JSX.Element | null =>
    p && (
      <div
        key={key}
        className="pointer-events-none absolute z-[2]"
        style={{ top: p.top, left: p.left, width: p.width, height: p.height, clipPath: p.clip, boxShadow: `inset 0 0 0 1px var(--color-bg), 0 0 0 2px ${ink}` }}
      />
    )
  const drawRange = (key: string, p: ReturnType<typeof piece>, holeAt: Cell | null, y: (r: number) => number, single: boolean): JSX.Element | null => {
    if (!p) return null
    const hole = holeAt && !single ? { x: off[holeAt.c] + rhW - p.left, y: y(holeAt.r) - p.top, w: off[holeAt.c + 1] - off[holeAt.c] } : null
    const fill = hole
      ? `path(evenodd, 'M0 0H${p.width}V${p.height}H0Z M${hole.x} ${hole.y}h${hole.w}v${ROW_H}h${-hole.w}Z')`
      : undefined
    return (
      <div key={key} data-ui="sheet-range" aria-hidden="true">
        {!single && <div className="pointer-events-none absolute z-[2]" style={{ top: p.top, left: p.left, width: p.width, height: p.height, background: FILL, clipPath: fill }} />}
        {ring(p)}
      </div>
    )
  }
  const single = !!selRect && selRect.r0 === selRect.r1 && selRect.c0 === selRect.c1
  const bodyY = (r: number): number => (r - frozen - rw.r0) * ROW_H
  const bandY = (r: number): number => HEAD_H + r * ROW_H
  const lo = frozen + Math.max(0, rw.r0 - 2)
  const hi = frozen + rw.r1 + 2
  const holeBody = active && active.r >= frozen && inRect(active.r, active.c, selRect) ? active : null
  const holeBand = active && active.r < frozen && inRect(active.r, active.c, selRect) ? active : null
  const hlRect = hl ? clampA1(hl, Math.max(1, records), cols) : null
  const activeBox = (y: number): Box | null =>
    active && activeVisible && !(single && inRect(active.r, active.c, selRect))
      ? { top: y, left: rhW + off[active.c], width: off[active.c + 1] - off[active.c], height: ROW_H, open: { top: false, bottom: false }, clip: 'none' }
      : null
  const frame = (p: Box | null, ui?: string): JSX.Element | null =>
    p ? <div data-ui={ui} aria-hidden="true" className="pointer-events-none absolute z-[2]" style={{ top: p.top, left: p.left, width: p.width, height: p.height, clipPath: p.clip, boxShadow: `inset 0 0 0 1px ${ink}` }} /> : null
  const dashed = (p: Box | null, key: string, ui?: string): JSX.Element | null =>
    p ? <div key={key} data-ui={ui} aria-hidden="true" className="pointer-events-none absolute z-[2] border-2 border-dashed border-dim" style={{ top: p.top, left: p.left, width: p.width, height: p.height, clipPath: p.clip }} /> : null
  const selBand = selRect && selRect.r0 < frozen ? piece(selRect, 0, frozen - 1, bandY, { top: false, bottom: selRect.r1 >= frozen }) : null
  const selBody = selRect && selRect.r1 >= frozen ? piece(selRect, lo, hi, bodyY, { top: selRect.r0 < frozen, bottom: false }) : null
  const hlBand = hlRect && hlRect.r0 < frozen ? piece(hlRect, 0, frozen - 1, bandY, { top: false, bottom: hlRect.r1 >= frozen }) : null
  const hlBody = hlRect && hlRect.r1 >= frozen ? piece(hlRect, lo, hi, bodyY, { top: hlRect.r0 < frozen, bottom: false }) : null
  const actBand = active && active.r < frozen ? activeBox(bandY(active.r)) : null
  const actBody = active && active.r >= frozen ? activeBox(bodyY(active.r)) : null
  // The edge paints over the panes' outlines where they meet it, so the outlines are drawn again above it, cut to its
  // rows: a band piece as is, a body piece moved into band space, its top side only while its first row sits at the
  // split rather than scrolled under the band.
  const bodyDy = bandH + rw.r0 * ROW_H - rw.v
  // An open end is pushed past the cut, or the ring's inner bg keyline would paint across the edge.
  const atEdge = (p: Box | null, body: boolean): Box | null => {
    if (!p) return null
    const top = (body ? p.top + bodyDy : p.top) - (p.open.top ? 4 : 0)
    const height = p.height + (p.open.top ? 4 : 0) + (p.open.bottom ? 4 : 0)
    const from = body && (p.open.top || top < bandH) ? bandH : bandH - 2
    const t = Math.max(-3, from - top)
    const b = Math.max(-3, top + height - (bandH + 1))
    return t + b < height ? { ...p, top, height, clip: cut(t, b) } : null
  }

  const bodyRows: JSX.Element[] = []
  if (win) for (let j = rw.r0; j <= rw.r1; j++) if (frozen + j < records) bodyRows.push(renderRow(frozen + j, (j - rw.r0) * ROW_H, false))

  const ragged = !!facts && facts.minFields !== facts.cols
  const status = !facts ? '' : updating ? 'Updating' : readout(rows, exact, facts.cols, ragged, facts.encoding)
  const statusTitle = !facts ? '' : [status, ragged && `Rows have between ${facts.minFields} and ${facts.cols} fields.`, facts.encoding === 'Windows-1252' && "Not valid UTF-8, so it's read as Windows-1252."].filter(Boolean).join(' ')
  const barLabel = sel ? selectedLabel(sel, Math.max(1, records), cols) : ''
  const blocked = version?.refused ? (version.refused === 'too-large' ? `Clui can't reference ${name}: it's larger than 200 MB.` : REASON[version.refused] || `Couldn't read ${name}.`) : undefined
  const total = (found?.hits.length ?? 0) / 2
  const countText = !deferred || !found ? '' : !total ? (found.done ? 'No matches' : '') : found.more ? `${findAt + 1} of 10,000+` : found.done ? `${findAt + 1} of ${fmt(total)}` : `${fmt(total)} so far`

  let body2: JSX.Element | null = null
  if (shown.t === 'doc') body2 = <DocState handleId={handleId} tabId={tabId} path={path} doc={shown.doc} load={load} reopen={() => (void load(), setWatchGen((n) => n + 1))} />
  else if (shown.t === 'unsupported')
    body2 = (
      <div className={STATE_BODY}>
        <p className="text-ui font-medium text-content">{`Clui can't show ${name}`}</p>
        <p className="max-w-[60ch] text-ui text-dim">{shown.detail}</p>
        <button type="button" className={TEXT_BTN} onClick={() => void openDefault(handleId, path)}>
          Open in default app
        </button>
      </div>
    )
  else if (shown.t === 'empty')
    body2 = (
      <div className={STATE_BODY}>
        <p className="text-ui font-medium text-content">{`${name} is empty`}</p>
      </div>
    )

  const gridShown = shown.t === 'grid' || shown.t === 'loading'
  const grid = shown.t === 'grid'
  // Lines the index hasn't mapped to rows yet, or past the last record, say so without a mark.
  const hlRows = hl && highlight?.range ? (hl.shape === 'rows' ? (hl.r0 === hl.r1 ? `row ${fmt(hl.r0 + 1)}` : `rows ${highlight.range}`) : highlight.range) : null
  const hlLabel = highlight?.lines ? `Claude pointed to ${rangeLines(highlight.lines)}${hlRows ? `, ${hlRows}` : ''}` : hlRows ? `Claude pointed to ${hlRows}` : null

  return (
    <div data-ui="sheet-surface" className="flex h-full min-h-0 flex-col bg-bg pt-(--top-h)">
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
            label={`Find in ${name}`}
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
          <button type="button" className={TEXT_BTN} onClick={() => void openDefault(handleId, path)}>
            Open in default app
          </button>
        </div>
      )}
      {body2}
      {gridShown && (
        <div
          ref={scroller}
          role="grid"
          aria-label={name}
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
                  <div
                    role="columnheader"
                    aria-colindex={1}
                    aria-label="Select all"
                    className="sticky left-0 z-[3] h-6 border-b border-r border-border bg-tool"
                    style={{ width: rhW }}
                  />
                  {Array.from({ length: Math.max(0, c1 - c0 + 1) }, (_, i) => {
                    const c = c0 + i
                    return (
                      <div
                        key={c}
                        role="columnheader"
                        aria-colindex={c + 2}
                        className={`absolute top-0 flex h-6 items-center justify-center border-b border-r border-border text-meta ${colHeadOn(c) ? 'bg-row-selected font-medium text-content' : 'bg-tool text-faint'}`}
                        style={{ left: rhW + off[c], width: off[c + 1] - off[c] }}
                      >
                        {colName(c)}
                      </div>
                    )
                  })}
                </div>
                {frozen > 0 && win && renderRow(0, HEAD_H, true)}
                {drawRange('band', selBand, holeBand, bandY, single)}
                {dashed(hlBand, 'hl-band', 'sheet-claude')}
                {frame(actBand, 'sheet-active')}
                {frozen > 0 && (
                  // The panes' split: control-edge between two bg keylines, so it holds 3:1 over any fill below it.
                  <div data-ui="sheet-frozen-edge" aria-hidden="true" className="pointer-events-none absolute inset-x-0 -bottom-px z-[5] h-0.75 border-y border-bg bg-control-edge" />
                )}
                {frozen > 0 && (
                  <div data-ui="sheet-edge-outlines" aria-hidden="true" className="pointer-events-none absolute inset-0 z-[6]">
                    {ring(atEdge(selBand, false), 'sel-band')}
                    {ring(atEdge(selBody, true), 'sel-body')}
                    {dashed(atEdge(hlBand, false), 'hl-band')}
                    {dashed(atEdge(hlBody, true), 'hl-body')}
                    {frame(atEdge(actBand, false))}
                    {frame(atEdge(actBody, true))}
                  </div>
                )}
              </div>
              <div className="absolute left-0" style={{ top: blockTop, width: contentW, height: (rw.r1 - rw.r0 + 1) * ROW_H }}>
                {bodyRows}
                {drawRange('body', selBody, holeBody, bodyY, single)}
                {dashed(hlBody, 'hl-body', 'sheet-claude')}
                {frame(actBody, 'sheet-active')}
              </div>
            </div>
          )}
        </div>
      )}
      {grid && facts && (
        <div data-ui="sheet-strip" className="flex h-8 shrink-0 items-stretch border-t border-border bg-tool">
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
          <div className="flex shrink-0 items-center gap-1 px-1">
            <span data-ui="sheet-readout" className="truncate px-2 text-meta tabular-nums text-dim" title={statusTitle}>
              {status}
            </span>
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
}

const rangeLines = ({ start, end }: { start: number; end: number }): string => (end > start ? `lines ${fmt(start)} to ${fmt(end)}` : `line ${fmt(start)}`)

/** What the value doesn't say: an empty field, a field the record doesn't have, or a value cut at 64 KB. */
function FormulaNote({ bar }: { bar: { at: string; value: string; long: boolean; fields: number } }): JSX.Element | null {
  const col = bar.at.match(/^[A-Z]+/)?.[0] ?? 'A'
  const row = Number(bar.at.slice(col.length))
  let text = ''
  if (bar.long) text = `Showing the first ${CELL_FULL_MAX / 1024} KB of this cell.`
  else if (!bar.value) text = colIndex(col) >= bar.fields ? `No field here. Row ${fmt(row)} has ${fmt(bar.fields)} ${bar.fields === 1 ? 'field' : 'fields'}.` : 'Empty'
  if (!text) return null
  return <div className="shrink-0 px-2 py-2 text-meta text-dim @max-[360px]/fb:basis-full @max-[360px]/fb:pt-0">{text}</div>
}

const refusal = (r: Refusal): Shown => ({ t: 'doc', doc: r.reason === 'missing' ? { t: 'missing' } : { t: 'error', reason: r.reason, message: REASON[r.reason] } })
