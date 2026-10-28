/**
 * ⌘K command palette: one door to everything (VS Code / Linear / Raycast style).
 *
 * Sessions are listed first (recency-ordered) so the common path (jump to a session
 * by name) is instant. A leading `>` scopes the query to commands only (New session,
 * Settings, Customizations, Toggle theme, Close session), matching the VS Code convention;
 * ⌘⇧K opens straight into it.
 *
 * ⌘P opens it on the active session's files instead (Open file), ranked by the shared path ranker.
 *
 * Fuzzy subsequence matching with highlighted characters. Keyboard: ↑/↓ move, Enter runs,
 * Esc closes (via the shared escape-stack so a palette over a modal closes the palette first).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession, activeSlice, selectPaneOpen, useActive, EMPTY_CHANGES, EMPTY_SURFACES } from '../store'
import { useEscape } from '../lib/useEscape'
import { applyTheme } from '../lib/theme'
import { fuzzyMatch, highlightRuns, rankPaths, splitLine } from '../lib/fuzzy'
import { requestSurfaceFocus } from '../lib/surfaceFocus'
import { viaOf, type Via } from '../lib/motion'
import { IconSearch, IconPlus, IconSettings, IconSliders, IconClose, IconMessage, IconFolder, IconDiff, IconAgentBrowser, IconPaneRight, IconHalfRing, IconSidebar, IconDownload, IconGitFork } from './Icon'
import { FileIcon } from './FileIcon'
import { cleanError, openEditor } from './surfaces/fileDoc'
import { tilde } from '../lib/tree'
import { fileCount } from '../lib/paneItems'
import { fileLike } from '../lib/presentation'
import { runPaneItem } from './surfaces/PanePicker'
import { WORKSPACE_FILE_CAP } from '../../../shared/files'
import type { ProjectGroup } from '../../../shared/sessions'

export type PaletteMode = 'switch' | 'command' | 'file'

/** Asks the app to open the palette on the active session's files. */
export const OPEN_FILE_EVENT = 'clui:open-file'
export const openFilePalette = (): void => void window.dispatchEvent(new Event(OPEN_FILE_EVENT))

const RESULT_CAP = 50
const count = new Intl.NumberFormat('en-US')

interface FileOption {
  abs: string
  rel: string
  matches: number[]
  group?: 'Open in pane' | 'Changed by Claude'
}

type FileList = { t: 'ok'; files: string[]; truncated: boolean } | { t: 'error'; message: string }

interface PaletteItem {
  key: string
  kind: 'session' | 'command'
  label: string
  /** Secondary line (workspace name, or command hint). */
  hint?: string
  icon?: (p: { className?: string }) => JSX.Element
  /** Recency for ordering (ms). Higher = more recent. */
  recency: number
  live?: boolean
  /** Runs inside the palette instead of closing it. */
  stay?: boolean
  run: () => void
}

export function CommandPalette({
  mode,
  openSeq,
  onClose,
  onNewSession,
  onNewSessionInDir,
  onOpenSettings,
  onOpenCustomizations,
  onToggleSidebar,
  sidebarCollapsed
}: {
  mode: PaletteMode
  openSeq: number
  onClose: () => void
  onNewSession: () => void
  onNewSessionInDir: () => void
  onOpenSettings: () => void
  onOpenCustomizations: () => void
  onToggleSidebar: () => void
  sidebarCollapsed: boolean
}): JSX.Element {
  const [query, setQuery] = useState(mode === 'command' ? '>' : '')
  const [fileScope, setFileScope] = useState(mode === 'file')
  const [sel, setSel] = useState(0)
  const [disk, setDisk] = useState<ProjectGroup[]>([])
  const [list, setList] = useState<FileList | null>(null)
  const [slow, setSlow] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const handleId = useSession((s) => s.activeHandleId)
  const cwd = useActive((s) => s?.cwd ?? null)
  const tabs = useActive((s) => s?.surfaces.tabs ?? EMPTY_SURFACES.tabs)
  const changes = useActive((s) => s?.changes ?? EMPTY_CHANGES)

  useEscape(true, onClose)

  // Focus the input on open; load the on-disk session list once.
  useEffect(() => {
    const el = inputRef.current
    el?.focus()
    el?.setSelectionRange(el.value.length, el.value.length)
    void window.clui.listSessions().then(setDisk)
  }, [])

  const queryRef = useRef(query)
  queryRef.current = query
  const scopeRef = useRef(fileScope)
  scopeRef.current = fileScope

  useEffect(() => {
    const toFile = mode === 'file'
    if (queryRef.current.startsWith('>') === (mode === 'command') && scopeRef.current === toFile) return
    const q = mode === 'command' ? '>' : ''
    setFileScope(toFile)
    setQuery(q)
    setSel(0)
    const raf = requestAnimationFrame(() => inputRef.current?.setSelectionRange(q.length, q.length))
    return () => cancelAnimationFrame(raf)
  }, [mode, openSeq])

  // Build the full item set (sessions first, then commands). Recomputed when the query
  // toggles command-scope or the disk list arrives; live sessions are read non-reactively
  // at build time (the palette is short-lived).
  const commandMode = query.startsWith('>')
  const rawQuery = commandMode ? query.slice(1) : query
  const fileMode = fileScope && !commandMode && !!cwd
  const folder = cwd ? cwd.slice(cwd.lastIndexOf('/') + 1) || cwd : ''

  // Listed once per palette, the first time it shows files.
  useEffect(() => {
    if (!fileScope || !handleId || list) return
    let live = true
    const timer = setTimeout(() => setSlow(true), 400)
    window.clui.listWorkspaceFiles(handleId).then(
      (r) => live && setList({ t: 'ok', ...r }),
      (e: unknown) => live && setList({ t: 'error', message: cleanError(e) })
    )
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [fileScope, handleId, list])

  const { query: fileQuery, line } = splitLine(rawQuery)
  const files = useMemo((): { options: FileOption[]; total: number } => {
    const none = { options: [], total: 0 }
    if (!fileMode || !cwd) return none
    const relOf = (abs: string): string => (abs.startsWith(`${cwd}/`) ? abs.slice(cwd.length + 1) : tilde(abs, window.clui.homeDir))
    if (!fileQuery.trim()) {
      const open = Object.values(tabs)
        .filter((t) => fileLike(t.kind))
        .sort((a, b) => b.lastViewedAt - a.lastViewedAt)
        .map((t): FileOption => ({ abs: t.key, rel: relOf(t.key), matches: [], group: 'Open in pane' }))
      const listed = new Set(open.map((o) => o.abs))
      // Quick-open lists the workspace, so a change outside it stays in the tray.
      const changed = changes
        .filter((c) => c.path.startsWith(`${cwd}/`) && !listed.has(c.path))
        .map((c): FileOption => ({ abs: c.path, rel: relOf(c.path), matches: [], group: 'Changed by Claude' }))
      const options = [...open, ...changed]
      return { options, total: options.length }
    }
    if (list?.t !== 'ok') return none
    const ranked = rankPaths(fileQuery, list.files)
    return { options: ranked.slice(0, RESULT_CAP).map((r) => ({ abs: `${cwd}/${r.item}`, rel: r.item, matches: r.matches })), total: ranked.length }
  }, [fileMode, cwd, fileQuery, tabs, changes, list])

  const items = useMemo<PaletteItem[]>(() => {
    const store = useSession.getState()
    const out: PaletteItem[] = []

    // Sessions (skipped in command mode)
    if (!commandMode) {
      const live = Object.values(store.sessions).filter((s) => !s.exited)
      const liveBySid = new Map<string, (typeof live)[number]>()
      for (const s of live) if (s.sessionId) liveBySid.set(s.sessionId, s)
      const seenHandles = new Set<string>()

      // On-disk sessions (augmented with live info), recency by mtime/createdMs.
      for (const g of disk) {
        for (const s of g.sessions) {
          const lm = liveBySid.get(s.id)
          const isLive = Boolean(lm) && !lm!.exited
          if (lm) seenHandles.add(lm.handleId)
          const workspace = g.label
          out.push({
            key: `sess:${s.id}`,
            kind: 'session',
            label: s.title || s.id.slice(0, 8),
            hint: workspace,
            recency: s.mtimeMs || s.createdMs,
            live: isLive,
            run: () => {
              if (isLive && lm) store.activateSession(lm.handleId)
              else store.resumeSession(s.cwd, s.id, undefined, s.hardTitle)
            }
          })
        }
      }
      // Live-only sessions not yet on disk (brand-new).
      for (const s of live) {
        if (seenHandles.has(s.handleId)) continue
        const firstUser = s.messages.find((m) => m.role === 'user')?.text.trim()
        out.push({
          key: `live:${s.handleId}`,
          kind: 'session',
          // Prefer the optimistic displayed title (a freshly named/branched session shows it
          // in the sidebar before its jsonl exists) so the palette can find it by that name
          // too. Else the first user message; else "Untitled" (not "New session", so an
          // unnamed session's label can't collide with the "New session" command).
          label: s.title ?? (firstUser ? firstUser.slice(0, 80) : 'Untitled'),
          hint: s.cwd.split('/').pop() || s.cwd,
          recency: s.lastActivityMs,
          live: true,
          run: () => store.activateSession(s.handleId)
        })
      }
      out.sort((a, b) => b.recency - a.recency)
    }

    // Commands (always available; the only items in command mode)
    const activeId = store.activeHandleId
    const slice = activeSlice(store)
    const paneCommands = (cwd: string): PaletteItem[] => {
      const n = slice?.changes.length ?? 0
      const shown = !store.viewingSubagent && selectPaneOpen(slice)
      const item = (key: string, label: string, hint: string, icon: PaletteItem['icon'], run: () => void): PaletteItem => ({ key: `cmd:${key}`, kind: 'command', label, hint, icon, recency: 0, run })
      return [
        {
          ...item('open-file', 'Open file…', '⌘P', IconSearch, () => {
            setFileScope(true)
            setQuery('')
            setSel(0)
          }),
          stay: true
        },
        item('tree', 'Show file tree', cwd.slice(cwd.lastIndexOf('/') + 1) || cwd, IconFolder, () => runPaneItem('tree', cwd)),
        ...(n > 0 ? [item('changes', 'Show Claude changes', fileCount(n), IconDiff, () => runPaneItem('changes', cwd))] : []),
        ...(slice?.browser ? [item('browser', 'Show browser', '⇧⌘B', IconAgentBrowser, () => void store.revealBrowser(null))] : []),
        item('pane', shown ? 'Hide pane' : 'Show pane', '⌥⌘0', IconPaneRight, () => store.togglePane())
      ]
    }
    const commands: PaletteItem[] = [
      {
        key: 'cmd:new',
        kind: 'command',
        icon: IconPlus,
        label: 'New session',
        hint: '⌘N',
        recency: 0,
        run: onNewSession
      },
      {
        key: 'cmd:new-in-dir',
        kind: 'command',
        icon: IconPlus,
        label: 'New session in a directory…',
        hint: '⇧⌘N',
        recency: 0,
        run: onNewSessionInDir
      },
      {
        key: 'cmd:settings',
        kind: 'command',
        icon: IconSettings,
        label: 'Open Settings',
        hint: '⌘,',
        recency: 0,
        run: onOpenSettings
      },
      {
        key: 'cmd:customizations',
        kind: 'command',
        icon: IconSliders,
        label: 'Open Configuration',
        hint: 'Agents · Skills · Hooks · MCP (read-only audit)',
        recency: 0,
        run: onOpenCustomizations
      },
      {
        key: 'cmd:theme',
        kind: 'command',
        label: 'Toggle light / dark theme',
        hint: 'Switches this session',
        icon: IconHalfRing,
        recency: 0,
        run: () => {
          const isLight = document.documentElement.getAttribute('data-theme') === 'light'
          const next = isLight ? 'dark' : 'light'
          applyTheme(next)
          void window.clui.updateSettings({ theme: next })
        }
      },
      {
        key: 'cmd:sidebar',
        kind: 'command',
        label: sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar',
        hint: '⌘B',
        icon: IconSidebar,
        recency: 0,
        run: onToggleSidebar
      },
      ...(slice?.cwd ? paneCommands(slice.cwd) : []),
      ...(activeId
        ? [
            {
              key: 'cmd:export',
              kind: 'command' as const,
              label: 'Export current session',
              hint: 'Save as Markdown',
              icon: IconDownload,
              recency: 0,
              run: () => {
                const a = activeSlice(store)
                if (a?.sessionId) void window.clui.exportSession(a.sessionId)
              }
            },
            {
              key: 'cmd:fork',
              kind: 'command' as const,
              label: 'Branch current session',
              hint: 'Branch to a new session',
              icon: IconGitFork,
              recency: 0,
              run: () => {
                const a = activeSlice(store)
                if (a?.sessionId && a.cwd) void store.forkSession(a.cwd, a.sessionId)
              }
            },
            {
              key: 'cmd:close',
              kind: 'command' as const,
              icon: IconClose,
              label: 'Close active session',
              hint: '⌘W',
              recency: 0,
              run: () => void store.closeSession(activeId)
            }
          ]
        : [])
    ]
    return [...out, ...commands]
  }, [commandMode, disk, onNewSession, onNewSessionInDir, onOpenSettings, onOpenCustomizations])

  // Filter + rank by the scope-stripped query. Match the label (title) first; its matched
  // indices drive the highlight. If the label doesn't match, fall back to the hint (workspace
  // name) so "scr" still finds sessions in ~/clui-scratch; a hint-only match scores lower and
  // carries no label highlight.
  const filtered = useMemo(() => {
    const scored = items
      .map((it) => {
        const m = fuzzyMatch(rawQuery, it.label)
        if (m.score !== null) return { it, score: m.score, matches: m.matches }
        if (it.hint) {
          const h = fuzzyMatch(rawQuery, it.hint)
          if (h.score !== null) return { it, score: h.score - 100, matches: [] as number[] }
        }
        return { it, score: null as number | null, matches: [] as number[] }
      })
      .filter((r) => r.score !== null)
    // With a query, sort by score; ties keep the source order (recency/kind).
    if (rawQuery.trim()) scored.sort((a, b) => (b.score as number) - (a.score as number))
    return scored
  }, [items, rawQuery])

  const rows = fileMode ? files.options.length : filtered.length

  // Keep the selection in range as results change. A new file query starts on its best match.
  useEffect(() => {
    setSel((s) => (rows ? Math.min(s, rows - 1) : 0))
  }, [rows])
  useEffect(() => {
    if (fileMode) setSel(0)
  }, [fileMode, fileQuery])

  const runAt = useCallback(
    (i: number, editor: boolean, via: Via) => {
      if (fileMode) {
        const f = files.options[i]
        if (!f || !handleId) return
        onClose()
        if (editor) return void openEditor(handleId, f.abs)
        requestSurfaceFocus(`file:${f.abs}`, via)
        const title = f.abs.slice(f.abs.lastIndexOf('/') + 1)
        useSession.getState().openSurface(handleId, { kind: 'file', key: f.abs, title, ...(line ? { location: { line } } : {}) }, 'focus', 'user', 'user')
        return
      }
      const row = filtered[i]
      if (!row) return
      if (!row.it.stay) onClose()
      row.it.run()
    },
    [fileMode, files, handleId, line, filtered, onClose]
  )

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => (rows ? (s + 1) % rows : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => (rows ? (s - 1 + rows) % rows : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runAt(sel, e.metaKey, 'keyboard')
    }
  }

  // Scroll the selected row into view.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${sel}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center scrim pt-[12vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={fileMode ? 'Open file' : 'Command palette'}
        data-ui="palette"
        data-mode={fileMode ? 'file' : commandMode ? 'command' : 'switch'}
        className="flex max-h-[70vh] w-[min(640px,92%)] flex-col overflow-hidden glass-thick rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <IconSearch className="h-4 w-4 shrink-0 text-dim" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={fileMode ? `Search files in ${folder}` : 'Search sessions…  (type > for commands)'}
            className="flex-1 bg-transparent text-sm text-content outline-none placeholder:text-dim"
            spellCheck={false}
            role="combobox"
            aria-autocomplete="list"
            aria-controls="palette-listbox"
            aria-expanded={rows > 0}
            aria-activedescendant={rows ? `palette-opt-${sel}` : undefined}
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-badge text-dim">
            esc
          </kbd>
        </div>

        <div
          ref={listRef}
          id="palette-listbox"
          role="listbox"
          aria-label={fileMode ? `Files in ${folder}` : commandMode ? 'Commands' : 'Sessions and commands'}
          aria-description={fileMode ? 'Enter opens in the pane. Command-Enter opens in your editor.' : undefined}
          className="min-h-0 flex-1 overflow-y-auto py-1.5"
        >
          {fileMode ? (
            <FileResults
              options={files.options}
              total={files.total}
              query={fileQuery.trim()}
              line={line}
              list={list}
              slow={slow}
              folder={folder}
              sel={sel}
              onHover={setSel}
              onRun={(i, e) => runAt(i, e.metaKey, viaOf(e))}
            />
          ) : filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-dim">
              No matches for “{rawQuery.trim()}”
            </div>
          ) : (
            filtered.map((row, i) => (
              <Row
                key={row.it.key}
                item={row.it}
                matches={row.matches}
                selected={i === sel}
                idx={i}
                onHover={() => setSel(i)}
                onClick={(e) => runAt(i, false, viaOf(e))}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function Row({
  item,
  matches,
  selected,
  idx,
  onHover,
  onClick
}: {
  item: PaletteItem
  matches: number[]
  selected: boolean
  idx: number
  onHover: () => void
  onClick: (e: React.MouseEvent) => void
}): JSX.Element {
  const runs = highlightRuns(item.label, matches)
  // State is conveyed by text + tone, never a repeated status dot (the sidebar owns
  // live-monitoring). Live sessions read at full strength; dormant ones dim. The label
  // tone alone makes the few live sessions "pop" with no colored mark, keeping the accent
  // scarce for the fuzzy-match highlight.
  const isSession = item.kind === 'session'
  const dim = isSession && !item.live
  // The verb names what Enter will do: Switch to a running session (instant) vs Resume
  // a dormant one (spawns a process). That materially-different consequence is the thing
  // the user must not be surprised by. Shown only on the focused row, so exactly one verb
  // tracks the cursor.
  const verb = isSession ? (item.live ? 'Switch' : 'Resume') : 'Run'
  // Full state in the accessible name for every row (the verb only renders when selected,
  // so SR row-by-row navigation still hears live/dormant + consequence).
  const aria = isSession
    ? item.live
      ? `${item.label}, live session, switch instantly`
      : `${item.label}, dormant session, resume (starts a new process)`
    : `${item.label}, command`

  return (
    // role=option in the input's listbox: keyboard focus stays in the combobox and
    // aria-activedescendant points here, so arrow selection is announced. The aria-label
    // carries the Switch/Resume/Run consequence for every row.
    <div
      data-idx={idx}
      role="option"
      id={`palette-opt-${idx}`}
      aria-selected={selected}
      aria-label={aria}
      onMouseMove={onHover}
      onClick={onClick}
      /* Keyboard-first surface: the selected row needs a perceivable marker; a ~1.08:1 fill
         alone isn't. A left-edge bar plus the row fill puts it where names are read. */
      className={`relative flex w-full cursor-pointer items-center gap-2.5 px-4 py-2 text-left ${
        selected ? 'bg-[var(--glass-row-hover)]' : ''
      }`}
    >
      {selected && (
        <span
          className="absolute inset-y-1 left-0 w-[3px] rounded-full bg-content"
          aria-hidden="true"
        />
      )}
      {/* Neutral, monochrome leading glyph: anchors the row + aligns with command icons;
          identical for live/dormant (it does not encode state). */}
      <span className="shrink-0 text-dim">
        {isSession ? <IconMessage className="h-3.5 w-3.5" /> : item.icon ? <item.icon className="h-3.5 w-3.5" /> : <Dot />}
      </span>
      <span className={`min-w-0 flex-1 truncate text-sm ${dim ? 'text-dim' : 'text-content'}`}>
        {runs.map((r, i) =>
          r.match ? (
            <span key={i} className="font-semibold text-content underline decoration-dim underline-offset-2">
              {r.text}
            </span>
          ) : (
            <span key={i}>{r.text}</span>
          )
        )}
      </span>
      {selected ? (
        // Focused row: the action affordance replaces the hint.
        <span className="flex shrink-0 items-center gap-1.5 text-meta text-dim">
          {verb}
          {/* text-dim (not faint) so the whole affordance clears AA 4.5:1 on the selected
              row's raised surface in both themes. */}
          <kbd className="rounded border border-border px-1 py-0.5 font-mono text-badge text-dim">
            ↵
          </kbd>
        </span>
      ) : (
        item.hint && (
          <span className="shrink-0 truncate text-meta text-dim">{item.hint}</span>
        )
      )}
    </div>
  )
}

function Dot(): JSX.Element {
  return (
    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
      <span className="h-1.5 w-1.5 rounded-full bg-faint" />
    </span>
  )
}

const MATCH = 'font-semibold text-content underline decoration-dim underline-offset-2'

function Runs({ text, matches }: { text: string; matches: number[] }): JSX.Element {
  return (
    <>
      {highlightRuns(text, matches).map((r, i) =>
        r.match ? (
          <span key={i} className={MATCH}>
            {r.text}
          </span>
        ) : (
          <span key={i}>{r.text}</span>
        )
      )}
    </>
  )
}

/** Open file's list: the session's files grouped with no query, ranked matches with one, and each state the
 *  listing can be in. */
function FileResults({
  options,
  total,
  query,
  line,
  list,
  slow,
  folder,
  sel,
  onHover,
  onRun
}: {
  options: FileOption[]
  total: number
  query: string
  line: number | null
  list: FileList | null
  slow: boolean
  folder: string
  sel: number
  onHover: (i: number) => void
  onRun: (i: number, e: React.MouseEvent) => void
}): JSX.Element {
  const note = (text: string): JSX.Element => <div className="px-4 py-2 text-meta text-dim">{text}</div>
  const capped =
    list?.t === 'ok' && list.truncated
      ? note(`This folder has more than ${count.format(WORKSPACE_FILE_CAP)} files, so only the first ${count.format(WORKSPACE_FILE_CAP)} are searched. Use the file tree to reach the rest.`)
      : null
  if (list?.t === 'error') return <div className="px-4 py-6 text-sm text-content">{`Couldn't list the files in ${folder}. ${list.message}`}</div>
  if (!options.length) {
    const say = !list
      ? slow
        ? 'Listing files…'
        : null
      : query
        ? `No files match “${query}”`
        : list.files.length
          ? `Type to search ${count.format(list.files.length)} files.`
          : `No files in ${folder}.`
    return (
      <>
        {say && <div className="px-4 py-6 text-center text-sm text-dim">{say}</div>}
        {capped}
      </>
    )
  }
  return (
    <>
      {options.map((f, i) => (
        <div key={f.abs} role="presentation">
          {f.group && f.group !== options[i - 1]?.group && (
            <div role="presentation" className="px-4 pb-0.5 pt-2 text-caps uppercase text-dim">
              {f.group}
            </div>
          )}
          <FileRow file={f} line={line} selected={i === sel} idx={i} onHover={() => onHover(i)} onClick={(e) => onRun(i, e)} />
        </div>
      ))}
      {total > options.length && note(`Showing ${options.length} of ${count.format(total)} matches. Keep typing to narrow them.`)}
      {capped}
    </>
  )
}

function FileRow({
  file,
  line,
  selected,
  idx,
  onHover,
  onClick
}: {
  file: FileOption
  line: number | null
  selected: boolean
  idx: number
  onHover: () => void
  onClick: (e: React.MouseEvent) => void
}): JSX.Element {
  const at = file.rel.lastIndexOf('/') + 1
  const name = file.rel.slice(at)
  const dir = at ? file.rel.slice(0, at - 1) : ''
  return (
    <div
      data-idx={idx}
      role="option"
      id={`palette-opt-${idx}`}
      aria-selected={selected}
      aria-label={`${file.rel}, file`}
      onMouseMove={onHover}
      onClick={onClick}
      className={`relative flex w-full cursor-pointer items-center gap-2.5 px-4 py-2 text-left ${selected ? 'bg-[var(--glass-row-hover)]' : ''}`}
    >
      {selected && <span className="absolute inset-y-1 left-0 w-[3px] rounded-full bg-content" aria-hidden="true" />}
      <FileIcon name={name} kind="file" />
      <span className="min-w-0 shrink truncate font-mono text-code text-content">
        <Runs text={name} matches={file.matches.filter((m) => m >= at).map((m) => m - at)} />
      </span>
      {dir ? (
        <span className="min-w-0 flex-1 truncate font-mono text-meta text-dim">
          <Runs text={dir} matches={file.matches.filter((m) => m < at - 1)} />
        </span>
      ) : (
        <span className="flex-1" />
      )}
      {selected && (
        <span className="flex shrink-0 items-center gap-1.5 text-meta text-dim">
          {line ? `Open at line ${line}` : 'Open'}
          <kbd className="rounded border border-border px-1 py-0.5 font-mono text-badge text-dim">↵</kbd>
        </span>
      )}
    </div>
  )
}
