import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import { denyChangeRead, refsOf, useActive, useSession, EMPTY_CHANGES, type PerSessionState } from '../../store'
import { changeSelection, type DiffHunk, type FileChangeSummary, type FileDiff, type HunkRows } from '../../../../shared/changes'
import type { ChangeSide } from '../../../../shared/context'
import type { ChangeRefResult } from '../../../../shared/ipc'
import { describe, Figure, figureWidth, MINUS, toWorkspaceRelative } from '../ChangedFiles'
import { Button } from '../Button'
import { addFromSurface } from '../ContextChips'
import { DiffLine, SELECTED_MARK, type LineKind } from './HunkView'
import { ANNOUNCE_MS, SelectionBar } from './SelectionBar'
import type { PaneExternal } from './PaneHeader'
import { highlightTexts, langForPath } from '../../lib/highlight'
import { requestSurfaceFocus, takeSurfaceFocus } from '../../lib/surfaceFocus'
import { viaOf, type Via } from '../../lib/motion'
import { changeBlocked, diffSelection, mintedRef, recordMint, requestOf, rowCount, sideEmpty, type DiffSelection } from '../../lib/changeRefs'
import {
  CHANGE_CLEARED,
  CHANGE_DENIED,
  CHANGE_REGION_HINT,
  changeRefusedText,
  changeSelectedSpoken,
  changeSelectedText,
  emptySideTitle,
  SIDE_TITLE,
  tooLargeText
} from '../../lib/refCopy'

const TAB = 'diff'
const SKELETON_MS = 400
const TYPEAHEAD_MS = 500
const SKELETON = [62, 48, 71, 35, 80, 54, 66, 40]
const TEXT_BTN = 'ml-auto h-6 shrink-0 rounded px-2 font-sans text-meta font-normal text-dim hover:bg-control-hover hover:text-content'
const DISABLED = 'aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-dim'
/** A mint's round trip is local; past this the Add button says it's working. */
const BUSY_MS = 400
const SIDES: ChangeSide[] = ['diff', 'before', 'after']
const SIDE_NAME: Record<ChangeSide, string> = { diff: 'Diff', before: 'Before', after: 'After' }
const SHELL_NOTE = "Changes made by shell commands aren't tracked."
const NONE_COPY =
  "Claude changed this file, but the session record doesn't include all of its changes. This happens with some subagent edits and with large files in resumed sessions."

const baseOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1) || p
const lines = (n: number): string => `${n} ${n === 1 ? 'line' : 'lines'}`
const files = (n: number): string => `${n} ${n === 1 ? 'file' : 'files'}`
const cleanError = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')

/** The file the Claude changes tab shows: its `location.file` while the ledger holds it, else the first. */
export function selectedChange(s: PerSessionState | null): FileChangeSummary | null {
  const changes = s?.changes ?? EMPTY_CHANGES
  const want = s?.surfaces.tabs[TAB]?.location?.file
  return changes.find((c) => c.path === want) ?? changes[0] ?? null
}

async function openInEditorDiff(handleId: string, path: string, segmentId?: string): Promise<void> {
  const r = await window.clui
    .openChangeDiff(handleId, segmentId ? { path, segmentId } : { path })
    .catch((e: unknown) => ({ ok: false as const, message: `Couldn't open the diff for ${baseOf(path)}. ${cleanError(e)}` }))
  if (!r.ok) useSession.setState({ notice: { message: r.message, tone: 'error' } })
}

/** ⇧⌘O and the header button: the selected file's latest segment, as a diff in the editor. */
export function useDiffExternal(handleId: string | null): PaneExternal {
  const path = useActive((s) => selectedChange(s)?.path ?? null)
  const snapshot = useActive((s) => !!selectedChange(s)?.snapshot)
  return {
    label: 'Open diff in editor',
    disabledReason: !path ? 'Select a file first.' : snapshot ? undefined : "The full before and after weren't recorded.",
    onOpen: () => (handleId && path ? openInEditorDiff(handleId, path) : undefined)
  }
}

type Item =
  | { t: 'heading'; key: string; text: string; first: boolean; segment?: { id: string; index: number; total: number } }
  | { t: 'separator'; key: string }
  | { t: 'hunk'; key: string; hunk: DiffHunk }
  /** `j`: the row's index in its hunk's `lines`, the coordinate a change selection's rows use. */
  | { t: 'line'; key: string; kind: LineKind; oldNo?: number; newNo?: number; text: string; hunk: string; j: number; side: 0 | 1; at: number }
  | { t: 'zero' | 'none' | 'truncated'; key: string }

interface HunkAt {
  hunk: DiffHunk
  /** Item index per line of `hunk.lines`; -1 for a `\ No newline` row, which isn't rendered. */
  rows: number[]
}

interface Built {
  items: Item[]
  maxLine: number
  /** Per hunk, its before-side run and after-side run, highlighted as whole texts. */
  runs: { id: string; old: string; new: string }[]
  hunks: Map<string, HunkAt>
}

/** The `j`s of a hunk's rendered rows. */
const shownRows = (at: HunkAt): number[] => at.rows.flatMap((x, j) => (x < 0 ? [] : [j]))
const rowsBetween = (a: number, b: number): HunkRows => ({ start: Math.min(a, b) + 1, end: Math.max(a, b) + 1 })

/** The selected rows as `j`s, a whole hunk as its first and last rendered row. */
function spanOf(s: DiffSelection, at: HunkAt): [number, number] {
  if (s.rows) return [s.rows.start - 1, s.rows.end - 1]
  const js = shownRows(at)
  return [js[0], js[js.length - 1]]
}

function build(diff: FileDiff): Built {
  const items: Item[] = []
  const runs: Built['runs'] = []
  const hunks: Built['hunks'] = new Map()
  let maxLine = 0
  const segs = diff.segments
  // Patch-only history numbers its edits across the file and has no segment headings; otherwise
  // segments are numbered, and a patch segment with several edits numbers them within it.
  const allPatch = segs.length > 0 && segs.every((s) => s.mode === 'patch')
  const fileEdits = allPatch ? segs.reduce((n, s) => n + s.groups.length, 0) : 0
  let editNo = 0
  segs.forEach((seg, i) => {
    if (seg.outsideBefore) items.push({ t: 'separator', key: `sep:${seg.id}` })
    if (!allPatch && segs.length > 1) {
      items.push({
        t: 'heading',
        key: `seg:${seg.id}`,
        text: `Changes ${i + 1} of ${segs.length}`,
        first: i === 0,
        ...(seg.snapshot ? { segment: { id: seg.id, index: i + 1, total: segs.length } } : {})
      })
    }
    if (seg.mode === 'none') return void items.push({ t: 'none', key: `none:${seg.id}` })
    if (seg.mode === 'full' && !seg.groups[0]?.length) return void items.push({ t: 'zero', key: `zero:${seg.id}` })
    const edits = allPatch ? fileEdits : seg.mode === 'patch' ? seg.groups.length : 0
    seg.groups.forEach((group, j) => {
      const n = allPatch ? ++editNo : j + 1
      if (edits > 1) items.push({ t: 'heading', key: `edit:${seg.id}:${j}`, text: `Edit ${n} of ${edits}`, first: allPatch && n === 1 })
      for (const h of group) {
        items.push({ t: 'hunk', key: `h:${h.id}`, hunk: h })
        const at: HunkAt = { hunk: h, rows: [] }
        hunks.set(h.id, at)
        maxLine = Math.max(maxLine, h.oldStart + h.oldLines - 1, h.newStart + h.newLines - 1)
        const old: string[] = []
        const neu: string[] = []
        let o = h.oldStart
        let n = h.newStart
        h.lines.forEach((l, j) => {
          const kind = l[0]
          const text = l.slice(1)
          const key = `l:${h.id}:${j}`
          at.rows.push(kind === '-' || kind === '+' || kind === ' ' ? items.length : -1)
          if (kind === '-') {
            items.push({ t: 'line', key, kind, oldNo: o++, text, hunk: h.id, j, side: 0, at: old.length })
            old.push(text)
          } else if (kind === '+') {
            items.push({ t: 'line', key, kind, newNo: n++, text, hunk: h.id, j, side: 1, at: neu.length })
            neu.push(text)
          } else if (kind === ' ') {
            items.push({ t: 'line', key, kind, oldNo: o++, newNo: n++, text, hunk: h.id, j, side: 1, at: neu.length })
            old.push(text)
            neu.push(text)
          }
        })
        runs.push({ id: h.id, old: old.join('\n'), new: neu.join('\n') })
      }
    })
  })
  if (diff.truncated) items.push({ t: 'truncated', key: 'truncated' })
  return { items, maxLine, runs, hunks }
}

const span = (start: number, count: number): string =>
  count === 0 ? 'no lines' : count === 1 ? `line ${start}` : `lines ${start} to ${start + count - 1}`

function Figures({ c }: { c: FileChangeSummary }): JSX.Element {
  return (
    <span aria-hidden="true" className="ml-auto flex shrink-0 gap-1.5 text-meta tabular-nums">
      <Figure n={c.added} sign="+" tone="text-ok" width="w-(--add-ch)" approx={c.approximate} />
      {c.created && c.removed === 0 ? (
        <span className="inline-block w-(--del-ch)" />
      ) : (
        <Figure n={c.removed} sign={MINUS} tone="text-err" width="w-(--del-ch)" />
      )}
    </span>
  )
}

const stateWord = (c: FileChangeSummary): string | null => (c.missingOnDisk ? 'File missing' : c.created ? 'new' : null)

function Summary({ changes }: { changes: FileChangeSummary[] }): JSX.Element {
  const known = changes.filter((c) => c.added !== null && c.removed !== null)
  const added = known.reduce((n, c) => n + (c.added ?? 0), 0)
  const removed = known.reduce((n, c) => n + (c.removed ?? 0), 0)
  const approx = known.some((c) => c.approximate)
  const unknown = changes.length - known.length
  const said = [
    `${files(changes.length)}.`,
    known.length ? `Claude added ${approx ? 'about ' : ''}${lines(added)} and removed ${removed}.` : '',
    unknown ? `${files(unknown)} not counted.` : ''
  ]
  return (
    <div className="shrink-0 px-3 pt-2 pb-1">
      <div className="flex items-baseline gap-2">
        <h2 className="text-label font-medium text-content" aria-describedby="diff-summary-said">
          Changes Claude made
        </h2>
        <span id="diff-summary-said" className="sr-only">
          {said.filter(Boolean).join(' ')}
        </span>
        <span aria-hidden="true" className="ml-auto text-meta text-dim tabular-nums">{files(changes.length)}</span>
        {known.length > 0 && (
          <span aria-hidden="true" className="flex gap-1.5 text-meta tabular-nums">
            <Figure n={added} sign="+" tone="text-ok" width="" approx={approx} />
            <Figure n={removed} sign={MINUS} tone="text-err" width="" />
          </span>
        )}
        {unknown > 0 && <span aria-hidden="true" className="text-meta text-faint">{`${unknown} not counted`}</span>}
      </div>
      <p className="text-meta text-faint">{SHELL_NOTE}</p>
    </div>
  )
}

/**
 * The "Claude changes" tab: every file Claude changed in the session, one diff at a time, each
 * built from the ledger's segments so changes made outside Claude never show as Claude's.
 */
export function DiffSurface({ handleId }: { handleId: string }): JSX.Element {
  const changes = useActive((s) => s?.changes ?? EMPTY_CHANGES)
  const cwd = useActive((s) => s?.cwd ?? null)
  const location = useActive((s) => s?.surfaces.tabs[TAB]?.location)
  const selected = useActive(selectedChange)
  const setView = useSession((s) => s.setSurfaceView)
  const openSurface = useSession((s) => s.openSurface)
  const listRef = useRef<HTMLDivElement>(null)
  const bodyEl = useRef<HTMLElement | null>(null)
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const bodyRef = useCallback((el: HTMLDivElement | null) => {
    bodyEl.current = el
    setScroller(el)
  }, [])
  const virtuoso = useRef<VirtuosoHandle>(null)
  const focusOption = useRef(false)
  const typed = useRef({ text: '', at: 0 })
  const lastIndex = useRef(0)
  const path = selected?.path ?? null
  const multi = changes.length > 1
  const sel = useActive((s) => s?.surfaces.tabs[TAB]?.selection?.change ?? null)
  const selRef = useRef(sel)
  selRef.current = sel
  const changeRead = useActive((s) => s?.changeRead ?? null)
  const anchor = useRef<{ hunk: string; j: number } | null>(null)
  const activeRow = useRef<number | null>(null)
  const lastVisible = useRef(0)
  /** The side the last range change had to leave, for its announcement. */
  const fellFrom = useRef<ChangeSide | undefined>()
  /** The next clear was already explained, so "Selection cleared" doesn't follow it. */
  const quiet = useRef(false)
  const sideEls = useRef<(HTMLButtonElement | null)[]>([])
  const hintId = useId()
  const [busy, setBusy] = useState(false)
  /** Main's too-large answer for a selection the preview thought fit, keyed to that selection and side. */
  const [refused, setRefused] = useState<{ key: string; lines: number; bytes: number } | null>(null)
  const [said, setSaid] = useState('')
  const sayCount = useRef(0)
  // A zero-width space toggles so an identical announcement still changes the live region.
  const say = (t: string): void => setSaid(`${t}${'\u200B'.repeat(++sayCount.current % 2)}`)
  const selSay = useRef<ReturnType<typeof setTimeout>>()
  const setChange = (change: DiffSelection | undefined): void => setView(handleId, TAB, { selection: change ? { change } : undefined })

  const select = (p: string, focus: boolean): void => {
    focusOption.current = focus && p !== path
    setView(handleId, TAB, { location: { file: p }, ...(p !== path ? { selection: undefined } : {}) })
  }

  // A file that leaves the ledger hands selection to its neighbour, not to the top of the list.
  useLayoutEffect(() => {
    const i = changes.findIndex((c) => c.path === location?.file)
    if (i >= 0) lastIndex.current = i
    else if (location?.file && changes.length) setView(handleId, TAB, { location: { file: changes[Math.min(lastIndex.current, changes.length - 1)].path } })
  }, [changes, location?.file, handleId, setView])

  useLayoutEffect(() => {
    const el = multi ? listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]') : bodyEl.current
    if (focusOption.current) {
      focusOption.current = false
      el?.focus()
      el?.scrollIntoView({ block: 'nearest' })
    }
  }, [path, multi])

  // A user open (a tray row) lands focus on this file's option, or on the diff when it's the only file.
  const hunkFocus = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!takeSurfaceFocus(TAB)) return
    // A change chip asks for one hunk: focus goes to its Show in file once that hunk is on screen.
    if (location?.hunk) return void (hunkFocus.current = location.hunk)
    const el = multi ? listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]') : bodyEl.current
    el?.focus({ preventScroll: true })
    el?.scrollIntoView({ block: 'nearest' })
  }, [location, multi])

  // A new edit to the file changes its edit ids, which refetches.
  const fetchKey = selected ? `${selected.path}\0${selected.editIds.join(',')}` : ''
  const [retry, setRetry] = useState(0)
  const [loaded, setLoaded] = useState<{ key: string; path: string; diff: FileDiff | null; error?: string } | null>(null)
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!path) return
    let live = true
    const timer = setTimeout(() => live && setSlow(true), SKELETON_MS)
    window.clui
      .getDiff(handleId, { path })
      .then((diff) => live && setLoaded({ key: fetchKey, path, diff }))
      .catch((e: unknown) => live && setLoaded({ key: fetchKey, path, diff: null, error: cleanError(e) }))
      .finally(() => {
        clearTimeout(timer)
        if (live) setSlow(false)
      })
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [handleId, fetchKey, path, retry])

  const shown = loaded?.diff ?? null
  const built = useMemo(() => (shown ? build(shown) : null), [shown])
  const [hl, setHl] = useState<{ for: Built; runs: Map<string, [string[] | null, string[] | null]> } | null>(null)
  useEffect(() => {
    if (!built || !shown || !built.runs.length) return
    let live = true
    const texts = built.runs.flatMap((r) => [r.old, r.new])
    void highlightTexts(langForPath(shown.path), texts).then((out) => {
      if (!live || out.every((x) => !x)) return
      setHl({ for: built, runs: new Map(built.runs.map((r, i) => [r.id, [out[2 * i], out[2 * i + 1]]])) })
    })
    return () => {
      live = false
    }
  }, [built, shown])

  // A refetch of the same file keeps the reader on the line they were at.
  const firstVisible = useRef(0)
  const prevBuilt = useRef<{ path: string; built: Built } | null>(null)
  useLayoutEffect(() => {
    const prev = prevBuilt.current
    prevBuilt.current = built && shown ? { path: shown.path, built } : null
    if (!prev || !built || !shown || prev.path !== shown.path || prev.built === built || firstVisible.current === 0) return
    const at = prev.built.items.slice(firstVisible.current).find((it) => it.t === 'line' && it.newNo !== undefined)
    const line = at?.t === 'line' ? at.newNo : undefined
    if (line === undefined) return
    const index = built.items.findIndex((it) => it.t === 'line' && it.newNo !== undefined && it.newNo >= line)
    if (index >= 0) virtuoso.current?.scrollToIndex({ index, align: 'start' })
  }, [built, shown])

  const appliedHunk = useRef<object | null>(null)
  useEffect(() => {
    const id = location?.hunk
    if (!id || !built || appliedHunk.current === location) return
    const index = built.items.findIndex((it) => it.t === 'hunk' && it.hunk.id === id)
    if (index < 0) return
    appliedHunk.current = location
    virtuoso.current?.scrollToIndex({ index, align: 'start' })
    if (hunkFocus.current !== id) return
    hunkFocus.current = null
    // The list renders the scrolled-to row a few frames later, on a first mount later still.
    let tries = 30
    // A chip that brought its selection back hands focus to the region, so Enter and Escape work at once.
    const restored = selRef.current?.hunkId === id
    const focus = (): void => {
      const el = restored ? bodyEl.current : document.querySelector<HTMLElement>(`[data-ui="diff-body"] [data-hunk="${CSS.escape(id)}"]`)
      if (el) el.focus()
      else if (tries-- > 0) requestAnimationFrame(focus)
    }
    requestAnimationFrame(focus)
  }, [location, built])

  // A refetch keeps a selection whose hunk is still there, byte for byte; anything else clears, never remaps.
  const seen = useRef<{ path: string; ids: Set<string> } | null>(null)
  const settled = !!built && !!shown && loaded?.key === fetchKey
  useEffect(() => {
    if (!settled || !built || !shown) return
    const had = seen.current
    seen.current = { path: shown.path, ids: new Set(built.hunks.keys()) }
    const s = selRef.current
    if (!s) return
    if (s.path === shown.path && built.hunks.get(s.hunkId)?.hunk.revision === s.revision) return
    quiet.current = true
    setChange(undefined)
    if (s.path === shown.path && had?.path === s.path && had.ids.has(s.hunkId)) say(CHANGE_CLEARED)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, built, shown, sel?.path, sel?.hunkId])

  // The selection's announcement trails the keys that make it; a side picked in the bar announces itself.
  const selKey = sel ? `${sel.hunkId}:${sel.rows ? `${sel.rows.start}-${sel.rows.end}` : ''}` : ''
  const hadSel = useRef(false)
  useEffect(() => {
    if (!sel && !hadSel.current) return
    hadSel.current = !!sel
    const wasQuiet = quiet.current
    quiet.current = false
    if (!sel && wasQuiet) return
    const at = sel && built?.hunks.get(sel.hunkId)
    if (sel && !at) return
    const text = sel && at ? changeSelectedSpoken(rowCount(at.hunk, sel.rows), !sel.rows, sel.side, fellFrom.current) : 'Selection cleared'
    const t = (selSay.current = setTimeout(() => say(text), ANNOUNCE_MS))
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey])

  // The bar takes its height from the scroller, which can hide the last row just selected.
  const selAt = sel ? built?.hunks.get(sel.hunkId) : undefined
  const barShown = !!sel && !!selAt
  useLayoutEffect(() => {
    if (!sel || !selAt) return
    const end = spanOf(sel, selAt)[1]
    bodyEl.current?.querySelector(`[data-row-hunk="${CSS.escape(sel.hunkId)}"][data-row="${end}"]`)?.scrollIntoView({ block: 'nearest' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [barShown])
  // The bar speaks for where an add lands, so In message reads the edit target's refs.
  const inTarget = useActive((s) => {
    const ref = sel && mintedRef(handleId, requestOf(sel))
    return !!s && !!ref && !!refsOf(s, s.referenceEditTarget)?.some((d) => d.ref.kind === 'change' && d.ref.changeRef === ref)
  })

  const rel = (p: string): string => toWorkspaceRelative(cwd, p)
  const columns = {
    '--add-ch': `${Math.max(1, ...changes.map((c) => figureWidth(c.added) + (c.approximate ? 1 : 0)))}ch`,
    '--del-ch': `${Math.max(1, ...changes.map((c) => figureWidth(c.removed)))}ch`
  } as CSSProperties

  const onOptionKey = (e: KeyboardEvent, i: number): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const moves: Record<string, number> = { ArrowDown: Math.min(i + 1, changes.length - 1), ArrowUp: Math.max(i - 1, 0), Home: 0, End: changes.length - 1 }
    const to = moves[e.key]
    if (to !== undefined) {
      e.preventDefault()
      return select(changes[to].path, true)
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      return bodyEl.current?.focus()
    }
    if (e.key.length !== 1 || e.key === ' ') return
    const now = Date.now()
    const t = typed.current
    t.text = now - t.at > TYPEAHEAD_MS ? e.key.toLowerCase() : t.text + e.key.toLowerCase()
    t.at = now
    // A fresh single letter moves past the current row, so repeating it cycles.
    const from = t.text.length === 1 ? i + 1 : i
    const order = [...changes.slice(from), ...changes.slice(0, from)]
    const hit = order.find((c) => baseOf(c.path).toLowerCase().startsWith(t.text))
    if (hit) select(hit.path, true)
  }

  if (!changes.length) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-bg pt-(--top-h)">
        <div className="shrink-0 px-3 pt-2 pb-1">
          <h2 className="text-label font-medium text-content">Changes Claude made</h2>
        </div>
        <p className="max-w-[60ch] px-3 pt-1 text-meta text-dim">{`Claude hasn't changed any files in this session yet. ${SHELL_NOTE}`}</p>
      </div>
    )
  }

  const picked = selected as FileChangeSummary
  const pending = loaded?.key !== fetchKey
  const skeleton = pending && slow
  // The header and actions describe the diff on screen, which lags the selection until its fetch lands.
  const c = (!skeleton && loaded && changes.find((x) => x.path === loaded.path)) || picked
  const name = baseOf(c.path)
  const relPath = rel(c.path)
  const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : ''
  const current = loaded?.path === c.path ? loaded : null
  const provenance = [
    current?.diff?.changedSince && "This file also has changes not made by Claude. They aren't shown.",
    c.approximate && 'Counts are approximate because the file is too large to compare in full.',
    c.missingOnDisk && "The file is no longer on disk. Claude's changes are shown from the session record.",
    current?.diff?.segments.some((s) => s.mode === 'patch') &&
      "The full before and after weren't recorded, so each edit is shown on its own with line numbers from the time of that edit."
  ].filter((x): x is string => !!x)

  // A hunk whose lines all survive opens at them; one that can't be placed in the file now opens it at the top.
  const showInFile = (h: DiffHunk, via: Via): void => {
    if (c.missingOnDisk) return
    requestSurfaceFocus(`file:${c.path}`, via)
    const at = h.current
    const location = at ? { line: at.start, ...(at.end > at.start ? { endLine: at.end } : {}) } : undefined
    openSurface(handleId, { kind: 'file', key: c.path, title: name, ...(location ? { location } : {}) }, 'focus', 'user', 'user')
  }

  const hunkAt = (id: string): HunkAt | undefined => built?.hunks.get(id)
  const selSpan = sel && selAt ? spanOf(sel, selAt) : null
  const choose = (h: DiffHunk, rows: HunkRows | undefined, want: ChangeSide = selRef.current?.side ?? 'diff'): void => {
    if (!shown) return
    const r = diffSelection(shown.path, h, want, rows)
    fellFrom.current = r.fellFrom
    setChange(r.sel)
  }
  const clear = (): void => {
    anchor.current = null
    setChange(undefined)
  }
  // A selection that arrived from elsewhere (a chip) anchors at its first row.
  const anchorIn = (id: string): { hunk: string; j: number } | null => {
    if (anchor.current?.hunk === id) return anchor.current
    const at = hunkAt(id)
    return sel?.hunkId === id && at ? { hunk: id, j: spanOf(sel, at)[0] } : null
  }

  const clickRow = (id: string, j: number, shift: boolean): void => {
    const at = hunkAt(id)
    if (!at) return
    const from = shift ? anchorIn(id) : null
    if (from) {
      anchor.current = from
      activeRow.current = j
      return choose(at.hunk, rowsBetween(from.j, j))
    }
    if (selSpan && sel?.hunkId === id && selSpan[0] === j && selSpan[1] === j) return clear()
    anchor.current = { hunk: id, j }
    activeRow.current = j
    choose(at.hunk, rowsBetween(j, j))
  }

  const toggleHunk = (h: DiffHunk): void => {
    const at = hunkAt(h.id)
    if (!at) return
    if (sel?.hunkId === h.id && !sel.rows) return clear()
    const js = shownRows(at)
    anchor.current = { hunk: h.id, j: js[0] }
    activeRow.current = js[js.length - 1]
    choose(h, undefined)
    bodyEl.current?.focus()
  }

  // Dragging across code keeps the native selection for copying; within one hunk its rows become the selection.
  const onMouseUp = (): void => {
    const s = window.getSelection()
    if (!s || s.isCollapsed) return
    const rowOf = (node: Node | null): { hunk: string; j: number } | null => {
      const el = node instanceof Element ? node : node?.parentElement
      const row = el?.closest<HTMLElement>('[data-row-hunk]')
      return row?.dataset.rowHunk && bodyEl.current?.contains(row) ? { hunk: row.dataset.rowHunk, j: Number(row.dataset.row) } : null
    }
    const a = rowOf(s.anchorNode)
    const b = rowOf(s.focusNode)
    const at = a && b && a.hunk === b.hunk ? hunkAt(a.hunk) : undefined
    if (!a || !b || !at) return
    anchor.current = a
    activeRow.current = b.j
    choose(at.hunk, rowsBetween(a.j, b.j))
  }

  const preview = sel && selAt ? changeSelection(selAt.hunk, sel.side, sel.rows) : null
  const refusedKey = sel ? `${selKey}\0${sel.side}` : ''
  const mainSize = refused?.key === refusedKey ? refused : null
  const blocked = preview ? (changeBlocked(changeRead, preview) ?? (mainSize ? tooLargeText(mainSize.lines, mainSize.bytes) : undefined)) : undefined
  const blockedSpoken = (): string =>
    blocked === CHANGE_DENIED ? changeRefusedText('denied') : changeRefusedText('too-large', mainSize ?? { lines: preview?.lines ?? 0, bytes: preview?.bytes ?? 0 })

  const addChange = async (): Promise<void> => {
    if (!sel || !selAt) return
    // An add right after selecting must not be talked over by the trailing selection announcement.
    clearTimeout(selSay.current)
    if (blocked) return say(blockedSpoken())
    const req = requestOf(sel)
    const slow = setTimeout(() => setBusy(true), BUSY_MS)
    let r: ChangeRefResult
    try {
      r = await window.clui.createChangeRef(handleId, req)
    } catch {
      return say(`Couldn't add the change to ${baseOf(sel.path)}.`)
    } finally {
      clearTimeout(slow)
      setBusy(false)
    }
    if (r.ok) {
      recordMint(handleId, r.ref.changeRef, req)
      return addFromSurface(handleId, r.ref, say, r.bytes)
    }
    const size = { lines: r.lines ?? 0, bytes: r.bytes ?? 0 }
    if (r.reason === 'changed') {
      quiet.current = true
      clear()
    } else if (r.reason === 'denied') denyChangeRead(handleId)
    else if (r.reason === 'too-large') setRefused({ key: refusedKey, ...size })
    say(changeRefusedText(r.reason, size))
  }

  const onRegionKey = (e: KeyboardEvent): void => {
    if (e.target !== e.currentTarget || !built) return
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      if (!sel) return
      e.preventDefault()
      return void addChange()
    }
    if (e.key === 'Escape') {
      if (!sel) return
      e.preventDefault()
      return clear()
    }
    if (!e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    if (!sel || !selAt) {
      const first = built.items.slice(firstVisible.current).find((it) => it.t === 'hunk' || it.t === 'line')
      const at = first?.t === 'hunk' ? hunkAt(first.hunk.id) : first?.t === 'line' ? hunkAt(first.hunk) : undefined
      if (!at) return
      const j = shownRows(at)[0]
      anchor.current = { hunk: at.hunk.id, j }
      activeRow.current = j
      return choose(at.hunk, rowsBetween(j, j))
    }
    const [lo, hi] = spanOf(sel, selAt)
    if (anchor.current?.hunk !== sel.hunkId) {
      anchor.current = { hunk: sel.hunkId, j: lo }
      activeRow.current = hi
    }
    const js = shownRows(selAt)
    const i = js.indexOf(activeRow.current ?? hi)
    const to = js[Math.max(0, Math.min(js.length - 1, i + (e.key === 'ArrowUp' ? -1 : 1)))]
    activeRow.current = to
    choose(selAt.hunk, rowsBetween(anchor.current.j, to))
    const index = selAt.rows[to]
    if (index < firstVisible.current || index > lastVisible.current) virtuoso.current?.scrollToIndex({ index, align: 'center' })
  }

  const empty = (side: ChangeSide): boolean => !!sel && !!selAt && side !== 'diff' && sideEmpty(selAt.hunk, side, sel.rows)
  const pickSide = (side: ChangeSide): void => {
    if (sel && selAt && !empty(side)) choose(selAt.hunk, sel.rows, side)
  }
  const onSideKey = (e: KeyboardEvent): void => {
    if (!sel) return
    const open = SIDES.filter((x) => !empty(x))
    const step: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }
    const k = open.indexOf(sel.side)
    const to = e.key in step ? open[(k + step[e.key] + open.length) % open.length] : e.key === 'Home' ? open[0] : e.key === 'End' ? open[open.length - 1] : undefined
    if (!to) return
    e.preventDefault()
    pickSide(to)
    sideEls.current[SIDES.indexOf(to)]?.focus()
  }

  const renderItem = (item: Item): JSX.Element => {
    switch (item.t) {
      case 'heading':
        return (
          <div className="flex items-baseline gap-2 px-3 pt-4 pb-1">
            <h4 aria-label={item.first ? `${item.text}, oldest first` : undefined} className="text-label font-medium text-content">
              {item.text}
            </h4>
            {item.segment && (
              <button
                type="button"
                className={TEXT_BTN}
                aria-label={`Open changes ${item.segment.index} of ${item.segment.total} as a diff in editor`}
                onClick={() => void openInEditorDiff(handleId, c.path, item.segment?.id)}
              >
                Open in editor
              </button>
            )}
          </div>
        )
      case 'separator':
        return <p className="px-3 py-2 text-meta text-dim">{"Then the file was changed outside Claude. That change isn't shown."}</p>
      case 'hunk': {
        const h = item.hunk
        const at = h.current
        const label = !at ? `Open ${name}. These lines have changed since.` : at.start === at.end ? `Show line ${at.start} in ${name}` : `Show lines ${at.start} to ${at.end} in ${name}`
        const extent = `${span(h.oldStart, h.oldLines)} before, ${span(h.newStart, h.newLines)} after`
        const whole = sel?.hunkId === h.id && !sel.rows
        return (
          <div className={`relative flex h-7 items-center gap-2 bg-tool pl-3 pr-1 font-mono text-meta text-dim ${whole ? SELECTED_MARK : ''}`}>
            <button
              type="button"
              data-ui="diff-hunk-select"
              aria-pressed={whole}
              aria-label={`Select hunk: ${extent}`}
              title="Select this hunk"
              onClick={() => toggleHunk(h)}
              className="-ml-1.5 h-6 rounded px-1.5 font-mono text-meta text-dim hover:bg-control-hover hover:text-content aria-pressed:text-content"
            >
              {`@@ ${h.oldStart},${h.oldLines} → ${h.newStart},${h.newLines}`}
            </button>
            <button
              type="button"
              data-hunk={h.id}
              className={`${TEXT_BTN} ${DISABLED}`}
              aria-label={c.missingOnDisk ? undefined : label}
              aria-disabled={c.missingOnDisk || undefined}
              title={c.missingOnDisk ? 'The file no longer exists.' : undefined}
              onClick={(e) => showInFile(h, viaOf(e))}
            >
              {at ? 'Show in file' : 'Open file'}
            </button>
          </div>
        )
      }
      case 'line': {
        const run = hl?.for === built ? hl.runs.get(item.hunk) : undefined
        const on = !!selSpan && sel?.hunkId === item.hunk && item.j >= selSpan[0] && item.j <= selSpan[1]
        return (
          <DiffLine
            kind={item.kind}
            oldNo={item.oldNo}
            newNo={item.newNo}
            text={item.text}
            html={run?.[item.side]?.[item.at]}
            selected={on}
            onGutter={(shift) => clickRow(item.hunk, item.j, shift)}
            row={{ hunk: item.hunk, j: item.j }}
          />
        )
      }
      case 'zero':
        return <p className="px-3 py-3 text-meta text-dim">{"Claude's edits to this file cancel out. There is no net change."}</p>
      case 'none':
        return <NonePanel missing={c.missingOnDisk} path={c.path} handleId={handleId} />
      case 'truncated':
        return <p className="px-3 py-3 text-meta text-dim">{'The rest of this diff is too long to show here.'}</p>
    }
  }

  const bodyLabel = `Diff of ${name}`
  let content: JSX.Element | null = null
  if (current?.error) {
    content = (
      <Button variant="secondary" size="sm" className="mx-3 mt-2" onClick={() => setRetry((n) => n + 1)}>
        Try again
      </Button>
    )
  } else if (skeleton) {
    content = (
      <div className="pt-1">
        {SKELETON.map((w, i) => (
          <div key={i} className="flex h-5 font-mono text-code">
            <span className="box-content w-(--num-ch) shrink-0 px-1.5" />
            <span className="box-content w-(--num-ch) shrink-0 px-1.5" />
            <span className="w-5 shrink-0" />
            <span className="my-1 h-3 rounded-sm bg-bg-raised" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
    )
  } else if (loaded && !loaded.diff && !loaded.error && loaded.path === picked.path) {
    content = <NonePanel missing={c.missingOnDisk} path={c.path} handleId={handleId} />
  } else if (built && scroller) {
    content = (
      <Virtuoso
        ref={virtuoso}
        customScrollParent={scroller}
        data={built.items}
        computeItemKey={(_i, it) => it.key}
        rangeChanged={(r) => {
          firstVisible.current = r.startIndex
          lastVisible.current = r.endIndex
        }}
        itemContent={(_i, it) => renderItem(it)}
      />
    )
  }
  // One region for every state, so focus in it survives a refetch, a skeleton or an error.
  const body = (
    <div
      ref={bodyRef}
      role="region"
      aria-label={bodyLabel}
      aria-describedby={hintId}
      aria-busy={pending || undefined}
      tabIndex={0}
      onKeyDown={onRegionKey}
      onMouseUp={onMouseUp}
      data-ui="diff-body"
      data-beside-header=""
      {...(multi ? {} : { 'data-pane-title': '' })}
      className="min-h-0 flex-1 overflow-y-auto"
    >
      <p role="status" className={current?.error ? 'px-3 pt-3 text-meta text-err' : 'sr-only'}>
        {current?.error ? `Couldn't load the diff for ${name}. ${current.error}` : ''}
      </p>
      {content}
    </div>
  )

  return (
    <div
      data-ui="diff-surface"
      style={{ ...columns, '--num-ch': `${String(built?.maxLine ?? 1).length}ch` } as CSSProperties}
      className="@container/diff flex h-full min-h-0 flex-col bg-bg pt-(--top-h)"
    >
      <div className="flex min-h-0 flex-1 flex-col @min-[760px]/diff:grid @min-[760px]/diff:grid-cols-[260px_minmax(0,1fr)] @min-[760px]/diff:grid-rows-[minmax(0,1fr)]">
        <div className="flex shrink-0 flex-col @min-[760px]/diff:min-h-0 @min-[760px]/diff:border-r @min-[760px]/diff:border-border">
          <Summary changes={changes} />
          {multi && (
            <div
              ref={listRef}
              role="listbox"
              aria-label="Changed files"
              aria-orientation="vertical"
              data-ui="diff-switcher"
              data-beside-header=""
              className="max-h-[144px] overflow-y-auto px-1 pb-2 @min-[760px]/diff:max-h-none @min-[760px]/diff:min-h-0 @min-[760px]/diff:flex-1"
            >
              {changes.map((x, i) => {
                const on = x.path === picked.path
                const r = rel(x.path)
                const cut = r.lastIndexOf('/')
                const word = stateWord(x)
                const { description } = describe(x)
                return (
                  <div
                    key={x.path}
                    role="option"
                    aria-selected={on}
                    tabIndex={on ? 0 : -1}
                    aria-label={r}
                    aria-description={x.diffAvailable ? description : `${description} Diff unavailable.`}
                    {...(on ? { 'data-pane-title': '' } : {})}
                    onClick={() => select(x.path, true)}
                    onKeyDown={(e) => onOptionKey(e, i)}
                    className="relative flex h-6 w-full cursor-default items-baseline gap-2 rounded px-2 text-left leading-6 hover:bg-control-hover aria-selected:bg-control-hover aria-selected:before:absolute aria-selected:before:inset-y-1 aria-selected:before:left-0 aria-selected:before:w-0.5 aria-selected:before:rounded-full aria-selected:before:bg-content"
                  >
                    <span className="min-w-0 truncate font-mono text-code text-content">{baseOf(x.path)}</span>
                    <span aria-hidden="true" className="min-w-0 flex-1 truncate font-mono text-meta text-faint">{cut > 0 ? r.slice(0, cut) : ''}</span>
                    {word && <span aria-hidden="true" className="shrink-0 text-meta text-dim">{word}</span>}
                    <Figures c={x} />
                  </div>
                )
              })}
            </div>
          )}
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className={`shrink-0 px-3 pt-2 pb-1.5 ${multi ? 'border-t border-border @min-[760px]/diff:border-t-0' : ''}`}>
            <h3 aria-label={relPath} className="flex items-baseline gap-2">
              <span className="font-mono text-code text-content">{name}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-meta text-faint">{dir}</span>
              {stateWord(c) && <span className="shrink-0 text-meta text-dim">{stateWord(c)}</span>}
              <Figures c={c} />
            </h3>
            {provenance.map((p) => (
              <p key={p} className="text-meta text-dim">
                {p}
              </p>
            ))}
          </div>
          {body}
          <span id={hintId} hidden>
            {CHANGE_REGION_HINT}
          </span>
          {sel && selAt && (
            <SelectionBar
              label={changeSelectedText(rowCount(selAt.hunk, sel.rows), !sel.rows)}
              attached={inTarget}
              onAdd={() => void addChange()}
              blocked={blocked}
              onBlocked={() => say(blockedSpoken())}
              busy={busy}
            >
              <div role="radiogroup" aria-label="Side to add" data-ui="change-side" className="flex h-7 shrink-0 items-center rounded-md border border-control-edge bg-control p-0.5">
                {SIDES.map((x, i) => {
                  const off = empty(x)
                  const on = sel.side === x
                  return (
                    <button
                      key={x}
                      ref={(el) => void (sideEls.current[i] = el)}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      aria-disabled={off || undefined}
                      tabIndex={on ? 0 : -1}
                      title={off ? emptySideTitle(x) : SIDE_TITLE[x]}
                      onClick={() => pickSide(x)}
                      onKeyDown={onSideKey}
                      className="relative h-6 rounded px-2 text-meta text-dim pointer-fine:hover:text-content aria-checked:bg-bg-raised aria-checked:font-medium aria-checked:text-content aria-checked:after:absolute aria-checked:after:inset-x-1.5 aria-checked:after:bottom-0.5 aria-checked:after:h-0.5 aria-checked:after:rounded-full aria-checked:after:bg-content aria-disabled:text-faint aria-disabled:pointer-fine:hover:text-faint"
                    >
                      {SIDE_NAME[x]}
                    </button>
                  )
                })}
              </div>
            </SelectionBar>
          )}
          <span className="sr-only" aria-live="polite" data-ui="diff-live">
            {said}
          </span>
        </div>
      </div>
    </div>
  )
}

function NonePanel({ missing, path, handleId }: { missing: boolean; path: string; handleId: string }): JSX.Element {
  return (
    <div className="flex flex-col items-start gap-2 px-3 py-6">
      <p className="text-ui font-medium text-content">Diff unavailable</p>
      <p className="max-w-[60ch] text-meta text-dim">{NONE_COPY}</p>
      {!missing && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            void window.clui.openInEditor(handleId, path).catch((e: unknown) => useSession.setState({ notice: { message: cleanError(e), tone: 'error' } }))
          }
        >
          Open in editor
        </Button>
      )}
    </div>
  )
}
