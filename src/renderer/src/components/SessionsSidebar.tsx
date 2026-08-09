import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { ProjectGroup, SessionSummary } from '../../../shared/sessions'
import { useSession, forgetSessionCost } from '../store'
import {
  IconRefresh,
  IconChevron,
  IconEdit,
  IconTrash,
  IconClose,
  IconDownload,
  IconMore,
  IconGitFork
} from './Icon'
import { TypingDots } from './TypingDots'
import { Toast } from './Toast'
import { useEscape } from '../lib/useEscape'
import { useClickOutside } from '../lib/useClickOutside'

/**
 * A row in the merged sidebar list. On-disk sessions (from `listSessions`) and
 * live sessions (from the store's `sessions` map) are merged by CLI session id:
 * a session can be on disk, live, or both. Live-only sessions (brand new, not yet
 * flushed to disk) get synthesized rows so they show up immediately.
 */
interface MergedSession {
  /** CLI session id (on-disk filename stem); null for a brand-new live session. */
  id: string | null
  title: string
  renamed: boolean
  cwd: string
  /** Parent dir under ~/.claude/projects; null when the session isn't on disk yet. */
  projectSlug: string | null
  createdMs: number
  onDisk: boolean
  handleId?: string
  live: boolean
  busy: boolean
  pendingCount: number
  /** Running background tasks on this session (badged when it's not the active view). */
  bgCount: number
}

interface MergedGroup {
  cwd: string
  label: string
  /** From ProjectGroup; see its doc. Defaults true for a live-only group, which has no
   *  on-disk counterpart to ask and whose process already spawned. */
  exists: boolean
  sessions: MergedSession[]
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

/** How long a deleted session can be undone before the on-disk delete fires. */
const UNDO_MS = 6000

interface PendingDelete {
  id: string
  projectSlug: string
  title: string
}

export function SessionsSidebar({ collapsed: railMode = false }: { collapsed?: boolean }): JSX.Element {
  const [groups, setGroups] = useState<ProjectGroup[]>([])
  const [loading, setLoading] = useState(true)
  /** Collapsed project cwds. */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // Session pending an undoable delete (hidden from the list; not yet on-disk-
  // deleted). ONE at a time, the Gmail/Material snackbar model: a new undoable
  // action REPLACES the previous toast and commits the previous delete (Material:
  // never stack snackbars). Deleting a second session while one is pending is fine;
  // it just finalizes the first (its undo window ends early, an accepted tradeoff
  // the user chose over stacking).
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  // Ids whose on-disk delete is COMMITTED but whose refresh() hasn't landed yet.
  // These stay hidden so the row never flashes back for a frame between "no longer
  // the pending toast" and "gone from groups" (the reported reappear-bug). Cleared
  // once refresh() has dropped the row from `groups`.
  const [committingIds, setCommittingIds] = useState<Set<string>>(() => new Set())
  // The undo timer lives in a ref, NOT in state: side effects must never run
  // inside a setState updater (React StrictMode double-invokes updaters in dev,
  // which would spawn a second, orphaned timer that fires even after Undo).
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const activeHandleId = useSession((s) => s.activeHandleId)
  const activateSession = useSession((s) => s.activateSession)
  const resumeSession = useSession((s) => s.resumeSession)
  const closeSession = useSession((s) => s.closeSession)
  const forkSession = useSession((s) => s.forkSession)
  const setNotice = useSession((s) => s.setNotice)

  // Export a session to Markdown (on-disk sessions only). Reads the jsonl in main
  // (no resume/spawn, so it's safe on dormant sessions); a native Save dialog picks the path.
  const exportSession = useCallback(
    async (id: string, title: string) => {
      try {
        const path = await window.clui.exportSession(id)
        if (path) setNotice(`Exported “${title}” → ${path}`)
      } catch {
        setNotice(`Couldn’t export “${title}”.`)
      }
    },
    [setNotice]
  )

  const clearDeleteTimer = useCallback(() => {
    if (deleteTimer.current) {
      clearTimeout(deleteTimer.current)
      deleteTimer.current = null
    }
  }, [])

  // Commit the actual (irreversible) on-disk delete. The id is kept in
  // `committingIds` (hidden) across the async delete + refresh, and only removed
  // AFTER refresh() has dropped the row from `groups`, so the row is continuously
  // hidden and never flashes back, even when a second delete has already moved
  // `pendingDelete` on to a different session.
  const commitDelete = useCallback(async (pd: PendingDelete): Promise<void> => {
    setCommittingIds((cur) => new Set(cur).add(pd.id))
    await window.clui.deleteSession(pd.projectSlug, pd.id)
    // The session is now permanently gone; drop its remembered cost so the
    // in-memory cost map doesn't leak orphaned entries (done here, NOT on undo,
    // since undo keeps the session). pd.id is the CLI sessionId.
    forgetSessionCost(pd.id)
    await refresh()
    setCommittingIds((cur) => {
      const next = new Set(cur)
      next.delete(pd.id)
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Delete-with-undo: hide the row immediately and start a timer; the irreversible
  // on-disk delete only fires when it expires. Undo cancels the timer, so nothing is
  // ever lost to a stray click, and the row never reflows. Guideline: an irreversible
  // destructive action needs undo OR confirmation; this keeps recoverability while
  // removing the friction.
  const requestDelete = useCallback(
    (id: string, projectSlug: string, title: string, liveHandleId?: string) => {
      // A second delete while one is pending: commit the FIRST one now (single-toast
      // model). Its id enters `committingIds` synchronously inside commitDelete, so
      // it stays hidden across the async commit (no reappear-flash).
      const prev = pendingDelete
      clearDeleteTimer()
      if (prev && prev.id !== id) void commitDelete(prev)

      // If the session is live, stop its process NOW (delete = full teardown).
      // This drops the slice from the store immediately, so the "N live" counter +
      // group dots update at once. Undo can then only bring back the transcript on
      // disk (a resumable session), not the live process.
      if (liveHandleId) void closeSession(liveHandleId)

      const pd: PendingDelete = { id, projectSlug, title }
      setPendingDelete(pd)
      deleteTimer.current = setTimeout(() => {
        deleteTimer.current = null
        void commitDelete(pd)
        setPendingDelete((cur) => (cur?.id === pd.id ? null : cur))
      }, UNDO_MS)
    },
    [pendingDelete, clearDeleteTimer, commitDelete, closeSession]
  )

  const undoDelete = useCallback(() => {
    clearDeleteTimer()
    setPendingDelete(null)
    // If the deleted session was LIVE, we already stopped its process (delete =
    // teardown), so undo can't revive the process, but the transcript survives on
    // disk. Re-scan so the restored session reappears in the sidebar as a
    // resumable (dormant) row; otherwise Undo would have no visible effect and the
    // user is stranded (e.g. on the welcome screen after deleting the only session).
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearDeleteTimer])

  // Dismissing the toast (the ✕, or its countdown elapsing) means "I'm done, let
  // the delete proceed", NOT undo. So COMMIT the delete immediately (and cancel the
  // now-redundant timer). Only the explicit Undo button cancels the delete.
  // (Gotcha: onDismiss must NOT call undoDelete, which resurrects the session.)
  const dismissDelete = useCallback(() => {
    const pd = pendingDelete
    clearDeleteTimer()
    setPendingDelete(null)
    if (pd) void commitDelete(pd)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDelete, clearDeleteTimer, commitDelete])

  // On unmount, cancel any pending timer so it can't fire against a torn-down
  // component. The session is left on disk; the sidebar effectively never unmounts
  // in normal use, so this is belt-and-suspenders.
  useEffect(() => () => clearDeleteTimer(), [clearDeleteTimer])

  // A shallow-compared signature of the live sessions: re-renders the sidebar
  // only when a live session's identity/busy/pending-count changes, NOT on every
  // streamed token (the slice object changes each event, but this array of
  // primitive strings stays equal unless something we display actually changed).
  const liveSig = useSession(
    useShallow((s) =>
      Object.values(s.sessions).map(
        (v) =>
          `${v.handleId} ${v.sessionId ?? ''} ${v.cwd} ${v.busy ? 1 : 0} ${v.exited ? 1 : 0} ${v.pendingPermissions.length} ${Object.values(v.backgroundTasks).filter((t) => t.status === 'running').length} ${v.createdMs}`
      )
    )
  )
  // Count only genuinely-live sessions (a spawn-failed or exited slice lingers in
  // the store to keep its transcript, but must NOT count as live; that was the
  // "errored/deleted session still counted" bug). Derived directly from the store
  // so it handles cwds containing spaces (unlike parsing liveSig strings).
  const liveCount = useSession(
    (s) => Object.values(s.sessions).filter((v) => !v.exited).length
  )
  // A narrow key of persisted live session ids: changes only when the set of
  // on-disk-visible live sessions changes, so we re-scan disk then (not per token).
  const liveIdsKey = useSession((s) =>
    Object.values(s.sessions)
      .map((v) => v.sessionId)
      .filter(Boolean)
      .sort()
      .join(',')
  )

  // Activate a live session or resume a dormant one, refusing when its folder is gone.
  // Shared so the expanded row and the collapsed monogram open identically.
  const openMerged = useCallback(
    (s: MergedSession, exists: boolean): void => {
      if (s.live && s.handleId) activateSession(s.handleId)
      else if (!exists)
        setNotice(
          `Can't resume: ${s.cwd} no longer exists. The transcript is safe. You can still export or delete it from the row menu.`
        )
      else if (s.id) void resumeSession(s.cwd, s.id)
    },
    [activateSession, resumeSession, setNotice]
  )

  const toggleGroup = (cwd: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(cwd)) next.delete(cwd)
      else next.add(cwd)
      return next
    })
  }

  const refresh = useCallback(async () => {
    setLoading(true)
    const g = await window.clui.listSessions()
    setGroups(g)
    setLoading(false)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Re-scan disk when the set of live/persisted sessions changes (a new session
  // was created or one was closed) so freshly-persisted sessions get their titles.
  useEffect(() => {
    void refresh()
  }, [liveIdsKey, refresh])

  // Session ids to hide from the list: the one showing the undo toast PLUS any whose
  // on-disk delete has been committed but whose refresh() hasn't landed yet (so a
  // just-superseded delete stays hidden across its async commit; no reappear-flash).
  const pendingIds = useMemo(() => {
    const s = new Set(committingIds)
    if (pendingDelete) s.add(pendingDelete.id)
    return s
  }, [pendingDelete, committingIds])

  // Merge on-disk groups with live sessions (read the store non-reactively; liveSig
  // above drives the re-render). Depends on liveSig so it recomputes on live change.
  const merged = useMemo<MergedGroup[]>(() => {
    const live = Object.values(useSession.getState().sessions)
    const liveBySessionId = new Map<string, (typeof live)[number]>()
    for (const s of live) if (s.sessionId) liveBySessionId.set(s.sessionId, s)

    const byCwd = new Map<string, MergedSession[]>()
    const ensureGroup = (cwd: string): MergedSession[] => {
      let arr = byCwd.get(cwd)
      if (!arr) {
        arr = []
        byCwd.set(cwd, arr)
      }
      return arr
    }

    // 1) On-disk sessions, augmented with live info where the ids match. An
    // exited live session counts as on-disk-only (resume, don't activate).
    const matchedHandles = new Set<string>()
    for (const g of groups) {
      for (const s of g.sessions) {
        const liveMatch = liveBySessionId.get(s.id)
        if (liveMatch) matchedHandles.add(liveMatch.handleId)
        const stillLive = Boolean(liveMatch) && !liveMatch!.exited
        ensureGroup(s.cwd).push({
          id: s.id,
          title: s.title,
          renamed: s.renamed,
          cwd: s.cwd,
          projectSlug: s.projectSlug,
          // ALWAYS order by the on-disk createdMs (the file's original birthtime):
          // it's the immutable creation time. Do NOT use the live slice's createdMs
          // here: resuming a dormant session mints a fresh live slice with
          // createdMs=now, which shoots the row (and its group) to the top on every
          // activation. The on-disk value keeps every row in its fixed slot (the
          // never-reorder requirement). For a brand-new session the birthtime ≈ the
          // live now (sub-second), so no visible slide on first reconcile.
          createdMs: s.createdMs,
          onDisk: true,
          handleId: stillLive ? liveMatch!.handleId : undefined,
          live: stillLive,
          busy: liveMatch?.busy ?? false,
          pendingCount: liveMatch?.pendingPermissions.length ?? 0,
          bgCount: liveMatch
            ? Object.values(liveMatch.backgroundTasks).filter((t) => t.status === 'running').length
            : 0
        })
      }
    }

    // 2) Live-only sessions (brand new, or persisted-but-not-yet-rescanned): any
    // live session not matched to an on-disk row above shows as its own row. An
    // exited, never-persisted session is dropped (nothing to resume from).
    for (const s of live) {
      if (matchedHandles.has(s.handleId)) continue
      if (s.exited) continue
      const firstUser = s.messages.find((m) => m.role === 'user')?.text.trim()
      ensureGroup(s.cwd).push({
        id: s.sessionId,
        title: firstUser ? firstUser.slice(0, 80) : 'Untitled',
        renamed: false,
        cwd: s.cwd,
        projectSlug: null,
        createdMs: s.createdMs,
        onDisk: false,
        handleId: s.handleId,
        live: true,
        busy: s.busy,
        pendingCount: s.pendingPermissions.length,
        bgCount: Object.values(s.backgroundTasks).filter((t) => t.status === 'running').length
      })
    }

    const out: MergedGroup[] = []
    for (const [cwd, sessions] of byCwd) {
      // Hide sessions pending an undoable delete (not yet removed on disk). A null
      // id (live session before init) can never be pending, so it's always visible.
      const visible = sessions.filter((s) => !(s.id && pendingIds.has(s.id)))
      if (visible.length === 0) continue
      visible.sort((a, b) => b.createdMs - a.createdMs)
      // A cwd with no on-disk group is live-only (brand new, not yet flushed), and its
      // process spawned successfully, so the folder is there.
      const exists = groups.find((g) => g.cwd === cwd)?.exists ?? true
      out.push({ cwd, label: basename(cwd) || cwd, exists, sessions: visible })
    }
    out.sort((a, b) => (b.sessions[0]?.createdMs ?? 0) - (a.sessions[0]?.createdMs ?? 0))
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, liveSig, pendingIds])

  if (railMode) {
    // Same source and order as the expanded list (groups sorted, sessions within each
    // sorted), flattened to one monogram column with no group chrome. The undo toast
    // still renders so a delete triggered before collapsing stays cancelable.
    const flat = merged.flatMap((g) => g.sessions.map((s) => ({ s, exists: g.exists })))
    return (
      <div className="-mr-1 flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto pr-1">
        {flat.map(({ s, exists }) => (
          <SessionMonogram
            key={s.handleId ?? s.id ?? `${s.cwd}-x`}
            session={s}
            active={Boolean(s.handleId) && s.handleId === activeHandleId}
            onOpen={() => openMerged(s, exists)}
          />
        ))}
        {pendingDelete && (
          <Toast
            key={pendingDelete.id}
            message="Session deleted"
            highlight={pendingDelete.title}
            actionLabel="Undo"
            onAction={undoDelete}
            durationMs={UNDO_MS}
            onDismiss={dismissDelete}
          />
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-dim">
          Sessions
          {/* No color tint behind the label: text-ok on the bg-ok/15 pill was
              3.73:1 in light (fails AA). On the plain surface full text-ok clears
              4.95:1; the dot carries the "live" shape cue. */}
          {liveCount > 0 && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold tracking-normal text-ok">
              <span className="h-1.5 w-1.5 rounded-full bg-ok" style={{ animation: 'var(--animate-breathe)' }} />
              {liveCount} live
            </span>
          )}
        </span>
        <button
          className="flex h-6 w-6 items-center justify-center rounded text-dim transition-colors hover:text-content"
          onClick={() => void refresh()}
          title="Refresh sessions"
        >
          <IconRefresh className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="-mr-1 min-h-0 flex-1 overflow-y-auto pr-1">
        {loading && merged.length === 0 && (
          <div className="flex flex-col gap-1.5 px-1 py-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-7 animate-pulse rounded-md bg-bg-raised/60" />
            ))}
          </div>
        )}
        {!loading && merged.length === 0 && (
          <div className="px-2 py-6 text-center text-xs leading-relaxed text-dim">
            No sessions yet.
            <br />
            Start one to see it here.
          </div>
        )}
        {merged.map((g) => {
          const isCollapsed = collapsed.has(g.cwd)
          const groupLive = g.sessions.filter((s) => s.live).length
          return (
            <div key={g.cwd} className="mb-1.5">
              <button
                className="group/hdr flex w-full items-center gap-1.5 truncate rounded px-1 py-1 text-left text-[11px] font-semibold uppercase tracking-wide text-dim transition-colors hover:text-content focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
                title={g.cwd}
                onClick={() => toggleGroup(g.cwd)}
              >
                <IconChevron
                  className={`h-3 w-3 shrink-0 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                />
                <span className="truncate">{g.label}</span>
                {groupLive > 0 && (
                  /* Full opacity: bg-ok/70 was 2.89:1 in light (below the 3:1
                     non-text floor); the live-here dot must clear it. */
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ok" title={`${groupLive} live here`} />
                )}
                <span className="ml-auto pl-1 tabular-nums text-dim">{g.sessions.length}</span>
              </button>
              {!isCollapsed && (
                <div className="mt-0.5 flex flex-col gap-0.5">
                  {g.sessions.map((s) => (
                    <SessionRow
                      key={s.handleId ?? s.id ?? `${g.cwd}-x`}
                      session={s}
                      active={Boolean(s.handleId) && s.handleId === activeHandleId}
                      onOpen={() => openMerged(s, g.exists)}
                      onClose={s.live && s.handleId ? () => void closeSession(s.handleId!) : undefined}
                      onDelete={
                        s.onDisk && s.projectSlug && s.id
                          ? () => requestDelete(s.id!, s.projectSlug!, s.title, s.handleId)
                          : undefined
                      }
                      onExport={s.onDisk && s.id ? () => void exportSession(s.id!, s.title) : undefined}
                      // Branching spawns into the same cwd, so it's unavailable once the
                      // folder is gone. Export and delete only touch the transcript, so they stay.
                      onFork={
                        s.id && g.exists ? () => void forkSession(s.cwd, s.id!) : undefined
                      }
                      onChanged={refresh}
                    />
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Undo toast for a just-deleted session (nothing is removed from disk until
          this window elapses). A floating snackbar: position:fixed so it overlays
          the window bottom-center and never reflows the sidebar. Keyed by id so a
          second delete restarts the enter + drain animations. */}
      {pendingDelete && (
        <Toast
          key={pendingDelete.id}
          message="Session deleted"
          highlight={pendingDelete.title}
          actionLabel="Undo"
          onAction={undoDelete}
          durationMs={UNDO_MS}
          onDismiss={dismissDelete}
        />
      )}
    </div>
  )
}

function SessionRow({
  session,
  active,
  onOpen,
  onClose,
  onDelete,
  onExport,
  onFork,
  onChanged
}: {
  session: MergedSession
  active: boolean
  onOpen: () => void
  onClose?: () => void
  /** Request an undoable delete (on-disk sessions only). */
  onDelete?: () => void
  /** Export this session to Markdown (on-disk sessions only; reads jsonl, no resume). */
  onExport?: () => void
  /** Fork this session to a new branch (live or dormant; needs a session id). */
  onFork?: () => void
  onChanged: () => Promise<void>
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(session.title)

  const commitRename = async (): Promise<void> => {
    setEditing(false)
    if (session.id && name.trim() && name.trim() !== session.title) {
      await window.clui.renameSession(session.id, name.trim())
      await onChanged()
    } else {
      setName(session.title)
    }
  }
  const startRename = (): void => {
    setName(session.title)
    setEditing(true)
  }
  // Rename lives in the kebab menu for on-disk sessions.
  const onRename = session.onDisk ? startRename : undefined

  // R5 two-tier grammar: live/active sessions read full-strength; a dormant
  // (on-disk) session reads dimmer. NB: uses `dim` (6.65:1 on the sidebar), not
  // `faint` (3.7:1, fails WCAG AA), so dormant rows stay legible.
  const titleTone = active || session.live ? 'text-content' : 'text-dim'

  return (
    <div
      className={`group relative flex items-center gap-2 rounded-md py-1.5 pl-3 pr-1.5 transition-colors ${
        active
          ? 'bg-accent-surface'
          : session.live
            ? 'hover:bg-bg-raised'
            : 'hover:bg-bg-raised/60'
      }`}
    >
      {/* R2 active anchor */}
      {active && (
        <span className="absolute inset-y-1 left-0 w-[3px] rounded-full bg-accent" aria-hidden="true" />
      )}

      {/* R1 live presence: bouncing dots follow the typing-indicator convention */}
      <span className="flex w-3.5 shrink-0 items-center justify-center">
        {session.live &&
          (session.busy ? (
            <TypingDots className="scale-[0.7] text-ok" />
          ) : (
            <span
              className="inline-block h-1.5 w-1.5 rounded-full bg-ok opacity-60"
              title="Live (running)"
            />
          ))}
      </span>

      {editing ? (
        <input
          className="min-w-0 flex-1 rounded border border-accent bg-bg px-1.5 py-0.5 text-xs text-content outline-none"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commitRename()
            if (e.key === 'Escape') {
              setName(session.title)
              setEditing(false)
            }
          }}
        />
      ) : (
        <button
          className={`min-w-0 flex-1 truncate rounded text-left text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${titleTone}`}
          onClick={onOpen}
          title={`${session.title}${session.live ? '\n(live — click to view, no reload)' : '\n(click to resume)'}`}
        >
          {session.renamed && <span className="text-accent">✎ </span>}
          {session.title}
        </button>
      )}

      {/* R6 pending-permission */}
      {session.pendingCount > 0 && !editing && (
        <span
          className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-warn px-1 text-[10px] font-bold text-on-warn shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-warn)_28%,transparent)]"
          title={`${session.pendingCount} permission request${session.pendingCount > 1 ? 's' : ''} awaiting your approval`}
        >
          {session.pendingCount}
        </span>
      )}

      {/* Background-task badge (blue), only on NON-active sessions; the active
          session shows its bg tasks in the bottom info bar instead. */}
      {session.bgCount > 0 && !active && !editing && (
        <span
          className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-info px-1 text-[10px] font-bold text-white shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-info)_28%,transparent)]"
          title={`${session.bgCount} background task${session.bgCount > 1 ? 's' : ''} running`}
        >
          {session.bgCount}
        </span>
      )}

      {!editing && (
        // FREQUENCY-SPLIT hybrid: the ONE semi-frequent action, Close (live rows),
        // stays a direct inline icon (never menu-buried, Fitts). The RARE trio + fork
        // collapse into a single kebab with TEXT-labeled items, the only way to meet
        // the 44px target + get labels in a 288px row (four inline 14px glyphs can't).
        // Hover-REVEALED not hover-GATED (opacity, not display:none) so keyboard/touch
        // reach it (WCAG 2.1.1); the kebab button + menu carry their own aria.
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {onClose && (
            <button
              className="flex h-6 w-6 items-center justify-center rounded text-dim transition-colors hover:text-content focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              title="Close — stop the process, keep the transcript (resume later)"
              aria-label={`Close “${session.title}” (keep transcript)`}
              onClick={onClose}
            >
              <IconClose className="h-3.5 w-3.5" />
            </button>
          )}
          <RowMenu
            title={session.title}
            items={[
              onFork && { key: 'fork', label: 'Branch session', icon: <IconGitFork className="h-4 w-4" />, onClick: onFork },
              onExport && { key: 'export', label: 'Export to Markdown', icon: <IconDownload className="h-4 w-4" />, onClick: onExport },
              onRename && { key: 'rename', label: 'Rename', icon: <IconEdit className="h-4 w-4" />, onClick: onRename },
              onDelete && {
                key: 'delete',
                label: onClose ? 'Close & Delete' : 'Delete transcript',
                icon: <IconTrash className="h-4 w-4" />,
                onClick: onDelete,
                danger: true
              }
            ].filter(Boolean) as RowMenuItem[]}
          />
        </div>
      )}
    </div>
  )
}

/**
 * A 2-char session monogram for the collapsed rail: first char of the first word +
 * first char of the next word that isn't a version token (v2, 4.8, …); a single word
 * gives its first two chars. Uppercased. Two-letter collisions are expected; the full
 * title rides in the button's aria-label, so the label disambiguates.
 */
function monogram(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = words[0]
  const second = words.slice(1).find((w) => !/^v?\d+$/i.test(w))
  if (second) return (first[0] + second[0]).toUpperCase()
  return first.slice(0, 2).toUpperCase()
}

/**
 * Collapsed-rail tile for one session. A 30px monogram button carrying the whole
 * state grammar (dormant / live-idle / busy / pending / active) that the expanded row
 * spreads across dots and badges. Visible text is only the 2 letters; the aria-label
 * carries the real title + project so same-initial sessions stay distinguishable.
 */
function SessionMonogram({
  session,
  active,
  onOpen
}: {
  session: MergedSession
  active: boolean
  onOpen: () => void
}): JSX.Element {
  const pending = session.pendingCount > 0
  const project = basename(session.cwd)
  let label = `${session.title} — ${project}`
  if (pending)
    label += ` — ${session.pendingCount} permission request${session.pendingCount > 1 ? 's' : ''} awaiting approval`

  const tone = active || session.busy || pending ? 'text-content' : session.live ? 'text-dim' : 'text-faint'
  const fill = active
    ? 'bg-accent-surface'
    : session.busy || pending
      ? 'bg-bg-raised'
      : 'border border-border'

  return (
    <div className="relative flex shrink-0 items-center justify-center">
      {active && (
        <span className="absolute -left-[7px] top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-accent" aria-hidden="true" />
      )}
      <button
        className={`relative flex h-[30px] w-[30px] items-center justify-center rounded-lg text-[11px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${fill} ${tone} ${!active && !session.busy && !pending ? 'hover:bg-bg-raised' : ''}`}
        style={session.busy ? { animation: 'var(--animate-breathe)' } : undefined}
        aria-label={label}
        title={session.title}
        onClick={onOpen}
      >
        {monogram(session.title)}
        {/* Pending permission is the blocking state, so its amber count-badge wins the
            corner over the plain live dot. */}
        {pending ? (
          <span className="absolute -right-1 -top-1 flex h-[9px] min-w-[9px] items-center justify-center rounded-full bg-warn px-[3px] text-[8px] font-bold leading-none text-on-warn ring-[1.5px] ring-bg-sidebar">
            {session.pendingCount}
          </span>
        ) : session.live ? (
          <span
            className={`absolute -right-0.5 -top-0.5 h-[7px] w-[7px] rounded-full bg-ok ring-[1.5px] ${session.busy ? 'ring-bg-raised' : 'ring-bg-sidebar'}`}
            aria-hidden="true"
          />
        ) : null}
      </button>
    </div>
  )
}

interface RowMenuItem {
  key: string
  label: string
  icon: JSX.Element
  onClick: () => void
  danger?: boolean
}

/**
 * The session-row overflow (kebab) menu holds the rare actions (fork/export/rename/
 * delete) as TEXT-labeled items, so they clear the 44px target + get names four inline
 * icons couldn't. A11y: the trigger is a `menu`-button (aria-haspopup/expanded); the
 * open menu is `role="menu"` with roving focus (↑↓ move, Enter/Space activate, Esc/Tab
 * close, Home/End jump), click-outside closes, focus returns to the trigger on close.
 * Renders nothing if there are no items (e.g. a brand-new live-only row w/ no id).
 */
function RowMenu({
  title,
  items
}: {
  title: string
  items: RowMenuItem[]
}): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [focusIdx, setFocusIdx] = useState(0)
  // Which way the menu opens. The session list is `overflow-y-auto`, so an absolutely
  // positioned menu can't escape it: on a row near the bottom it gets clipped mid-item and
  // the last action is unreachable. Measured at open time because the row's distance from
  // the bottom depends on scroll position.
  const [up, setUp] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  const dismiss = useCallback(() => {
    setOpen(false)
    btnRef.current?.focus()
  }, [])
  useEscape(open, dismiss)
  useClickOutside(ref, open, dismiss)

  // Focus the roving item when the menu opens or the index moves.
  useEffect(() => {
    if (open) itemRefs.current[focusIdx]?.focus()
  }, [open, focusIdx])

  if (items.length === 0) return null

  const openMenu = (): void => {
    setFocusIdx(0)
    // ~34px per item + padding, floored so a 1-item menu still measures sanely.
    const needed = Math.max(items.length * 34 + 12, 60)
    const below = window.innerHeight - (btnRef.current?.getBoundingClientRect().bottom ?? 0)
    setUp(below < needed)
    setOpen(true)
  }

  const onMenuKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusIdx((i) => (i + 1) % items.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusIdx((i) => (i - 1 + items.length) % items.length)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setFocusIdx(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setFocusIdx(items.length - 1)
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        ref={btnRef}
        className="flex h-6 w-6 items-center justify-center rounded text-dim transition-colors hover:text-content focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for “${title}”`}
        title="More actions"
        onClick={(e) => {
          e.stopPropagation()
          open ? setOpen(false) : openMenu()
        }}
      >
        <IconMore className="h-4 w-4" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`Actions for “${title}”`}
          className={`absolute right-0 z-30 min-w-[188px] rounded-lg border border-border bg-bg-elev p-1 shadow-lg ${
            up ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
          onKeyDown={onMenuKey}
        >
          {items.map((it, i) => (
            <button
              key={it.key}
              ref={(el) => (itemRefs.current[i] = el)}
              role="menuitem"
              tabIndex={i === focusIdx ? 0 : -1}
              /* A destructive item reads as DANGER at rest (err token on label +
                 icon), and is fenced off by a divider above it so it can't be mis-hit
                 as a safe action. The roving-focused item keeps the global accent
                 focus ring (NOT suppressed here): the weak bg-raised fill alone was
                 ~1.08:1 and imperceptible; a keyboard user must see which action Enter
                 fires before an irreversible Delete. */
              className={`relative flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13px] transition-colors -outline-offset-2 ${
                it.danger
                  ? 'mt-1 border-t border-border pt-2 text-err hover:bg-err/10 focus-visible:bg-err/15'
                  : 'text-content hover:bg-bg-raised focus-visible:bg-bg-raised'
              }`}
              onClick={(e) => {
                e.stopPropagation()
                setOpen(false)
                it.onClick()
              }}
            >
              <span className={`shrink-0 ${it.danger ? 'text-err' : 'text-dim'}`}>{it.icon}</span>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
