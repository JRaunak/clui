import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { restoredTab, useActive, useSession, EMPTY_CHANGES } from '../../store'
import type { ContextMenuItem, Refusal } from '../../../../shared/files'
import type { FileChangeSummary } from '../../../../shared/changes'
import { Button } from '../Button'
import { FileIcon } from '../FileIcon'
import { IconChevron, IconDiff } from '../Icon'
import { describe, Figure, figureWidth, MINUS } from '../ChangedFiles'
import type { PaneExternal } from './PaneHeader'
import { openEditor } from './fileDoc'
import { ancestorsOf, changeIndex, flatten, nameOf, parentOf, sortEntries, survivor, tilde, typeahead, vetExpanded, type DirState, type TreeRow } from '../../lib/tree'
import { requestSurfaceFocus, takeSurfaceFocus } from '../../lib/surfaceFocus'
import { reducedMotion, viaOf, type Via } from '../../lib/motion'
import { closeTab } from './SurfaceTabs'
import { addFromSurface } from '../ContextChips'

const TAB = 'tree'
const SKELETON_MS = 400
const TYPEAHEAD_MS = 500
const FLASH_MS = 720
/** The window's unload never unmounts the tree, so its scroll saves once it settles. */
const VIEW_SETTLE_MS = 250
const EXPANDED_MAX = 200
// Below main's 32 per session: a File tab's watch can be set up while the tree's are still being torn down.
const WATCH_MAX = 28
const SKELETON = [38, 52, 30, 61, 44, 35, 57, 41, 48, 33]
const REVEAL_EVENT = 'clui:tree-reveal'
const NAV = new Set(['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])
const STATE_BODY = 'flex flex-col items-start gap-2 px-4 py-6'
const ROW = 'relative isolate flex h-6 cursor-default select-none items-center gap-1.5 pr-2'
const RING = 'group-focus-visible/tree:data-focused:outline-2 group-focus-visible/tree:data-focused:-outline-offset-2 group-focus-visible/tree:data-focused:outline-ring'
const SELECTED =
  'aria-selected:bg-control-hover aria-selected:before:absolute aria-selected:before:inset-y-1 aria-selected:before:left-0 aria-selected:before:w-0.5 aria-selected:before:rounded-full aria-selected:before:bg-content'
const LINK = 'text-content underline decoration-dim underline-offset-2'

const SHORT: Record<Refusal['reason'], string> = {
  invalid: "the path isn't valid",
  denied: "it's outside this session's folder",
  missing: "it's no longer on disk",
  'wrong-type': "it isn't a folder",
  changed: 'it changed while it was being read',
  'too-large': "it's too large",
  limit: 'too many folders are open',
  unreadable: "it couldn't be read",
  permission: "macOS didn't let Clui read it",
  unavailable: "Clui can't read folders safely on this system",
  'too-broad': 'session folder is home or above'
}
const sentence = (s: string): string => `${s[0].toUpperCase()}${s.slice(1)}.`

const idOf = (key: string): string => `tree-${encodeURIComponent(key)}`
const indent = (depth: number): CSSProperties => ({ paddingLeft: `calc(0.5rem + ${Math.min(depth, 16)} * 0.75rem)` })
const baseOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1) || p

type Entry = Extract<TreeRow, { t: 'entry' }>

/** Sessions whose tree has reopened its saved folders, after which a remount reopens what the user left open. */
const vetted = new Set<string>()

export function treeExternal(handleId: string | null, cwd: string | null): PaneExternal {
  return { label: 'Open folder in editor', onOpen: () => (handleId && cwd ? openEditor(handleId, cwd) : undefined) }
}

type Reveal = { path: string; via: Via; open?: boolean }
let pendingReveal: Reveal | null = null

/** Lands the tree on `path`, opening it too when `open` and it's a folder. A tree that isn't mounted yet takes it on mount. */
export function revealInTree(path: string, via: Via, open = false): void {
  pendingReveal = { path, via, open }
  window.dispatchEvent(new CustomEvent(REVEAL_EVENT, { detail: pendingReveal }))
}

/**
 * The session's folder as a navigator: a flat, virtualized WAI-ARIA tree. Folders list on expand
 * and stay watched while shown; Git-ignored and hidden entries are dimmed, never hidden. Claude's
 * changes mark their files and every folder above them.
 */
export function TreeSurface({ handleId, cwd }: { handleId: string; cwd: string }): JSX.Element {
  const changes = useActive((s) => s?.changes ?? EMPTY_CHANGES)
  const selectedPath = useActive((s) => s?.surfaces.tabs[TAB]?.location?.file ?? null)
  const setView = useSession((s) => s.setSurfaceView)
  const openSurface = useSession((s) => s.openSurface)
  const [restored] = useState(() => {
    const slice = useSession.getState().sessions[handleId] ?? null
    const tab = slice?.surfaces.tabs[TAB]
    const v = tab?.viewState
    const fromSidecar = !!tab && restoredTab(slice, tab)
    return { view: v?.kind === 'tree' ? v : null, fromSidecar, vet: fromSidecar && !vetted.has(handleId) }
  })
  // Saved folders reopen level by level as their parents list, so an ignored or hidden one is never opened.
  const [vetting, setVetting] = useState<string[]>(() => (restored.vet ? (restored.view?.expanded ?? []) : []))
  const [expanded, setExpanded] = useState<string[]>(() => (restored.vet ? [] : (restored.view?.expanded ?? [])))
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [focused, setFocused] = useState<string | null>(null)
  const [wash, setWash] = useState<{ key: string; via: Via } | null>(null)
  const [said, setSaid] = useState('')
  const sayCount = useRef(0)
  const say = (t: string): void => setSaid(`${t}${'\u200B'.repeat(++sayCount.current % 2)}`)
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const treeEl = useRef<HTMLDivElement | null>(null)
  const treeRef = useCallback((el: HTMLDivElement | null) => {
    treeEl.current = el
    setScroller(el)
  }, [])
  const virtuoso = useRef<VirtuosoHandle>(null)
  const typed = useRef({ text: '', at: 0 })
  // One listing in flight per folder; a change during it queues one more, so bursts coalesce, check-ignore spawns included.
  const inflight = useRef(new Map<string, { again: boolean }>())
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => void (live.current = false)
  }, [])

  const name = baseOf(cwd)
  const abs = (rel: string): string => (rel ? `${cwd}/${rel}` : cwd)
  const relOf = (p: string): string | null => (p === cwd ? '' : p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : null)
  const selected = selectedPath === null ? null : relOf(selectedPath)

  const load = useCallback(
    async (rel: string, first: boolean): Promise<void> => {
      const busy = inflight.current.get(rel)
      if (busy) return void (busy.again = true)
      const run = { again: false }
      inflight.current.set(rel, run)
      let timer: ReturnType<typeof setTimeout> | undefined
      if (first) {
        setDirs((d) => ({ ...d, [rel]: { t: 'loading', slow: false } }))
        timer = setTimeout(() => setDirs((d) => (d[rel]?.t === 'loading' ? { ...d, [rel]: { t: 'loading', slow: true } } : d)), SKELETON_MS)
      }
      const r = await window.clui.listDir(handleId, rel).catch((): Refusal => ({ ok: false, reason: 'unreadable' }))
      clearTimeout(timer)
      inflight.current.delete(rel)
      if (!live.current) return
      setDirs((d) => ({ ...d, [rel]: r.ok ? { t: 'ok', entries: sortEntries(r.entries), total: r.total, totalCapped: r.totalCapped } : { t: 'error', reason: r.reason } }))
      if (run.again) void loadRef.current(rel, false)
    },
    [handleId]
  )

  const loadRef = useRef(load)
  loadRef.current = load

  const open = useMemo(() => new Set(expanded), [expanded])
  // Expanded folders under a collapsed one keep their place in `expanded` but aren't listed or watched.
  const shown = useMemo(() => expanded.filter((rel) => ancestorsOf(rel).every((a) => open.has(a))), [expanded, open])
  useEffect(() => {
    for (const rel of ['', ...shown]) if (!dirs[rel]) void load(rel, true)
  }, [shown, dirs, load])
  useEffect(() => {
    if (!vetting.length) {
      if (restored.vet) vetted.add(handleId)
      return
    }
    const { admit, wait } = vetExpanded(vetting, open, dirs)
    if (admit.length) setExpanded((e) => [...e, ...admit])
    if (wait.length !== vetting.length) setVetting(wait)
  }, [vetting, open, dirs, restored.vet, handleId])

  const scrollTop = useRef(restored.view?.scrollTop ?? 0)
  useEffect(() => {
    setView(handleId, TAB, { viewState: { kind: 'tree', expanded: [...expanded, ...vetting], scrollTop: scrollTop.current } })
  }, [expanded, vetting, handleId, setView])
  const scrollTimer = useRef<ReturnType<typeof setTimeout>>()
  const saveScroll = useCallback(() => {
    const v = useSession.getState().sessions[handleId]?.surfaces.tabs[TAB]?.viewState
    if (v?.kind === 'tree' && v.scrollTop !== scrollTop.current) setView(handleId, TAB, { viewState: { ...v, scrollTop: scrollTop.current } })
  }, [handleId, setView])
  useEffect(
    () => () => {
      clearTimeout(scrollTimer.current)
      saveScroll()
    },
    [saveScroll]
  )

  // Watch the root and the most recently expanded shown folders. Events are hints; a window focus re-lists every shown folder,
  // including those past the watch cap.
  const watchKey = ['', ...shown.slice(-(WATCH_MAX - 1))].join('\0')
  const watches = useRef(new Map<string, string | null>())
  const shownRef = useRef(shown)
  shownRef.current = shown
  useEffect(() => {
    const off = window.clui.onFileChanged((e) => {
      if (e.handleId !== handleId) return
      for (const [rel, id] of watches.current) if (id === e.id) void load(rel, false)
    })
    const refresh = (): void => {
      for (const rel of ['', ...shownRef.current]) void load(rel, false)
    }
    window.addEventListener('focus', refresh)
    return () => {
      off()
      window.removeEventListener('focus', refresh)
    }
  }, [handleId, load])
  useEffect(() => {
    const want = new Set(watchKey.split('\0'))
    const w = watches.current
    for (const [rel, id] of w) {
      if (want.has(rel)) continue
      w.delete(rel)
      if (id) void window.clui.unwatchFile(handleId, id)
    }
    for (const rel of want) {
      if (w.has(rel)) continue
      w.set(rel, null)
      void window.clui.watchDir(handleId, rel).then((r) => {
        if (!r.ok) return
        if (w.get(rel) === null && live.current) w.set(rel, r.id)
        else void window.clui.unwatchFile(handleId, r.id)
      })
    }
  }, [watchKey, handleId])
  useEffect(
    () => () => {
      for (const id of watches.current.values()) if (id) void window.clui.unwatchFile(handleId, id)
      watches.current.clear()
    },
    [handleId]
  )

  const rows = useMemo(() => flatten(dirs, open), [dirs, open])
  const index = useMemo(() => new Map(rows.map((r, i) => [r.key, i])), [rows])
  const marks = useMemo(() => changeIndex(changes, cwd), [changes, cwd])
  const columns = {
    '--add-ch': `${Math.max(1, ...changes.map((c) => figureWidth(c.added) + (c.approximate ? 1 : 0)))}ch`,
    '--del-ch': `${Math.max(1, ...changes.map((c) => figureWidth(c.removed)))}ch`
  } as CSSProperties

  const focusRow = (key: string, align?: 'center'): void => {
    setFocused(key)
    const i = index.get(key)
    if (i === undefined) return
    if (align) virtuoso.current?.scrollToIndex({ index: i, align, behavior: 'auto' })
    else virtuoso.current?.scrollIntoView({ index: i, behavior: 'auto' })
  }
  const select = (rel: string): void => setView(handleId, TAB, { location: { file: abs(rel) } })

  // The first listing places focus on the selection, else the top.
  const placed = useRef(false)
  useLayoutEffect(() => {
    if (!placed.current && dirs['']?.t === 'ok' && scroller) {
      placed.current = true
      const start = selected !== null && index.has(selected) ? selected : (rows[0]?.key ?? null)
      if (start) setFocused(start)
      const i = start === null ? undefined : index.get(start)
      if (!restored.view?.scrollTop && i) virtuoso.current?.scrollToIndex({ index: i, align: 'center' })
      if (takeSurfaceFocus(TAB)) treeEl.current?.focus({ preventScroll: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirs, scroller])

  // A listing that drops the focused row hands focus to a neighbour; a selected file gone from its folder is deselected.
  const prevRows = useRef(rows)
  useLayoutEffect(() => {
    const prev = prevRows.current
    prevRows.current = rows
    if (focused !== null && !index.has(focused)) setFocused(survivor(prev, rows, focused))
    if (selected) {
      const d = dirs[parentOf(selected)]
      if (d?.t === 'ok' && !d.entries.some((e) => e.name === nameOf(selected))) setView(handleId, TAB, { location: undefined })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])

  const toggle = (r: Entry, to = !r.open): void => {
    if (to === r.open) return
    // A folder listed before may have changed while it was closed and unwatched.
    if (to && dirs[r.rel]) void load(r.rel, false)
    setExpanded((prev) => (to ? [...prev.filter((x) => x !== r.rel), r.rel].slice(-EXPANDED_MAX) : prev.filter((x) => x !== r.rel)))
  }

  const openFile = (rel: string, via: Via): void => {
    const path = abs(rel)
    select(rel)
    requestSurfaceFocus(`file:${path}`, via)
    openSurface(handleId, { kind: 'file', key: path, title: nameOf(rel) }, 'focus', 'user', 'user')
  }
  const viewChanges = (path: string): void => {
    requestSurfaceFocus('diff')
    openSurface(handleId, { kind: 'diff', key: '', title: 'Claude changes', location: { file: path } }, 'focus', 'user', 'user')
  }
  const reveal = async (rel: string): Promise<void> => {
    const r = await window.clui.revealPath(handleId, abs(rel)).catch(() => ({ ok: false as const, message: `Couldn't show ${nameOf(rel) || name} in Finder.` }))
    if (!r.ok) useSession.setState({ notice: { message: r.message, tone: 'error' } })
  }

  const activate = (r: TreeRow, via: Via): void => {
    if (r.t === 'error') return void load(r.parent, true)
    if (r.t === 'more') return void reveal(r.parent)
    if (r.t !== 'entry') return
    if (r.dir) {
      select(r.rel)
      return toggle(r)
    }
    openFile(r.rel, via)
  }

  const changedUnder = (r: Entry): string | null => (r.dir ? (marks.dirs.get(r.rel) ?? null) : marks.files.has(r.rel) ? abs(r.rel) : null)

  const showMenu = async (r: Entry, at?: { x: number; y: number }): Promise<void> => {
    select(r.rel)
    setFocused(r.key)
    const target = changedUnder(r)
    const items: ContextMenuItem[] = [
      ...(r.dir ? [] : [{ type: 'normal' as const, id: 'open', label: 'Open', enabled: true }]),
      { type: 'normal', id: 'add', label: 'Add to Message', enabled: true },
      { type: 'separator' },
      { type: 'normal', id: 'editor', label: 'Open in Editor', enabled: true },
      { type: 'normal', id: 'finder', label: 'Reveal in Finder', enabled: true },
      { type: 'separator' },
      { type: 'normal', id: 'copy', label: 'Copy Path', enabled: true },
      { type: 'normal', id: 'copy-relative', label: 'Copy Relative Path', enabled: true },
      ...(target ? [{ type: 'separator' as const }, { type: 'normal' as const, id: 'changes', label: "View Claude's Changes", enabled: true }] : [])
    ]
    const id = await window.clui.showContextMenu(items, at).catch(() => null)
    if (!live.current) return
    const copy = (text: string): void =>
      void navigator.clipboard.writeText(text).then(
        () => say('Path copied'),
        () => useSession.setState({ notice: { message: "Couldn't copy the path. Try again.", tone: 'error' } })
      )
    if (id === 'open') openFile(r.rel, at ? 'keyboard' : 'pointer')
    else if (id === 'add') addFromSurface(handleId, r.dir ? { kind: 'folder', path: abs(r.rel) } : { kind: 'file', path: abs(r.rel) }, say)
    else if (id === 'editor') void openEditor(handleId, abs(r.rel))
    else if (id === 'finder') void reveal(r.rel)
    else if (id === 'copy') copy(abs(r.rel))
    else if (id === 'copy-relative') copy(r.rel)
    else if (id === 'changes' && target) viewChanges(target)
  }

  // Reveal expands the target's folders, ignored or hidden ones included, then lands on its row once it's listed.
  // The file the tree took over from lands quietly: selected and scrolled to, focus and announcements untouched.
  const revealing = useRef<{ rel: string; via: Via; quiet: boolean } | null>(null)
  useEffect(() => {
    const take = ({ path, via, open }: Reveal, quiet = false): void => {
      pendingReveal = null
      const rel = relOf(path)
      if (!rel) return
      revealing.current = { rel, via, quiet }
      const need = open ? [...ancestorsOf(rel), rel] : ancestorsOf(rel)
      setExpanded((prev) => [...prev.filter((x) => !need.includes(x)), ...need].slice(-EXPANDED_MAX))
    }
    const onReveal = (e: Event): void => take((e as CustomEvent<Reveal>).detail)
    const from = useSession.getState().sessions[handleId]?.surfaces.tabs[TAB]?.reveal
    if (from) setView(handleId, TAB, { reveal: undefined })
    // A folder link's explicit reveal outranks the file the tree took over from.
    if (pendingReveal) take(pendingReveal)
    else if (from) take({ path: from, via: 'keyboard' }, true)
    window.addEventListener(REVEAL_EVENT, onReveal)
    return () => window.removeEventListener(REVEAL_EVENT, onReveal)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd])
  useLayoutEffect(() => {
    const want = revealing.current
    if (!want) return
    if (!index.has(want.rel)) {
      const settled = [...ancestorsOf(want.rel), parentOf(want.rel)].every((a) => dirs[a] && dirs[a].t !== 'loading')
      if (!settled) return
      // Every folder on the way is listed and the file isn't there: land on the deepest folder that is.
      revealing.current = null
      if (want.quiet) return
      say(`${nameOf(want.rel)} isn't in the tree.`)
      const near = ancestorsOf(want.rel).findLast((a) => index.has(a))
      if (near) land(near, want.via)
      else treeEl.current?.focus({ preventScroll: true })
      return
    }
    revealing.current = null
    if (want.quiet) {
      select(want.rel)
      return focusRow(want.rel)
    }
    land(want.rel, want.via)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows])
  useEffect(() => {
    if (!wash) return
    const t = setTimeout(() => setWash(null), FLASH_MS)
    return () => clearTimeout(t)
  }, [wash])

  function land(rel: string, via: Via): void {
    select(rel)
    focusRow(rel, 'center')
    treeEl.current?.focus({ preventScroll: true })
    setWash({ key: rel, via: via === 'pointer' && !reducedMotion() ? 'pointer' : 'keyboard' })
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    const i = focused === null ? -1 : (index.get(focused) ?? -1)
    const r = rows[i]
    if (!r) {
      if (rows.length && NAV.has(e.key)) {
        e.preventDefault()
        focusRow(rows[0].key)
      }
      return
    }
    if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
      e.preventDefault()
      if (r.t !== 'entry') return
      const box = document.getElementById(idOf(r.key))?.getBoundingClientRect()
      return void showMenu(r, box ? { x: Math.round(box.left), y: Math.round(box.bottom) } : undefined)
    }
    if (e.key === 'Enter' && e.metaKey) {
      e.preventDefault()
      if (r.t === 'entry') void openEditor(handleId, abs(r.rel))
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const to = (j: number): void => {
      e.preventDefault()
      const k = rows[Math.max(0, Math.min(rows.length - 1, j))]
      if (k) focusRow(k.key)
    }
    switch (e.key) {
      case 'ArrowDown':
        return to(i + 1)
      case 'ArrowUp':
        return to(i - 1)
      case 'Home':
        return to(0)
      case 'End':
        return to(rows.length - 1)
      case 'ArrowRight':
        e.preventDefault()
        if (r.t !== 'entry' || !r.dir) return
        if (!r.open) return toggle(r, true)
        if (rows[i + 1]?.parent === r.rel) focusRow(rows[i + 1].key)
        return
      case 'ArrowLeft':
        e.preventDefault()
        if (r.t === 'entry' && r.open) return toggle(r, false)
        if (r.parent) focusRow(r.parent)
        return
      case 'Enter':
      case ' ':
        e.preventDefault()
        return activate(r, 'keyboard')
      case '*': {
        e.preventDefault()
        const siblings = rows.filter((x): x is Entry => x.t === 'entry' && x.parent === r.parent && x.dir && !x.open && !x.own)
        if (siblings.length) setExpanded((prev) => [...prev, ...siblings.map((x) => x.rel)].slice(-EXPANDED_MAX))
        return
      }
    }
    if (e.key.length !== 1) return
    const now = Date.now()
    const t = typed.current
    t.text = now - t.at > TYPEAHEAD_MS ? e.key.toLowerCase() : t.text + e.key.toLowerCase()
    t.at = now
    const hit = typeahead(rows, i, t.text)
    if (hit >= 0) {
      e.preventDefault()
      focusRow(rows[hit].key)
    }
  }

  const onRowClick = (e: MouseEvent, r: TreeRow): void => {
    // ⌃-click is the context menu on macOS.
    if (e.ctrlKey) return
    setFocused(r.key)
    if (e.metaKey && r.t === 'entry') return void openEditor(handleId, abs(r.rel))
    activate(r, viaOf(e))
  }
  const onRowMenu = (e: MouseEvent, r: TreeRow): void => {
    e.preventDefault()
    if (r.t === 'entry') void showMenu(r)
  }

  const renderRow = (r: TreeRow): JSX.Element => {
    const common = {
      role: 'treeitem',
      id: idOf(r.key),
      'aria-level': r.depth + 1,
      'data-focused': r.key === focused || undefined,
      onClick: (e: MouseEvent) => onRowClick(e, r),
      onContextMenu: (e: MouseEvent) => onRowMenu(e, r)
    }
    if (r.t !== 'entry') {
      const label = r.t === 'error' ? `Couldn't list ${nameOf(r.parent) || name}, ${SHORT[r.reason]}. Press Enter to try again.` : undefined
      return (
        <div
          {...common}
          aria-setsize={1}
          aria-posinset={1}
          aria-disabled={r.t === 'loading' || r.t === 'empty' || undefined}
          aria-label={label}
          style={indent(r.depth)}
          className={`${ROW} ${RING} text-meta ${r.t === 'loading' || r.t === 'empty' ? 'text-faint' : 'text-dim'}`}
        >
          <span aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="min-w-0 truncate">
            {r.t === 'loading' && 'Loading'}
            {r.t === 'empty' && 'Empty folder'}
            {r.t === 'error' && (
              <>
                {`Couldn't list this folder: ${SHORT[r.reason]}. `}
                <span className={LINK}>Try again</span>
              </>
            )}
            {r.t === 'more' && (
              <>
                {`${r.shown.toLocaleString()} of ${r.total.toLocaleString()}${r.totalCapped ? '+' : ''} shown. `}
                <span className={LINK}>Reveal in Finder</span>
              </>
            )}
          </span>
        </div>
      )
    }
    const change: FileChangeSummary | undefined = r.dir ? undefined : marks.files.get(r.rel)
    const holds = r.dir && marks.dirs.has(r.rel)
    const changeLine = change ? describe(change).description : holds ? 'Contains files Claude changed.' : ''
    const dimLine =
      r.own === 'ignored'
        ? 'Ignored by Git.'
        : r.own === 'hidden'
          ? `Hidden ${r.dir ? 'folder' : 'file'}.`
          : r.dim === 'ignored'
            ? 'Inside an ignored folder.'
            : r.dim === 'hidden'
              ? 'Inside a hidden folder.'
              : ''
    const kindLine = r.special === 'link' ? 'Symbolic link.' : r.special === 'other' ? 'Special file.' : ''
    const description = [kindLine, changeLine, dimLine].filter(Boolean).join(' ')
    const busy = r.open && dirs[r.rel]?.t === 'loading'
    const hideRemoved = !!change?.created && change.removed === 0
    return (
      <div
        {...common}
        aria-setsize={r.size}
        aria-posinset={r.pos}
        aria-expanded={r.dir ? r.open : undefined}
        aria-selected={r.rel === selected || undefined}
        aria-busy={busy || undefined}
        aria-description={description || undefined}
        title={[r.rel, kindLine.slice(0, -1), dimLine.slice(0, -1), changeLine.slice(0, -1)].filter(Boolean).join('\n')}
        style={indent(r.depth)}
        className={`${ROW} ${RING} ${SELECTED} pointer-fine:hover:bg-control-hover`}
      >
        {wash?.key === r.key && (
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute inset-0 -z-10 bg-bg-raised ${wash.via === 'pointer' ? 'animate-[turn-flash-out_var(--dur-slow)_var(--ease-in)_var(--dur-stage)_both]' : ''}`}
          />
        )}
        <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center text-faint">
          {r.dir && <IconChevron className={`h-3.5 w-3.5 ${r.open ? 'rotate-90' : ''}`} />}
        </span>
        <FileIcon name={r.name} kind={r.dir ? 'folder' : 'file'} open={r.open} dim={r.lit ? 'hue' : !!r.dim} />
        <span className={`min-w-0 flex-1 truncate font-mono text-code ${r.dim ? 'text-faint' : 'text-content'}`}>{r.name}</span>
        {change?.created && (
          <span aria-hidden="true" className="shrink-0 text-meta text-dim">
            new
          </span>
        )}
        {change && (
          <span aria-hidden="true" className="flex shrink-0 gap-1.5 text-meta tabular-nums">
            <Figure n={change.added} sign="+" tone="text-ok" width="w-(--add-ch)" approx={change.approximate} />
            {hideRemoved ? <span className="inline-block w-(--del-ch)" /> : <Figure n={change.removed} sign={MINUS} tone="text-err" width="w-(--del-ch)" />}
          </span>
        )}
        {holds && <IconDiff className="h-3 w-3 shrink-0 text-dim" />}
      </div>
    )
  }

  const root = dirs['']
  let body: JSX.Element
  if (!root || root.t === 'loading') {
    body = (
      <div aria-hidden="true" className={root?.t === 'loading' && root.slow ? '' : 'invisible'}>
        {SKELETON.map((w, i) => (
          <div key={i} className={ROW} style={indent(0)}>
            <span className="h-4 w-4 shrink-0" />
            <span className="h-4 w-4 shrink-0" />
            <span className="h-3 rounded-sm bg-bg-raised" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
    )
  } else if (root.t === 'error') {
    body =
      root.reason === 'missing' ? (
        <div className={STATE_BODY}>
          <p className="text-ui font-medium text-content">Folder not found</p>
          <p className="max-w-[60ch] text-meta text-dim">{`${tilde(cwd, window.clui.homeDir)} isn't on disk anymore.`}</p>
          {restored.fromSidecar && (
            <Button variant="secondary" size="sm" onClick={() => closeTab(TAB, true)}>
              Close tab
            </Button>
          )}
        </div>
      ) : (
        <div className={STATE_BODY}>
          <p className="text-ui font-medium text-content">{`Couldn't list ${name}`}</p>
          <p className="max-w-[60ch] text-meta text-dim">{sentence(SHORT[root.reason])}</p>
          <Button variant="secondary" size="sm" onClick={() => void load('', true)}>
            Try again
          </Button>
        </div>
      )
  } else if (!root.entries.length) {
    body = (
      <div className={STATE_BODY}>
        <p className="max-w-[60ch] text-meta text-dim">{`${name} is empty.`}</p>
      </div>
    )
  } else {
    body = scroller ? (
      <Virtuoso
        ref={virtuoso}
        customScrollParent={scroller}
        data={rows}
        fixedItemHeight={24}
        initialScrollTop={restored.view?.scrollTop ?? 0}
        computeItemKey={(_i, r) => r.key}
        itemContent={(_i, r) => renderRow(r)}
      />
    ) : (
      <></>
    )
  }

  const ready = root?.t === 'ok' && root.entries.length > 0
  return (
    <div data-ui="tree-surface" className="flex h-full min-h-0 flex-col bg-bg pt-(--top-h)">
      <div
        ref={treeRef}
        data-ui="tree"
        data-beside-header=""
        data-pane-title=""
        tabIndex={ready ? 0 : -1}
        {...(ready
          ? { role: 'tree', 'aria-label': `Files in ${name}`, 'aria-activedescendant': focused !== null && index.has(focused) ? idOf(focused) : undefined }
          : { role: 'region', 'aria-label': `Files in ${name}`, 'aria-busy': !root || root.t === 'loading' || undefined })}
        onKeyDown={ready ? onKeyDown : undefined}
        onScroll={(e) => {
          scrollTop.current = e.currentTarget.scrollTop
          clearTimeout(scrollTimer.current)
          scrollTimer.current = setTimeout(saveScroll, VIEW_SETTLE_MS)
        }}
        style={columns}
        className={`group/tree min-h-0 flex-1 overflow-y-auto ${ready ? 'focus-visible:outline-none' : ''}`}
      >
        {body}
      </div>
      <span className="sr-only" aria-live="polite">
        {said}
      </span>
    </div>
  )
}
