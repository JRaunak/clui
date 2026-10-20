import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { diffLines } from 'diff'
import { refsOf, restoredTab, useActive, useSession } from '../../store'
import type { DraftReference } from '../../../../shared/context'
import type { ChangeMarks } from '../../../../shared/changes'
import type { SurfaceLocation } from '../../../../shared/surfaces'
import type { Refusal } from '../../../../shared/files'
import { survivingLines } from '../../../../shared/lines'
import { Button } from '../Button'
import { FindField } from '../FindField'
import { IconDiff, IconHash, IconTarget } from '../Icon'
import { toWorkspaceRelative } from '../ChangedFiles'
import { Code } from './HunkView'
import { PANE_BTN, type PaneExternal } from './PaneHeader'
import { highlightTexts, langForPath } from '../../lib/highlight'
import { escapeHtml, markHtml } from '../../lib/highlightLines'
import { requestSurfaceFocus, takeSurfaceFocus } from '../../lib/surfaceFocus'
import { reducedMotion, viaOf, type Via } from '../../lib/motion'
import { noteRead } from '../../lib/blockedFiles'
import { closeTab } from './SurfaceTabs'
import { SelectionBar } from './SelectionBar'
import { addFromSurface } from '../ContextChips'
import { selectedText } from '../../lib/refCopy'

const SKELETON_MS = 400
const TEXT_MAX_MB = 5
const FLASH_MS = 720
/** During Claude's turn a file can change many times a second; it re-reads at most this often. */
const TURN_RELOAD_MS = 300
const MISSING_POLL_MS = 2000
const ANNOUNCE_MS = 300
const FIND_MAX = 10_000
const REMAP_MS = 50
/** The window's unload never unmounts the open file, so its top line saves once a scroll settles. */
const VIEW_SETTLE_MS = 250
const SKELETON = [62, 48, 71, 35, 80, 54, 66, 40, 58, 44, 75, 50]
const GOTO_EVENT = 'clui:file-goto'
/** ⌘F, ⌘G and ⇧⌘G routed to the File surface; detail is 'open' | 'next' | 'prev'. */
export const FILE_FIND_EVENT = 'clui:file-find'
const MARK = 'rounded-[2px] bg-border-strong text-content [&_*]:text-content'
const MARK_ACTIVE = 'rounded-[2px] bg-content text-bg [&_*]:text-bg'
const TEXT_BTN = 'h-6 shrink-0 rounded px-2 text-content hover:bg-control-hover'
const STATE_BODY = 'flex flex-col items-start gap-2 px-4 py-6'

const baseOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1) || p
const lines = (n: number): string => `${n.toLocaleString()} ${n === 1 ? 'line' : 'lines'}`
export const cleanError = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
const toLines = (t: string): string[] => {
  const ls = t.split('\n')
  if (ls.length > 1 && ls.at(-1) === '') ls.pop()
  return ls
}
const REASON: Record<Refusal['reason'], string> = {
  invalid: "The file's path isn't valid.",
  denied: "Clui only shows files in this session's folder or files Claude changed.",
  missing: "The file isn't on disk.",
  'wrong-type': "It isn't a regular file.",
  changed: 'The file changed while it was being read.',
  'too-large': `It's larger than ${TEXT_MAX_MB} MB, the most Clui opens.`,
  limit: 'The system has too many files open. Try again in a moment.',
  unreadable: '',
  permission: "macOS didn't let Clui read it. Check Clui's access in System Settings > Privacy & Security.",
  unavailable: "Clui can't read files safely on this system."
}
const RETRY = new Set<Refusal['reason']>(['changed', 'limit', 'unreadable'])
const CHOOSE = 'Choose file\u2026'

// What a shown file's view holds, for the header buttons and the menu item outside this component.
const status = new Map<string, Doc['t']>()
const listeners = new Set<() => void>()
function setStatus(key: string, t: Doc['t'] | null): void {
  if ((status.get(key) ?? null) === t) return
  if (t) status.set(key, t)
  else status.delete(key)
  for (const l of listeners) l()
}
const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
const useFileStatus = (handleId: string | null, path: string | null): Doc['t'] | null =>
  useSyncExternalStore(subscribe, () => (handleId && path ? (status.get(`${handleId}\0${path}`) ?? null) : null))
export const useFileMissing = (handleId: string | null, path: string | null): boolean => useFileStatus(handleId, path) === 'missing'

export const openEditor = (handleId: string, path: string, line?: number): Promise<void> =>
  window.clui.openInEditor(handleId, path, line).catch((e: unknown) => useSession.setState({ notice: { message: cleanError(e), tone: 'error' } }))

export function useFileExternal(handleId: string | null, path: string | null): PaneExternal {
  const gone = useFileMissing(handleId, path)
  return {
    label: 'Open in editor',
    disabledReason: gone ? 'The file no longer exists.' : undefined,
    onOpen: () => (handleId && path ? openEditor(handleId, path) : undefined)
  }
}

export function GoToLineButton({ handleId, path }: { handleId: string; path: string | null }): JSX.Element {
  const off = useFileStatus(handleId, path) !== 'text'
  return (
    <button
      type="button"
      data-ui="file-goto"
      aria-label="Go to line"
      title={off ? 'This file has no lines to go to' : 'Go to line ⌘L'}
      aria-keyshortcuts="Meta+L"
      aria-disabled={off || undefined}
      onClick={() => !off && window.dispatchEvent(new Event(GOTO_EVENT))}
      className={`${PANE_BTN} aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:pointer-fine:hover:bg-transparent aria-disabled:pointer-fine:hover:text-dim`}
    >
      <IconHash className="h-4 w-4" />
    </button>
  )
}

type Doc =
  | { t: 'loading' }
  | { t: 'text'; text: string; lines: string[]; revision: string; truncated: boolean }
  | { t: 'binary' }
  | { t: 'missing' }
  | { t: 'error'; reason: Refusal['reason']; message: string }

type Item =
  | { t: 'line'; n: number }
  | { t: 'chip'; key: string; hunk?: string; text: string; label: string; more: string }
  | { t: 'pointed'; start: number; end: number }
  | { t: 'banner'; end: boolean }
  | { t: 'notice' }
  | { t: 'unmarked' }

type Lines = { start: number; end: number }

/** Where each of a's lines sits in b when it survives unchanged, else -1; null when the diff runs too long. */
function survivors(a: string, b: string): Int32Array | null {
  const changes = diffLines(a, b, { timeout: REMAP_MS })
  return changes ? survivingLines(changes, toLines(a).length) : null
}

const rangeText = (r: Lines, sep: string): string => (r.start === r.end ? `line ${r.start}` : `lines ${r.start}${sep}${r.end}`)

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
  const tab = useActive((s) => s?.surfaces.tabs[tabId])
  // Only a tab restored from the sidecar can have lost a grant, and only it offers Close tab in its error states.
  const restored = useActive((s) => !!tab && restoredTab(s, tab))
  const path = tab?.key ?? ''
  const cwd = useActive((s) => s?.cwd ?? null)
  const busy = useActive((s) => !!s?.busy)
  const change = useActive((s) => s?.changes.find((c) => c.path === path) ?? null)
  const setView = useSession((s) => s.setSurfaceView)
  const openSurface = useSession((s) => s.openSurface)
  const name = baseOf(path)
  const rel = toWorkspaceRelative(cwd, path)
  const lang = langForPath(path)
  const selection = tab?.selection?.lines ?? null
  const highlight = tab?.highlight?.lines ?? null
  const location = tab?.location

  const [doc, setDoc] = useState<Doc>({ t: 'loading' })
  const docRef = useRef(doc)
  docRef.current = doc
  const selRef = useRef(selection)
  selRef.current = selection
  const selVersion = useRef(tab?.selection?.sourceVersion)
  selVersion.current = tab?.selection?.sourceVersion
  const busyRef = useRef(busy)
  busyRef.current = busy
  const [slow, setSlow] = useState(false)
  /** `removed`: the selection was in a message too, and left it. */
  const [notice, setNotice] = useState<'cleared' | 'removed' | null>(null)
  const [watchGen, setWatchGen] = useState(0)
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
  const range = useRef({ start: 0, end: 0 })
  const anchor = useRef<number | null>(null)
  const active = useRef<number | null>(null)
  const keepLine = useRef<number | null>(null)
  const openVia = useRef<Via>('keyboard')
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
  const [said, setSaid] = useState('')
  const sayCount = useRef(0)
  // A zero-width space toggles so an identical announcement still changes the live region.
  const say = (t: string): void => setSaid(`${t}${'\u200B'.repeat(++sayCount.current % 2)}`)

  // Whether the selection, at this revision, is a reference in the draft or a queued message.
  const attachKey = selection && doc.t === 'text' ? `${selection.start}-${selection.end}\0sha256:${doc.revision}` : null
  const isThis = ({ ref: r }: DraftReference): boolean =>
    !!attachKey && r.kind === 'file' && r.path === path && !!r.lines && `${r.lines.start}-${r.lines.end}\0${r.sourceVersion}` === attachKey
  const attached = useActive((s) => !!s && [s.contextRefs, ...s.queuedMessages.map((q) => q.refs)].some((l) => l.some(isThis)))
  // The bar speaks for where an add lands, which may be one queued message while another holds the selection.
  const inTarget = useActive((s) => !!s && !!refsOf(s, s.referenceEditTarget)?.some(isThis))
  const attachedRef = useRef(attached)
  attachedRef.current = attached
  const selSay = useRef<ReturnType<typeof setTimeout>>()
  const addSelection = (): void => {
    if (!selection || doc.t !== 'text') return
    // An add right after selecting must not be talked over by the trailing selection announcement.
    clearTimeout(selSay.current)
    addFromSurface(handleId, { kind: 'file', path, lines: selection, sourceVersion: `sha256:${doc.revision}` }, say)
  }
  const refsHere = useActive((s) => (s ? [s.contextRefs, ...s.queuedMessages.map((q) => q.refs)].flat().filter(({ ref: r }) => r.kind === 'file' && r.path === path && !!r.lines).length : 0))
  // The store removes a stale reference and clears its selection in one step, so both vanishing together means
  // the change reached the store before this tab's own re-read.
  const prevHere = useRef({ selection, refsHere })
  useEffect(() => {
    const prev = prevHere.current
    prevHere.current = { selection, refsHere }
    if (prev.selection && !selection && refsHere < prev.refsHere) setNotice('removed')
  }, [selection, refsHere])

  const setSelection = useCallback(
    (lines: Lines | null) => {
      setNotice(null)
      const d = docRef.current
      setView(handleId, tabId, { selection: lines && d.t === 'text' ? { lines, sourceVersion: `sha256:${d.revision}` } : undefined, highlight: undefined })
    },
    [handleId, tabId, setView]
  )

  // Reads and re-reads; a re-read carries the selection onto the new text.
  const lastLoad = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const load = useCallback(async (): Promise<void> => {
    lastLoad.current = Date.now()
    const r = await window.clui.readText(handleId, path).catch((e: unknown) => ({ ok: false as const, reason: 'unreadable' as const, message: cleanError(e) }))
    noteRead(handleId, path, r.ok ? null : r.reason)
    const prev = docRef.current
    let next: Doc
    if (!r.ok) next = r.reason === 'missing' ? { t: 'missing' } : { t: 'error', reason: r.reason, message: 'message' in r ? r.message : REASON[r.reason] }
    else if (r.binary || r.unsupportedEncoding) next = { t: 'binary' }
    else if (prev.t === 'text' && prev.revision === r.revision) return
    else next = { t: 'text', text: r.text, lines: toLines(r.text), revision: r.revision, truncated: r.truncated }
    setStatus(`${handleId}\0${path}`, next.t)
    if (prev.t === 'text' && next.t === 'text') {
      keepLine.current = range.current.start > 0 ? topLine() : null
      const sel = selRef.current
      // A selection that is in a message clears on any change, with no remap.
      if (sel && attachedRef.current) {
        setView(handleId, tabId, { selection: undefined })
        setNotice('removed')
        say('The lines you selected changed on disk, so the selection was cleared and removed from the message.')
      } else if (sel) {
        const map = survivors(prev.text, next.text)
        const start = map?.[sel.start - 1] ?? -1
        const whole = start >= 0 && Array.from({ length: sel.end - sel.start + 1 }, (_, i) => map![sel.start - 1 + i]).every((m, i) => m === start + i)
        if (whole) setView(handleId, tabId, { selection: { lines: { start: start + 1, end: start + 1 + sel.end - sel.start }, sourceVersion: `sha256:${next.revision}` } })
        else {
          setView(handleId, tabId, { selection: undefined })
          setNotice('cleared')
          say("The lines you selected changed on disk, so the selection was cleared.")
        }
      }
    } else if (next.t === 'text' && selRef.current && selVersion.current && selVersion.current !== `sha256:${next.revision}`) {
      // A remounted tab has no earlier text to remap from; its selection was made against the revision it stored.
      setView(handleId, tabId, { selection: undefined })
      setNotice('cleared')
      say('The lines you selected changed on disk, so the selection was cleared.')
    }
    setDoc(next)
  }, [handleId, path, tabId, setView])

  const scheduleLoad = useCallback(() => {
    if (timer.current) return
    const wait = busyRef.current ? Math.max(0, TURN_RELOAD_MS - (Date.now() - lastLoad.current)) : 0
    timer.current = setTimeout(() => {
      timer.current = null
      void load()
    }, wait)
  }, [load])

  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SKELETON_MS)
    void load().finally(() => clearTimeout(t))
    return () => {
      clearTimeout(t)
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      setStatus(`${handleId}\0${path}`, null)
    }
  }, [load, handleId, path])

  // Watched while shown. Watch events are hints, so focus also reconciles.
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

  // A missing file comes back on its own: polled, then re-read and watched again.
  useEffect(() => {
    if (doc.t !== 'missing') return
    const t = setInterval(() => {
      void window.clui.statFile(handleId, path).then((s) => {
        if (!s.ok) return
        void load()
        setWatchGen((n) => n + 1)
      })
    }, MISSING_POLL_MS)
    return () => clearInterval(t)
  }, [doc.t, handleId, path, load])

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

  const docLines = doc.t === 'text' ? doc.lines : null
  const count = docLines?.length ?? 0

  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query)
  const [current, setCurrent] = useState(0)
  const findInput = useRef<HTMLInputElement>(null)
  const found = useMemo(() => {
    const q = bar === 'find' ? deferred.toLowerCase() : ''
    const all: { n: number; s: number; e: number }[] = []
    let more = false
    if (!q || !docLines) return { all, more }
    outer: for (let i = 0; i < docLines.length; i++) {
      const l = docLines[i].toLowerCase()
      for (let at = l.indexOf(q); at >= 0; at = l.indexOf(q, at + q.length)) {
        if (all.length === FIND_MAX) {
          more = true
          break outer
        }
        all.push({ n: i + 1, s: at, e: at + q.length })
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
    if (notice) items.push({ t: 'notice' })
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
  }, [doc, count, valid, notice, highlight])

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
  const restoreAt = useMemo(() => (tab?.viewState?.kind === 'file' && !location?.line ? tab.viewState.topLine : 1), [])
  const viewTimer = useRef<ReturnType<typeof setTimeout>>()
  const saveTop = (): void => {
    if (docRef.current.t !== 'text') return
    const n = topLine()
    const v = useSession.getState().sessions[handleId]?.surfaces.tabs[tabId]?.viewState
    if (v?.kind === 'file' && v.topLine === n) return
    setView(handleId, tabId, { viewState: { kind: 'file', topLine: n, offsetPx: 0, scrollLeft: 0, previewScrollTop: 0 } })
  }
  useEffect(
    () => () => {
      clearTimeout(viewTimer.current)
      saveTop()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // The selection's announcement trails the keys that make it.
  const hadSelection = useRef(false)
  const selKey = selection ? `${selection.start}-${selection.end}` : ''
  useEffect(() => {
    if (!selection && !hadSelection.current) return
    hadSelection.current = !!selection
    const t = (selSay.current = setTimeout(() => say(selection ? `${selection.start === selection.end ? 'Line' : 'Lines'} ${rangeText(selection, ' to ').replace(/^lines? /, '')} selected` : 'Selection cleared'), ANNOUNCE_MS))
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey])

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

  const onRegionKey = (e: KeyboardEvent): void => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && selection) {
      e.preventDefault()
      return addSelection()
    }
    if (e.key === 'Escape') {
      if (!selection && !highlight) return
      e.preventDefault()
      return setSelection(null)
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

  // Go to line and find share the docked bar; opening one closes the other.
  const gotoInput = useRef<HTMLInputElement>(null)
  const [gotoText, setGotoText] = useState('')
  const [gotoBad, setGotoBad] = useState(false)
  const returnTo = useRef<HTMLElement | null>(null)
  const openBar = useCallback((which: 'find' | 'goto') => {
    if (!returnTo.current) returnTo.current = document.activeElement as HTMLElement | null
    setBar(which)
    requestAnimationFrame(() => {
      const el = which === 'find' ? findInput.current : gotoInput.current
      el?.focus()
      el?.select()
    })
  }, [])
  const closeBar = (refocus: 'region' | 'back'): void => {
    setBar(null)
    setGotoBad(false)
    const back = returnTo.current
    returnTo.current = null
    requestAnimationFrame(() => (refocus === 'back' && back?.isConnected ? back : bodyEl.current)?.focus())
  }

  const stepFind = useCallback(
    (by: number) => {
      const total = found.all.length
      if (!total) return
      const next = (((current + by) % total) + total) % total
      setCurrent(next)
      const n = found.all[next].n
      if (lineIndex[n] < range.current.start || lineIndex[n] > range.current.end) toLine(n, 'center')
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [found, current, lineIndex]
  )
  useEffect(() => setCurrent(0), [deferred])

  useEffect(() => {
    const inPane = (): boolean => !!document.activeElement?.closest('[data-ui="pane-secondary"]')
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey || e.key.toLowerCase() !== 'l' || !inPane()) return
      e.preventDefault()
      if (docRef.current.t === 'text') openBar('goto')
    }
    const onGoto = (): void => {
      if (docRef.current.t === 'text') openBar('goto')
    }
    const onFind = (e: Event): void => {
      const what = (e as CustomEvent<string>).detail
      if (what === 'close') {
        if (bar === 'find') {
          setQuery('')
          setBar(null)
        }
        return
      }
      if (docRef.current.t !== 'text') return
      if (what === 'open' || bar !== 'find') return openBar('find')
      stepFind(what === 'prev' ? -1 : 1)
    }
    document.addEventListener('keydown', onKey)
    window.addEventListener(GOTO_EVENT, onGoto)
    window.addEventListener(FILE_FIND_EVENT, onFind)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener(GOTO_EVENT, onGoto)
      window.removeEventListener(FILE_FIND_EVENT, onFind)
    }
  }, [openBar, stepFind, bar])

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
              onMouseDown={(e) => e.shiftKey && e.preventDefault()}
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
      case 'banner':
        return (
          <div className="flex min-h-8 items-center gap-2 bg-tool px-3 text-meta text-dim">
            {it.end ? "The rest of the file isn't shown." : `Showing the first ${truncatedLines}. The file is too large to show in full.`}
            <button type="button" className={TEXT_BTN} onClick={() => void openEditor(handleId, path)}>
              Open in editor
            </button>
          </div>
        )
      case 'unmarked':
        return (
          <div className="flex min-h-8 items-center gap-2 bg-tool px-3 text-meta text-dim">
            Claude changed this file, but it has changed since, so no lines are marked.
            <button type="button" className={TEXT_BTN} onClick={(e) => viewChange(undefined, viaOf(e))}>
              View changes
            </button>
          </div>
        )
      case 'notice':
        return (
          <div className="flex h-8 items-center gap-2 px-3 text-meta text-dim">
            {notice === 'removed'
              ? 'The lines you selected changed on disk, so the selection was cleared and removed from the message.'
              : 'The lines you selected changed on disk, so the selection was cleared.'}
            <button type="button" className={TEXT_BTN} onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </div>
        )
    }
  }

  const closeButton = restored ? (
    <Button variant="secondary" size="sm" onClick={() => closeTab(tabId, true)}>
      Close tab
    </Button>
  ) : null
  // Main grants only the file the dialog returns, so a different pick opens as its own tab.
  const chooseAgain = async (): Promise<void> => {
    const picked = await window.clui.chooseSurfaceFile(handleId, path).catch(() => null)
    if (!picked) return
    if (picked !== path) return void openSurface(handleId, { kind: 'file', key: picked, title: baseOf(picked) }, 'focus', 'user', 'user')
    void load()
    setWatchGen((n) => n + 1)
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
  } else if (doc.t === 'binary') {
    content = (
      <div className={STATE_BODY}>
        <p className="text-ui font-medium text-content">Binary file</p>
        <p className="max-w-[60ch] text-meta text-dim">{`${name} can't be shown as text.`}</p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            void window.clui.openPath(handleId, path).then((r) => {
              if (!r.ok) useSession.setState({ notice: { message: r.message, tone: 'error' } })
            })
          }
        >
          Open in default app
        </Button>
      </div>
    )
  } else if (doc.t === 'missing') {
    content = (
      <div className={STATE_BODY}>
        <p className="text-ui font-medium text-content">File not found</p>
        <p className="max-w-[60ch] text-meta text-dim">{`${rel} isn't on disk anymore. It may have been moved or deleted.`}</p>
        {(change || restored) && (
          <div className="flex gap-2">
            {change && (
              <Button variant="secondary" size="sm" onClick={(e) => viewChange(undefined, viaOf(e))}>
                {"View Claude's changes"}
              </Button>
            )}
            {closeButton}
          </div>
        )}
      </div>
    )
  } else if (doc.t === 'error' && doc.reason === 'denied' && restored) {
    content = (
      <div className={STATE_BODY}>
        <p className="text-ui font-medium text-content">{`Open ${name} again to view it`}</p>
        <p className="max-w-[60ch] text-meta text-dim">{`It's outside ${baseOf(cwd ?? '')}, and Clui only reopens outside files you choose again yourself.`}</p>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={() => void chooseAgain()}>
            {CHOOSE}
          </Button>
          {closeButton}
        </div>
      </div>
    )
  } else if (doc.t === 'error') {
    content = (
      <div className={STATE_BODY}>
        <p className="text-ui font-medium text-content">{`Couldn't read ${name}`}</p>
        {doc.message && <p className="max-w-[60ch] text-meta text-dim">{doc.message}</p>}
        <div className="flex gap-2 empty:hidden">
          {RETRY.has(doc.reason) || (restored && doc.reason === 'permission') ? (
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              Try again
            </Button>
          ) : doc.reason === 'too-large' ? (
            <Button variant="secondary" size="sm" onClick={() => void openEditor(handleId, path)}>
              Open in editor
            </Button>
          ) : null}
          {closeButton}
        </div>
      </div>
    )
  } else if (scroller) {
    content = (
      <Virtuoso
        ref={virtuoso}
        customScrollParent={scroller}
        data={items}
        initialTopMostItemIndex={lineIndex[Math.max(1, Math.min(count, restoreAt))] ?? 0}
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
        onKeyDown={onRegionKey}
        onMouseUp={onMouseUp}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {content}
      </div>
      {barShown && selection && <SelectionBar label={selectedText(selection)} attached={inTarget} onAdd={addSelection} />}
      <span className="sr-only" aria-live="polite">
        {said}
      </span>
    </div>
  )
}
