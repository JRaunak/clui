import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { diffLines } from 'diff'
import { refsOf, restoredTab, useActive, useSession } from '../../store'
import type { DraftReference } from '../../../../shared/context'
import type { Refusal } from '../../../../shared/files'
import { movedLine, survivingLines } from '../../../../shared/lines'
import { Button } from '../Button'
import { toWorkspaceRelative } from '../ChangedFiles'
import { requestSurfaceFocus } from '../../lib/surfaceFocus'
import { viaOf, type Via } from '../../lib/motion'
import { noteRead } from '../../lib/blockedFiles'
import { closeTab } from './SurfaceTabs'
import { ANNOUNCE_MS } from './SelectionBar'
import { addFromSurface } from '../ContextChips'
import { useSay } from '../../lib/useSay'

// What the File tab's two presentations share: the read and re-read of one file, its line selection, and the
// states shown when there's no text to show.

export const SKELETON_MS = 400
const TEXT_MAX_MB = 5
/** During Claude's turn a file can change many times a second; it re-reads at most this often. */
const TURN_RELOAD_MS = 300
const MISSING_POLL_MS = 2000
const REMAP_MS = 50
export const FLASH_MS = 720
export const FIND_MAX = 10_000
/** The window's unload never unmounts the open file, so its top line saves once a scroll settles. */
export const VIEW_SETTLE_MS = 250
/** ⌘F, ⌘G and ⇧⌘G routed to the File surface; detail is 'open' | 'next' | 'prev'. */
export const FILE_FIND_EVENT = 'clui:file-find'
export const TEXT_BTN = 'h-6 shrink-0 rounded px-2 text-content hover:bg-control-hover'
export const BANNER = 'flex min-h-8 shrink-0 items-center gap-2 bg-tool px-3 text-meta text-dim'
export const STATE_BODY = 'flex flex-col items-start gap-2 px-4 py-6'
const CHOOSE = 'Choose file\u2026'

export const baseOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1) || p
export const cleanError = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
export const toLines = (t: string): string[] => {
  const ls = t.split('\n')
  if (ls.length > 1 && ls.at(-1) === '') ls.pop()
  return ls
}
export const REASON: Record<Refusal['reason'], string> = {
  invalid: "The file's path isn't valid.",
  denied: "Clui only shows files in this session's folder or files Claude changed.",
  missing: "The file isn't on disk.",
  'wrong-type': "It isn't a regular file.",
  changed: 'The file changed while it was being read.',
  'too-large': `It's larger than ${TEXT_MAX_MB} MB, the most Clui opens.`,
  limit: 'The system has too many files open. Try again in a moment.',
  unreadable: '',
  permission: "macOS didn't let Clui read it. Check Clui's access in System Settings > Privacy & Security.",
  unavailable: "Clui can't read files safely on this system.",
  'too-broad': "The session's folder is your home folder or above it, so Clui won't preview pages from it."
}
export const RETRY = new Set<Refusal['reason']>(['changed', 'limit', 'unreadable'])

export type Lines = { start: number; end: number }
export const rangeText = (r: Lines, sep: string): string => (r.start === r.end ? `line ${r.start}` : `lines ${r.start}${sep}${r.end}`)

export type Doc =
  | { t: 'loading' }
  | { t: 'text'; text: string; revision: string; truncated: boolean }
  | { t: 'binary' }
  | { t: 'missing' }
  | { t: 'error'; reason: Refusal['reason']; message: string }

// What a shown file's view holds, for the header buttons and the menu item outside this component.
const status = new Map<string, Doc['t']>()
const listeners = new Set<() => void>()
export function setStatus(key: string, t: Doc['t'] | null): void {
  if ((status.get(key) ?? null) === t) return
  if (t) status.set(key, t)
  else status.delete(key)
  for (const l of listeners) l()
}
const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
export const useFileStatus = (handleId: string | null, path: string | null): Doc['t'] | null =>
  useSyncExternalStore(subscribe, () => (handleId && path ? (status.get(`${handleId}\0${path}`) ?? null) : null))

export const openEditor = (handleId: string, path: string, line?: number): Promise<void> =>
  window.clui.openInEditor(handleId, path, line).catch((e: unknown) => useSession.setState({ notice: { message: cleanError(e), tone: 'error' } }))

export const openDefault = (handleId: string, path: string): Promise<void> =>
  window.clui.openPath(handleId, path).then((r) => {
    if (!r.ok) useSession.setState({ notice: { message: r.message, tone: 'error' } })
  })

/** Where each of a's lines sits in b when it survives unchanged, else -1; null when the diff runs too long. */
function survivors(a: string, b: string): Int32Array | null {
  const changes = diffLines(a, b, { timeout: REMAP_MS })
  return changes ? survivingLines(changes, toLines(a).length) : null
}

const CLEARED = 'The lines you selected changed on disk, so the selection was cleared.'
const REMOVED = 'The lines you selected changed on disk, so the selection was cleared and removed from the message.'

/**
 * One file tab's text, read on mount and again when it changes on disk, and its line selection, carried onto new
 * text where its lines survive. `keep` runs just before new text replaces old, with where an old line moves to,
 * so the view can keep its place on the same text rather than the same line number.
 */
export function useFileDoc(handleId: string, tabId: string, keep: (moved: (line: number) => number) => void) {
  const tab = useActive((s) => s?.surfaces.tabs[tabId])
  const path = tab?.key ?? ''
  const busy = useActive((s) => !!s?.busy)
  const setView = useSession((s) => s.setSurfaceView)
  const selection = tab?.selection?.lines ?? null

  const [doc, setDoc] = useState<Doc>({ t: 'loading' })
  const docRef = useRef(doc)
  docRef.current = doc
  const selRef = useRef(selection)
  selRef.current = selection
  const selVersion = useRef(tab?.selection?.sourceVersion)
  selVersion.current = tab?.selection?.sourceVersion
  const busyRef = useRef(busy)
  busyRef.current = busy
  const keepRef = useRef(keep)
  keepRef.current = keep
  const [slow, setSlow] = useState(false)
  /** `removed`: the selection was in a message too, and left it. */
  const [notice, setNotice] = useState<'cleared' | 'removed' | null>(null)
  const [watchGen, setWatchGen] = useState(0)
  const [said, say] = useSay()

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
    else next = { t: 'text', text: r.text, revision: r.revision, truncated: r.truncated }
    setStatus(`${handleId}\0${path}`, next.t)
    if (prev.t === 'text' && next.t === 'text') {
      let map: Int32Array | null | undefined
      const mapped = (): Int32Array | null => (map === undefined ? (map = survivors(prev.text, next.text)) : map)
      keepRef.current((n) => movedLine(mapped(), n))
      const sel = selRef.current
      // A selection that is in a message clears on any change, with no remap.
      if (sel && attachedRef.current) {
        setView(handleId, tabId, { selection: undefined })
        setNotice('removed')
        say(REMOVED)
      } else if (sel) {
        const lines = mapped()
        const start = lines?.[sel.start - 1] ?? -1
        const whole = start >= 0 && Array.from({ length: sel.end - sel.start + 1 }, (_, i) => lines![sel.start - 1 + i]).every((m, i) => m === start + i)
        if (whole) setView(handleId, tabId, { selection: { lines: { start: start + 1, end: start + 1 + sel.end - sel.start }, sourceVersion: `sha256:${next.revision}` } })
        else {
          setView(handleId, tabId, { selection: undefined })
          setNotice('cleared')
          say(CLEARED)
        }
      }
    } else if (next.t === 'text' && selRef.current && selVersion.current && selVersion.current !== `sha256:${next.revision}`) {
      // A remounted tab has no earlier text to remap from; its selection was made against the revision it stored.
      setView(handleId, tabId, { selection: undefined })
      setNotice('cleared')
      say(CLEARED)
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

  const reopen = (): void => {
    void load()
    setWatchGen((n) => n + 1)
  }

  return { tab, path, doc, docRef, slow, notice, setNotice, said, say, selection, setSelection, addSelection, inTarget, selSay, load, reopen }
}

/**
 * A file view's find bar: its query, the current match, and ⌘F, ⌘G, ⇧⌘G and close from the menu. The view finds and
 * shows its own matches; `step` moves among them.
 */
export function useFind(open: boolean, setOpen: (on: boolean) => void, canFind: () => boolean, step: (by: number) => void) {
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query)
  const [current, setCurrent] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => setCurrent(0), [deferred])
  const latest = useRef({ open, setOpen, canFind, step })
  latest.current = { open, setOpen, canFind, step }
  // Focus waits for the commit that mounts the field: a frame callback can run first while a long document renders.
  const want = useRef(false)
  const take = (): void => {
    want.current = false
    input.current?.focus()
    input.current?.select()
  }
  useLayoutEffect(() => {
    if (open && want.current) take()
  }, [open])
  const show = useCallback(() => {
    if (latest.current.open) return take()
    want.current = true
    latest.current.setOpen(true)
  }, [])
  useEffect(() => {
    const onFind = (e: Event): void => {
      const { open, setOpen, canFind, step } = latest.current
      const what = (e as CustomEvent<string>).detail
      if (what === 'close') {
        if (!open) return
        setQuery('')
        return setOpen(false)
      }
      if (!canFind()) return
      if (what === 'open' || !open) return show()
      step(what === 'prev' ? -1 : 1)
    }
    window.addEventListener(FILE_FIND_EVENT, onFind)
    return () => window.removeEventListener(FILE_FIND_EVENT, onFind)
  }, [show])
  return { query, setQuery, deferred, current, setCurrent, input }
}

/** The notice a selection leaves when an outside change clears it. */
export function SelectionNotice({ notice, onDismiss }: { notice: 'cleared' | 'removed'; onDismiss: () => void }): JSX.Element {
  return (
    <div className="flex h-8 items-center gap-2 px-3 text-meta text-dim">
      {notice === 'removed' ? REMOVED : CLEARED}
      <button type="button" className={TEXT_BTN} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  )
}

/** A file that isn't on disk anymore, with the way to what Claude changed in it. `close` is the restored tab's Close button. */
export function FileMissing({ handleId, path, close, titleId, bodyId }: { handleId: string; path: string; close?: JSX.Element | null; titleId?: string; bodyId?: string }): JSX.Element {
  const cwd = useActive((s) => s?.cwd ?? null)
  const change = useActive((s) => !!s?.changes.some((c) => c.path === path))
  const openSurface = useSession((s) => s.openSurface)
  const viewChange = (via: Via): void => {
    requestSurfaceFocus('diff', via)
    openSurface(handleId, { kind: 'diff', key: '', title: 'Claude changes', location: { file: path } }, 'focus', 'user', 'user')
  }
  return (
    <div className={STATE_BODY}>
      <p id={titleId} className="text-ui font-medium text-content">
        File not found
      </p>
      <p id={bodyId} className="max-w-[60ch] text-meta text-dim">{`${toWorkspaceRelative(cwd, path)} isn't on disk anymore. It may have been moved or deleted.`}</p>
      {(change || close) && (
        <div className="flex gap-2">
          {change && (
            <Button variant="secondary" size="sm" aria-describedby={titleId && bodyId ? `${titleId} ${bodyId}` : undefined} onClick={(e) => viewChange(viaOf(e))}>
              {"View Claude's changes"}
            </Button>
          )}
          {close}
        </div>
      )}
    </div>
  )
}

/** What a file tab shows when it has no text: binary, missing, refused on restore, or unreadable. Null otherwise. */
export function DocState({ handleId, tabId, path, doc, load, reopen }: { handleId: string; tabId: string; path: string; doc: Doc; load: () => Promise<void>; reopen: () => void }): JSX.Element | null {
  // Only a tab restored from the sidecar can have lost a grant, and only it offers Close tab in its error states.
  const restored = useActive((s) => {
    const t = s?.surfaces.tabs[tabId]
    return !!t && restoredTab(s, t)
  })
  const cwd = useActive((s) => s?.cwd ?? null)
  const openSurface = useSession((s) => s.openSurface)
  const name = baseOf(path)
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
    reopen()
  }

  if (doc.t === 'binary') {
    return (
      <div className={STATE_BODY}>
        <p className="text-ui font-medium text-content">Binary file</p>
        <p className="max-w-[60ch] text-meta text-dim">{`${name} can't be shown as text.`}</p>
        <Button variant="secondary" size="sm" onClick={() => void openDefault(handleId, path)}>
          Open in default app
        </Button>
      </div>
    )
  }
  if (doc.t === 'missing') return <FileMissing handleId={handleId} path={path} close={closeButton} />
  if (doc.t === 'error' && doc.reason === 'denied' && restored) {
    return (
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
  }
  if (doc.t === 'error') {
    return (
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
  }
  return null
}
