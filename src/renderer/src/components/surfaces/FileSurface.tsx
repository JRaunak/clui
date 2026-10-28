import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { useActive, useSession } from '../../store'
import type { ChangeMarks } from '../../../../shared/changes'
import type { SurfaceLocation } from '../../../../shared/surfaces'
import { FindField } from '../FindField'
import { IconDiff, IconHash, IconTarget } from '../Icon'
import { Code } from './HunkView'
import type { PaneExternal } from './PaneHeader'
import { highlightTexts, langForPath } from '../../lib/highlight'
import { escapeHtml, markHtml } from '../../lib/highlightLines'
import { requestSurfaceFocus, setPointing, takePoint, takeSurfaceFocus, usePointing, usePointRequest } from '../../lib/surfaceFocus'
import { reducedMotion, viaOf, type Via } from '../../lib/motion'
import { SelectionBar } from './SelectionBar'
import { POINT_HINT, POINT_OFF, selectedText } from '../../lib/refCopy'
import { BANNER, baseOf, DocState, FIND_MAX, FLASH_MS, openDefault, openEditor, rangeText, SelectionNotice, TEXT_BTN, toLines, useFileDoc, useFileStatus, useFind, VIEW_SETTLE_MS, type Lines } from './fileDoc'
import { clearNoPreview, useNoPreview } from '../../lib/presentation'
import { findRe } from '../../lib/find'

const SKELETON = [62, 48, 71, 35, 80, 54, 66, 40, 58, 44, 75, 50]
/** ⌘L from the File menu. */
export const FILE_GOTO_EVENT = 'clui:file-goto'
const MARK = 'rounded-[2px] bg-border-strong text-content [&_*]:text-content'
const MARK_ACTIVE = 'rounded-[2px] bg-content text-bg [&_*]:text-bg'

const lines = (n: number): string => `${n.toLocaleString()} ${n === 1 ? 'line' : 'lines'}`
const NO_LINES = 'This file has no lines to point at.'


/** `page`: the tab shows a Preview, which opens in the file's default app rather than the editor. */
export function useFileExternal(handleId: string | null, path: string | null, page = false): PaneExternal {
  const gone = useFileStatus(handleId, path) === 'missing'
  return {
    label: page ? 'Open in default app' : 'Open in editor',
    disabledReason: gone ? 'The file no longer exists.' : undefined,
    onOpen: () => (handleId && path ? (page ? openDefault : openEditor)(handleId, path) : undefined)
  }
}

type Item =
  | { t: 'line'; n: number }
  | { t: 'chip'; key: string; hunk?: string; text: string; label: string; more: string }
  | { t: 'pointed'; start: number; end: number }
  | { t: 'banner'; end: boolean }
  | { t: 'notice'; notice: 'cleared' | 'removed' }
  | { t: 'unmarked' }
  /** A Markdown file `auto` opened as Source for its size. */
  | { t: 'big' }

function chipOf(h: ChangeMarks['hunks'][number]): { text: string; label: string } {
  if (h.bars.length) {
    const r = { start: h.bars[0][0], end: h.bars.at(-1)![1] }
    return { text: `Claude changed ${rangeText(r, '–')}`, label: `View Claude's change to ${rangeText(r, ' to ')}` }
  }
  const w = h.wedge!
  return { text: `Claude removed ${lines(w.count)} here`, label: `View the ${lines(w.count)} Claude removed after line ${w.line - 1}` }
}

/**
 * A read-only view of one file: line numbers, Claude's surviving lines marked in the gutter, the
 * user's line selection, go to line and find. It re-reads when the file changes on disk, holding
 * the reader's place by line number.
 */
export function FileSurface({ handleId, tabId }: { handleId: string; tabId: string }): JSX.Element {
  const range = useRef({ start: 0, end: 0 })
  const keepLine = useRef<number | null>(null)
  const itemsRef = useRef<Item[]>([])
  // Reads refs: load and the unmount effect call this from earlier renders' closures.
  const topLine = (): number => {
    const all = itemsRef.current
    for (let i = range.current.start; i < all.length; i++) {
      const it = all[i]
      if (it?.t === 'line') return it.n
    }
    return 1
  }
  const { tab, path, doc, docRef, slow, notice, setNotice, said, say, selection, setSelection, addSelection, inTarget, selSay, load, reopen } = useFileDoc(handleId, tabId, (moved) => {
    keepLine.current = range.current.start > 0 ? moved(topLine()) : null
  })
  const change = useActive((s) => s?.changes.find((c) => c.path === path) ?? null)
  const setView = useSession((s) => s.setSurfaceView)
  const openSurface = useSession((s) => s.openSurface)
  const big = useNoPreview(handleId, path) === 'too-large' && (tab?.mode ?? 'auto') === 'auto'
  const showedBig = useRef(false)
  if (big) showedBig.current = true
  useEffect(
    () => () => {
      if (showedBig.current) clearNoPreview(handleId, path)
    },
    [handleId, path]
  )
  const name = baseOf(path)
  const lang = langForPath(path)
  const highlight = tab?.highlight?.lines ?? null
  const location = tab?.location

  const [hl, setHl] = useState<{ revision: string; lines: string[] } | null>(null)
  const [marks, setMarks] = useState<ChangeMarks | null>(null)
  const [flash, setFlash] = useState<{ range: Lines; via: Via } | null>(null)
  const [bar, setBar] = useState<'find' | 'goto' | null>(null)
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const bodyEl = useRef<HTMLDivElement | null>(null)
  const bodyRef = useCallback((el: HTMLDivElement | null) => {
    bodyEl.current = el
    setScroller(el)
  }, [])
  const virtuoso = useRef<VirtuosoHandle>(null)
  const anchor = useRef<number | null>(null)
  const active = useRef<number | null>(null)
  const down = useRef<{ x: number; y: number } | null>(null)
  const openVia = useRef<Via>('keyboard')

  const revision = doc.t === 'text' ? doc.revision : null
  const text = doc.t === 'text' ? doc.text : null
  useEffect(() => {
    if (revision === null || text === null) return
    let live = true
    void highlightTexts(lang, [text]).then(([out]) => live && out && setHl({ revision, lines: out }))
    return () => {
      live = false
    }
  }, [revision, text, lang])

  const editKey = change?.editIds.join(',') ?? ''
  useEffect(() => {
    if (revision === null || !editKey) return setMarks(null)
    let live = true
    void window.clui.getChangeMarks(handleId, path).then((m) => live && setMarks(m))
    return () => {
      live = false
    }
  }, [revision, editKey, handleId, path])

  const docLines = useMemo(() => (doc.t === 'text' ? toLines(doc.text) : null), [doc])
  const count = docLines?.length ?? 0

  // Go to line and find share the docked bar; opening one closes the other.
  const returnTo = useRef<HTMLElement | null>(null)
  const openBar = useCallback((which: 'find' | 'goto') => {
    if (!returnTo.current) returnTo.current = document.activeElement as HTMLElement | null
    setBar(which)
  }, [])
  const { query, setQuery, deferred, current, setCurrent, input: findInput } = useFind(bar === 'find', (on) => (on ? openBar('find') : setBar(null)), () => docRef.current.t === 'text', (by) => stepFind(by))
  const found = useMemo(() => {
    const q = bar === 'find' ? deferred : ''
    const all: { n: number; s: number; e: number }[] = []
    let more = false
    if (!q || !docLines) return { all, more }
    const re = findRe(q)
    outer: for (let i = 0; i < docLines.length; i++) {
      for (const m of docLines[i].matchAll(re)) {
        if (all.length === FIND_MAX) {
          more = true
          break outer
        }
        all.push({ n: i + 1, s: m.index, e: m.index + m[0].length })
      }
    }
    return { all, more }
  }, [bar, deferred, docLines])
  const byLine = useMemo(() => {
    const m = new Map<number, [number, number][]>()
    for (const f of found.all) {
      const list = m.get(f.n) ?? []
      list.push([f.s, f.e])
      m.set(f.n, list)
    }
    return m
  }, [found])
  const activeMatch = found.all[Math.min(current, found.all.length - 1)]

  // Items: annotations interleave with lines, so each line's item index is kept for scrolling.
  const valid = marks && marks.revision === revision ? marks : null
  const { items, lineIndex, barAt, wedgeAt } = useMemo(() => {
    const items: Item[] = []
    const barAt = new Uint8Array(count + 2)
    const wedgeAt = new Uint8Array(count + 2)
    const chips = new Map<number, Item[]>()
    if (big) items.push({ t: 'big' })
    if (notice) items.push({ t: 'notice', notice })
    if (doc.t === 'text' && doc.truncated) items.push({ t: 'banner', end: false })
    if (valid?.state === 'created') {
      items.push({ t: 'chip', key: 'chip:created', hunk: valid.hunks[0]?.id, text: 'Claude created this file', label: "View Claude's changes to this new file", more: 'View change' })
    } else if (valid?.state === 'unavailable') {
      items.push({ t: 'unmarked' })
    } else if (valid) {
      for (const h of valid.hunks) {
        for (const [a, b] of h.bars) for (let n = a; n <= Math.min(b, count); n++) barAt[n] = 1
        if (h.wedge && h.wedge.line <= count) wedgeAt[h.wedge.line] = 1
        const first = Math.min(h.bars[0]?.[0] ?? Infinity, h.wedge?.line ?? Infinity)
        if (first > count) continue
        chips.set(first, [...(chips.get(first) ?? []), { t: 'chip', key: `chip:${h.id}`, hunk: h.id, ...chipOf(h), more: 'View change' }])
      }
    }
    const lineIndex = new Int32Array(count + 2)
    for (let n = 1; n <= count; n++) {
      for (const c of chips.get(n) ?? []) items.push(c)
      if (highlight && highlight.start === n) items.push({ t: 'pointed', start: highlight.start, end: highlight.end })
      lineIndex[n] = items.length
      items.push({ t: 'line', n })
    }
    if (doc.t === 'text' && doc.truncated) items.push({ t: 'banner', end: true })
    return { items, lineIndex, barAt, wedgeAt }
  }, [doc, count, valid, notice, highlight, big])

  itemsRef.current = items

  // The bar takes its height from the scroller, which can hide the line just selected.
  const barShown = doc.t === 'text' && !!selection
  useLayoutEffect(() => {
    if (barShown && selection) bodyEl.current?.querySelector(`[data-line="${selection.end}"]`)?.scrollIntoView({ block: 'nearest' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barShown])
  const toLine = (n: number, align: 'center' | 'start'): void => {
    const index = lineIndex[Math.max(1, Math.min(count, n))]
    virtuoso.current?.scrollToIndex({ index, align })
  }

  // A re-read keeps the reader on the line they were at.
  useLayoutEffect(() => {
    const n = keepLine.current
    if (n === null || doc.t !== 'text') return
    keepLine.current = null
    toLine(n, 'start')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])

  // Point waits for the read, since only text has lines to point at. It never ends on blur: the button is outside.
  const pointing = usePointing(tabId)
  const asked = usePointRequest(tabId)
  useLayoutEffect(() => {
    if (!asked || doc.t === 'loading' || !takePoint(tabId)) return
    if (pointing) {
      setPointing(tabId, false)
      clearTimeout(selSay.current)
      return say(POINT_OFF)
    }
    if (doc.t !== 'text') return say(NO_LINES)
    setPointing(tabId, true)
    bodyEl.current?.focus({ preventScroll: true })
    if (selection) bodyEl.current?.querySelector(`[data-line="${selection.end}"]`)?.scrollIntoView({ block: 'nearest' })
    say('Pointing. Click line numbers, or press Shift and an arrow key, to select lines. Enter adds them.')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, doc.t])
  useEffect(() => () => setPointing(tabId, false), [tabId])

  // A user open focuses the view once there's one to focus; a destination centres and washes its lines.
  useLayoutEffect(() => {
    if (doc.t === 'loading' || !bodyEl.current) return
    const via = takeSurfaceFocus(tabId)
    if (!via) return
    openVia.current = via
    bodyEl.current.focus({ preventScroll: true })
  }, [doc.t, location, tabId])

  const applied = useRef<SurfaceLocation | null>(null)
  useEffect(() => {
    if (doc.t !== 'text' || !location?.line || applied.current === location || !scroller) return
    applied.current = location
    const r = { start: location.line, end: Math.max(location.line, location.endLine ?? location.line) }
    toLine(r.start, 'center')
    // The Claude highlight already marks its own range.
    if (highlight && highlight.start === r.start && highlight.end === r.end) return
    setFlash({ range: r, via: openVia.current === 'pointer' && !reducedMotion() ? 'pointer' : 'keyboard' })
    openVia.current = 'keyboard'
    const t = setTimeout(() => setFlash(null), FLASH_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.t, location, scroller])

  // A restored tab lands where it was left; a settled scroll and unmounting save its top line.
  // An artifact's viewState is its page's, so its Source keeps its place in sourceView.
  const viewKey = tab?.kind === 'artifact' ? 'sourceView' : 'viewState'
  const restoreAt = useMemo(() => {
    const v = tab?.[viewKey]
    return v?.kind === 'file' && !location?.line ? v.topLine : 1
  }, [])
  const viewTimer = useRef<ReturnType<typeof setTimeout>>()
  const saveTop = (): void => {
    if (docRef.current.t !== 'text') return
    const n = topLine()
    const v = useSession.getState().sessions[handleId]?.surfaces.tabs[tabId]?.[viewKey]
    if (v?.kind === 'file' && v.topLine === n) return
    setView(handleId, tabId, { [viewKey]: { kind: 'file', topLine: n, offsetPx: 0, scrollLeft: 0, previewScrollTop: 0 } })
  }
  useEffect(
    () => () => {
      clearTimeout(viewTimer.current)
      saveTop()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const clickNumber = (n: number, shift: boolean): void => {
    if (shift && anchor.current !== null) {
      active.current = n
      return setSelection({ start: Math.min(anchor.current, n), end: Math.max(anchor.current, n) })
    }
    if (selection && selection.start === n && selection.end === n) return setSelection(null)
    anchor.current = n
    active.current = n
    setSelection({ start: n, end: n })
  }

  // Dragging across code keeps the native selection for copying; its lines become the line selection.
  const onMouseUp = (): void => {
    const s = window.getSelection()
    if (!s || s.isCollapsed || !bodyEl.current) return
    const lineOf = (node: Node | null): number | null => {
      const el = node instanceof Element ? node : node?.parentElement
      const row = el?.closest<HTMLElement>('[data-line]')
      return row && bodyEl.current?.contains(row) ? Number(row.dataset.line) : null
    }
    const a = lineOf(s.anchorNode)
    const b = lineOf(s.focusNode)
    if (a === null || b === null) return
    anchor.current = a
    active.current = b
    setSelection({ start: Math.min(a, b), end: Math.max(a, b) })
  }

  // A later Shift-click starts fresh instead of extending a selection the user dismissed.
  const clearSelection = (): void => {
    anchor.current = active.current = null
    setSelection(null)
  }

  // A plain click on the code dismisses the selection. A drag that just became one, a click that
  // wandered, and the line numbers and controls inside the body keep their own meaning.
  const onBodyClick = (e: MouseEvent): void => {
    const at = down.current
    down.current = null
    if (!selection || !at || e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
    if (Math.hypot(e.clientX - at.x, e.clientY - at.y) > 3) return
    if (e.target instanceof Element && e.target.closest('[data-num], button, a, input, textarea')) return
    if (!window.getSelection()?.isCollapsed) return
    clearSelection()
  }

  const onRegionKey = (e: KeyboardEvent): void => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && selection) {
      e.preventDefault()
      return addSelection()
    }
    if (e.key === 'Escape') {
      if (!selection && !highlight && !pointing) return
      e.preventDefault()
      if (selection || highlight) return clearSelection()
      setPointing(tabId, false)
      clearTimeout(selSay.current)
      return say(POINT_OFF)
    }
    if (!e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') || !count) return
    e.preventDefault()
    if (!selection) {
      const n = topLine()
      anchor.current = n
      active.current = n
      return setSelection({ start: n, end: n })
    }
    const from = active.current ?? selection.end
    const to = Math.max(1, Math.min(count, from + (e.key === 'ArrowUp' ? -1 : 1)))
    anchor.current ??= selection.start
    active.current = to
    setSelection({ start: Math.min(anchor.current, to), end: Math.max(anchor.current, to) })
    if (lineIndex[to] < range.current.start || lineIndex[to] > range.current.end) toLine(to, 'center')
  }

  const gotoInput = useRef<HTMLInputElement>(null)
  const [gotoText, setGotoText] = useState('')
  const [gotoBad, setGotoBad] = useState(false)
  const closeBar = (refocus: 'region' | 'back'): void => {
    setBar(null)
    setGotoBad(false)
    const back = returnTo.current
    returnTo.current = null
    requestAnimationFrame(() => (refocus === 'back' && back?.isConnected ? back : bodyEl.current)?.focus())
  }

  const stepFind = (by: number): void => {
    const total = found.all.length
    if (!total) return
    const next = (((current + by) % total) + total) % total
    setCurrent(next)
    const n = found.all[next].n
    if (lineIndex[n] < range.current.start || lineIndex[n] > range.current.end) toLine(n, 'center')
  }

  useEffect(() => {
    const onGoto = (): void => {
      if (docRef.current.t !== 'text') return
      openBar('goto')
      requestAnimationFrame(() => {
        gotoInput.current?.focus()
        gotoInput.current?.select()
      })
    }
    window.addEventListener(FILE_GOTO_EVENT, onGoto)
    return () => window.removeEventListener(FILE_GOTO_EVENT, onGoto)
  }, [openBar, docRef])

  const submitGoto = (): void => {
    const m = /^\s*(\d+)(?::\d+)?(?:\s*-\s*(\d+))?\s*$/.exec(gotoText)
    const a = m ? Number(m[1]) : 0
    const b = m?.[2] ? Number(m[2]) : a
    if (!m || a < 1 || b < a || b > count) return setGotoBad(true)
    anchor.current = a
    active.current = b
    setSelection({ start: a, end: b })
    toLine(a, 'center')
    closeBar('region')
  }

  const viewChange = (hunk: string | undefined, via: Via): void => {
    requestSurfaceFocus('diff', via)
    openSurface(handleId, { kind: 'diff', key: '', title: 'Claude changes', location: { file: path, ...(hunk ? { hunk } : {}) } }, 'focus', 'user', 'user')
  }

  const lineHtml = (n: number): string | null => {
    const text = docLines?.[n - 1] ?? ''
    const base = hl?.revision === revision ? (hl.lines[n - 1] ?? null) : null
    const ranges = byLine.get(n)
    if (!ranges) return base
    const activeIdx = activeMatch?.n === n ? ranges.findIndex(([s]) => s === activeMatch.s) : -1
    return markHtml(base ?? escapeHtml(text), ranges, activeIdx, MARK, MARK_ACTIVE)
  }

  const truncatedLines = doc.t === 'text' && doc.truncated ? lines(count) : ''
  const renderItem = (it: Item): JSX.Element => {
    switch (it.t) {
      case 'line': {
        const n = it.n
        const sel = !!selection && n >= selection.start && n <= selection.end
        const pointed = !!highlight && n >= highlight.start && n <= highlight.end
        const washed = !!flash && n >= flash.range.start && n <= flash.range.end
        const empty = n === 1 && text === ''
        return (
          <div data-line={n} className={`relative isolate flex font-mono text-code ${sel ? 'bg-line-selected' : ''}`}>
            {washed && (
              <span
                aria-hidden="true"
                className={`pointer-events-none absolute inset-0 -z-10 bg-bg-raised ${flash.via === 'pointer' ? 'animate-[turn-flash-out_var(--dur-slow)_var(--ease-in)_var(--dur-stage)_both]' : ''}`}
              />
            )}
            <span
              aria-hidden="true"
              data-num=""
              onClick={(e) => clickNumber(n, e.shiftKey)}
              onMouseDown={(e) => {
                e.preventDefault()
                window.getSelection()?.removeAllRanges()
              }}
              className={`box-content w-(--num-ch) shrink-0 cursor-default select-none pl-3 pr-1 text-right tabular-nums ${sel ? 'text-content' : 'text-faint pointer-fine:hover:text-content'}`}
            >
              {n}
            </span>
            <span aria-hidden="true" className="relative w-3 shrink-0 select-none">
              {barAt[n] ? <span className="absolute inset-y-0 left-1 w-0.5 bg-ok" /> : null}
              {wedgeAt[n] ? <span className="absolute -top-[3px] left-1 h-0 w-0 border-y-[3px] border-l-[5px] border-y-transparent border-l-err" /> : null}
            </span>
            <span className={`relative flex min-w-0 flex-1 ${pointed && !sel ? 'bg-bg-raised' : ''}`}>
              {pointed && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-dim" />}
              {empty ? (
                <span className="min-w-0 flex-1 pr-3 text-faint">Empty file</span>
              ) : (
                <Code kind=" " text={docLines?.[n - 1] ?? ''} html={lineHtml(n)} />
              )}
            </span>
          </div>
        )
      }
      case 'chip':
        return (
          <div className="flex h-8 select-none items-center pl-[calc(var(--num-ch)+1.75rem)]">
            <button
              type="button"
              aria-label={it.label}
              onClick={(e) => viewChange(it.hunk, viaOf(e))}
              className="inline-flex h-6 items-center gap-1.5 rounded-md border border-border bg-bg-elev px-2 text-meta text-dim pointer-fine:hover:bg-control-hover pointer-fine:hover:text-content"
            >
              <IconDiff className="h-3 w-3" />
              {it.text}
              <span aria-hidden="true">·</span>
              <span className="text-content">{it.more}</span>
            </button>
          </div>
        )
      case 'pointed':
        return (
          <div className="flex h-6 select-none items-center gap-1.5 pl-[calc(var(--num-ch)+1.75rem)] text-meta text-dim">
            <IconTarget className="h-3 w-3" />
            {`Claude pointed to ${rangeText(it, '–')}`}
          </div>
        )
      case 'big':
        return (
          <div className={BANNER}>
            {`${name} is over 1 MB, so it opens as source.`}
            <button type="button" className={TEXT_BTN} onClick={() => setView(handleId, tabId, { mode: 'preview' })}>
              Preview the first 1 MB
            </button>
          </div>
        )
      case 'banner':
        return (
          <div className={BANNER}>
            {it.end ? "The rest of the file isn't shown." : `Showing the first ${truncatedLines}. The file is too large to show in full.`}
            <button type="button" className={TEXT_BTN} onClick={() => void openEditor(handleId, path)}>
              Open in editor
            </button>
          </div>
        )
      case 'unmarked':
        return (
          <div className={BANNER}>
            Claude changed this file, but it has changed since, so no lines are marked.
            <button type="button" className={TEXT_BTN} onClick={(e) => viewChange(undefined, viaOf(e))}>
              View changes
            </button>
          </div>
        )
      case 'notice':
        return <SelectionNotice notice={it.notice} onDismiss={() => setNotice(null)} />
    }
  }

  let content: JSX.Element | null = null
  if (doc.t === 'loading') {
    content = slow ? (
      <div className="pt-1">
        {SKELETON.map((w, i) => (
          <div key={i} className="flex h-5 font-mono text-code">
            <span className="box-content w-(--num-ch) shrink-0 pl-3 pr-1" />
            <span className="w-3 shrink-0" />
            <span className="my-1 h-3 rounded-sm bg-bg-raised" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
    ) : null
  } else if (doc.t !== 'text') {
    content = <DocState handleId={handleId} tabId={tabId} path={path} doc={doc} load={load} reopen={reopen} />
  } else if (scroller) {
    content = (
      <Virtuoso
        ref={virtuoso}
        customScrollParent={scroller}
        data={items}
        initialTopMostItemIndex={restoreAt > 1 ? (lineIndex[Math.min(count, restoreAt)] ?? 0) : 0}
        computeItemKey={(_i, it) => (it.t === 'line' ? `l${it.n}` : it.t === 'chip' ? it.key : it.t === 'banner' ? `b${it.end}` : it.t)}
        rangeChanged={(r) => {
          range.current = { start: r.startIndex, end: r.endIndex }
          clearTimeout(viewTimer.current)
          viewTimer.current = setTimeout(saveTop, VIEW_SETTLE_MS)
        }}
        itemContent={(_i, it) => renderItem(it)}
      />
    )
  }

  const shownNote = doc.t === 'text' && doc.truncated ? ` in the first ${truncatedLines}` : ''
  const total = found.all.length
  const countText = !deferred ? '' : total ? `${current + 1} of ${found.more ? '10,000+' : total.toLocaleString()}` : 'No matches'
  const gotoHint = gotoBad ? `Enter 1 to ${count.toLocaleString()}${shownNote ? ' (lines shown)' : ''}` : `of ${count.toLocaleString()}`

  return (
    <div data-ui="file-surface" style={{ '--num-ch': `${String(Math.max(count, 1)).length}ch` } as CSSProperties} className="flex h-full min-h-0 flex-col bg-bg pt-(--top-h)">
      {bar && (
        <div className="flex h-9 shrink-0 items-center border-b border-border bg-bg px-1">
          {bar === 'find' ? (
            <FindField
              ui="file-find"
              inputRef={findInput}
              value={query}
              onChange={setQuery}
              onEnter={(shift) => stepFind(shift ? -1 : 1)}
              onClose={() => {
                setQuery('')
                closeBar('region')
              }}
              onPrev={() => stepFind(-1)}
              onNext={() => stepFind(1)}
              stepDisabled={!total}
              countText={countText}
              statusText={!deferred ? '' : total ? `Match ${current + 1} of ${found.more ? '10,000+' : total.toLocaleString()}${shownNote}` : 'No matches'}
              placeholder="Find in file"
              label={`Find in ${name}`}
            />
          ) : (
            <FindField
              ui="file-goto-bar"
              inputRef={gotoInput}
              value={gotoText}
              onChange={(v) => {
                setGotoText(v)
                setGotoBad(false)
              }}
              onEnter={submitGoto}
              onClose={() => closeBar('back')}
              countText={gotoHint}
              countId={`goto-hint-${tabId}`}
              countClass={gotoBad ? 'text-err' : 'text-dim'}
              placeholder="Line number"
              label="Go to line"
              icon={<IconHash className="h-3.5 w-3.5 shrink-0 text-dim" />}
              invalid={gotoBad}
              numeric
              closeLabel="Close go to line"
            />
          )}
        </div>
      )}
      <div
        ref={bodyRef}
        role="region"
        aria-label={doc.t === 'text' ? `${name}, ${lines(count)}` : name}
        aria-busy={doc.t === 'loading' || undefined}
        tabIndex={0}
        data-ui="file-body"
        data-beside-header=""
        {...(doc.t === 'loading' ? {} : { 'data-pane-title': '' })}
        aria-keyshortcuts="Meta+Shift+A Meta+L"
        onKeyDown={onRegionKey}
        onMouseDown={(e) => {
          down.current = { x: e.clientX, y: e.clientY }
        }}
        onMouseUp={onMouseUp}
        onClick={onBodyClick}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {content}
      </div>
      {barShown && selection ? (
        <SelectionBar label={selectedText(selection)} attached={inTarget} onAdd={addSelection} />
      ) : pointing && doc.t === 'text' ? (
        <SelectionBar label={POINT_HINT} blocked={POINT_HINT} onBlocked={() => say(POINT_HINT)} attached={false} onAdd={addSelection} />
      ) : null}
      <span className="sr-only" aria-live="polite">
        {said}
      </span>
    </div>
  )
}
