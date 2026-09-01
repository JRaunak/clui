/**
 * ⌘K command palette: one door to everything (VS Code / Linear / Raycast style).
 *
 * Sessions are listed first (recency-ordered) so the common path (jump to a
 * session by name) is instant. A leading `>` scopes the query to COMMANDS only
 * (New session, Settings, Customizations, Toggle theme, Close session), matching
 * the VS Code convention, so both live on one key with no second shortcut.
 *
 * Fuzzy subsequence matching with highlighted characters (lib/fuzzy). Keyboard:
 * ↑/↓ move, Enter runs, Esc closes (via the shared escape-stack so a palette над a
 * modal closes the palette first). Themed for dark + light.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession, activeSlice } from '../store'
import { useEscape } from '../lib/useEscape'
import { applyTheme } from '../lib/theme'
import { fuzzyMatch, highlightRuns } from '../lib/fuzzy'
import { IconSearch, IconPlus, IconSettings, IconSliders, IconClose, IconMessage } from './Icon'
import type { ProjectGroup } from '../../../shared/sessions'

interface PaletteItem {
  key: string
  kind: 'session' | 'command'
  label: string
  /** Secondary line (workspace name, or command hint). */
  hint?: string
  /** Recency for ordering (ms). Higher = more recent. */
  recency: number
  live?: boolean
  run: () => void
}

export function CommandPalette({
  onClose,
  onNewSession,
  onNewNamedSession,
  onOpenSettings,
  onOpenCustomizations,
  onToggleSidebar,
  sidebarCollapsed
}: {
  onClose: () => void
  onNewSession: () => void
  onNewNamedSession: () => void
  onOpenSettings: () => void
  onOpenCustomizations: () => void
  onToggleSidebar: () => void
  sidebarCollapsed: boolean
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)
  const [disk, setDisk] = useState<ProjectGroup[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEscape(true, onClose)

  // Focus the input on open; load the on-disk session list once.
  useEffect(() => {
    inputRef.current?.focus()
    void window.clui.listSessions().then(setDisk)
  }, [])

  // Build the full item set (sessions first, then commands). Recomputed when the
  // query toggles command-scope or the disk list arrives; live sessions are read
  // non-reactively at build time (the palette is short-lived).
  const commandMode = query.startsWith('>')
  const rawQuery = commandMode ? query.slice(1) : query

  const items = useMemo<PaletteItem[]>(() => {
    const store = useSession.getState()
    const out: PaletteItem[] = []

    // ── Sessions (skipped in command mode) ──
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
              else store.resumeSession(s.cwd, s.id)
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
          // "Untitled" (not "New session") so an unnamed session's label can't collide
          // with the "New session" COMMAND; the palette must never show two identical
          // labels a fast keyboard user could confuse.
          label: firstUser ? firstUser.slice(0, 80) : 'Untitled',
          hint: s.cwd.split('/').pop() || s.cwd,
          recency: s.lastActivityMs,
          live: true,
          run: () => store.activateSession(s.handleId)
        })
      }
      out.sort((a, b) => b.recency - a.recency)
    }

    // ── Commands (always available; the only items in command mode) ──
    const activeId = store.activeHandleId
    const commands: PaletteItem[] = [
      {
        key: 'cmd:new',
        kind: 'command',
        label: 'New session',
        hint: 'Pick a workspace and start',
        recency: 0,
        run: onNewSession
      },
      {
        key: 'cmd:new-named',
        kind: 'command',
        label: 'New named session…',
        hint: '⌘⇧N',
        recency: 0,
        run: onNewNamedSession
      },
      {
        key: 'cmd:settings',
        kind: 'command',
        label: 'Open Settings',
        hint: '⌘,',
        recency: 0,
        run: onOpenSettings
      },
      {
        key: 'cmd:customizations',
        kind: 'command',
        label: 'Open Configuration',
        hint: 'Agents · Skills · Hooks · MCP — read-only audit',
        recency: 0,
        run: onOpenCustomizations
      },
      {
        key: 'cmd:theme',
        kind: 'command',
        label: 'Toggle light / dark theme',
        hint: 'Switches this session',
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
        recency: 0,
        run: onToggleSidebar
      },
      ...(activeId
        ? [
            {
              key: 'cmd:export',
              kind: 'command' as const,
              label: 'Export current session',
              hint: 'Save as Markdown',
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
              recency: 0,
              run: () => {
                const a = activeSlice(store)
                if (a?.sessionId && a.cwd) void store.forkSession(a.cwd, a.sessionId)
              }
            },
            {
              key: 'cmd:close',
              kind: 'command' as const,
              label: 'Close active session',
              hint: '⌘W',
              recency: 0,
              run: () => void store.closeSession(activeId)
            }
          ]
        : [])
    ]
    return [...out, ...commands]
  }, [commandMode, disk, onNewSession, onNewNamedSession, onOpenSettings, onOpenCustomizations])

  // Filter + rank by the (scope-stripped) query. Match the LABEL (title) first; its
  // matched indices drive the highlight. If the label doesn't match, fall back
  // to the HINT (workspace name) so "scr" still finds sessions in ~/clui-scratch;
  // a hint-only match scores lower and carries no label highlight.
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

  // Keep the selection in range as results change.
  useEffect(() => {
    setSel((s) => (filtered.length ? Math.min(s, filtered.length - 1) : 0))
  }, [filtered.length])

  const runAt = useCallback(
    (i: number) => {
      const row = filtered[i]
      if (!row) return
      onClose()
      row.it.run()
    },
    [filtered, onClose]
  )

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => (filtered.length ? (s + 1) % filtered.length : 0))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => (filtered.length ? (s - 1 + filtered.length) % filtered.length : 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runAt(sel)
    }
    // Esc handled by the escape-stack (useEscape).
  }

  // Scroll the selected row into view.
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${sel}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [sel])

  return (
    <div
      className="glass-scrim fixed inset-0 z-50 flex items-start justify-center pt-[12vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="glass-panel flex max-h-[70vh] w-[min(640px,92%)] flex-col overflow-hidden rounded-2xl border border-border-strong"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <IconSearch className="h-4 w-4 shrink-0 text-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search sessions…  (type > for commands)"
            className="flex-1 bg-transparent text-sm text-content outline-none placeholder:text-faint"
            spellCheck={false}
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-faint">
            esc
          </kbd>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1.5">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-faint">
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
                onClick={() => runAt(i)}
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
  onClick: () => void
}): JSX.Element {
  const runs = highlightRuns(item.label, matches)
  // State is conveyed by TEXT + TONE, never a repeated status dot (the sidebar
  // owns live-monitoring). Live sessions read at full strength; dormant ones dim.
  // The label tone alone makes the few live sessions "pop" (Von Restorff) with no
  // colored mark, keeping the accent scarce for the fuzzy-match highlight.
  const isSession = item.kind === 'session'
  const dim = isSession && !item.live
  // The verb NAMES what Enter will do (Raycast primary-action model): Switch to a
  // running session (instant) vs Resume a dormant one (spawns a process). That
  // materially-different consequence is the thing the user must not be surprised by.
  // Shown only on the focused row, so exactly one verb tracks the cursor.
  const verb = isSession ? (item.live ? 'Switch' : 'Resume') : 'Run'
  // Full state in the accessible name for EVERY row (the verb only renders when
  // selected, so SR row-by-row navigation still hears live/dormant + consequence).
  const aria = isSession
    ? item.live
      ? `${item.label} — live session, switch instantly`
      : `${item.label} — dormant session, resume (starts a new process)`
    : `${item.label} — command`

  return (
    <button
      data-idx={idx}
      aria-label={aria}
      onMouseMove={onHover}
      onClick={onClick}
      /* Keyboard-first surface: the selected row needs a perceivable marker; a
         ~1.08:1 fill alone isn't. Reuse the sidebar's active-item language (a scarce
         terracotta left-edge bar plus the raised fill) so the eye tracks selection
         where names are read (the left). */
      className={`relative flex w-full items-center gap-2.5 px-4 py-2 text-left ${
        selected ? 'glass-row-selected' : ''
      }`}
    >
      {selected && (
        <span
          className="absolute inset-y-1 left-0 w-[3px] rounded-full bg-accent"
          aria-hidden="true"
        />
      )}
      {/* Neutral, monochrome leading glyph: anchors the row + aligns with command
          icons; identical for live/dormant (it does NOT encode state). */}
      <span className="shrink-0 text-faint">
        {isSession ? <IconMessage className="h-3.5 w-3.5" /> : <CommandIcon label={item.label} />}
      </span>
      <span className={`min-w-0 flex-1 truncate text-sm ${dim ? 'text-dim' : 'text-content'}`}>
        {runs.map((r, i) =>
          r.match ? (
            <span key={i} className="font-semibold text-accent">
              {r.text}
            </span>
          ) : (
            <span key={i}>{r.text}</span>
          )
        )}
      </span>
      {selected ? (
        // Focused row: the action affordance replaces the hint.
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-dim">
          {verb}
          {/* text-dim (not faint) so the whole affordance clears AA 4.5:1 on the
              selected row's raised surface in both themes (verified). */}
          <kbd className="rounded border border-border px-1 py-0.5 font-mono text-[10px] text-dim">
            ↵
          </kbd>
        </span>
      ) : (
        item.hint && (
          <span className="shrink-0 truncate font-mono text-[11px] text-faint">{item.hint}</span>
        )
      )}
    </button>
  )
}

function CommandIcon({ label }: { label: string }): JSX.Element {
  if (label.startsWith('New')) return <IconPlus className="h-3.5 w-3.5" />
  if (label.startsWith('Open Settings')) return <IconSettings className="h-3.5 w-3.5" />
  if (label.startsWith('Open Customizations')) return <IconSliders className="h-3.5 w-3.5" />
  if (label.startsWith('Close')) return <IconClose className="h-3.5 w-3.5" />
  return <span className="block h-1.5 w-1.5 rounded-full bg-accent/60" />
}
