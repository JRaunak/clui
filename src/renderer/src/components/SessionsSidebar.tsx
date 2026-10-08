import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { SessionSummary } from '../../../shared/sessions'
import { useSession, forgetSessionModel, sessionDisplayTitle } from '../store'
import { sessionStatusOf, statusKey, statusText, type SessionStatus } from '../lib/sessionStatus'
import {
  IconRefresh,
  IconChevron,
  IconEdit,
  IconTrash,
  IconClose,
  IconDownload,
  IconMore,
  IconGitFork,
  IconPlus,
  IconHand,
  IconWarn,
  IconSendToTray,
  IconGhost
} from './Icon'
import { ToastStack, useBrowserToasts } from './Toast'
import { useGuardedAsync } from '../lib/useGuardedAsync'
import { usePopover } from './Popover'
import { runTagged, viaOf, type Via } from '../lib/motion'
import { getStage } from '../lib/stage'

/** A row in the merged sidebar list. On-disk sessions and live sessions are merged by CLI session id;
 *  live-only sessions get synthesized rows so they show up immediately. */
interface MergedSession {
  /** CLI session id (on-disk filename stem); null for a brand-new live session. */
  id: string | null
  title: string
  renamed: boolean
  /** Hard title (sidecar rename / on-disk customTitle) re-asserted as `-n` on resume;
   *  absent for a live-only row or a derived-title session. */
  hardTitle?: string
  cwd: string
  /** Parent dir under ~/.claude/projects; null when not on disk yet. */
  projectSlug: string | null
  createdMs: number
  onDisk: boolean
  handleId?: string
  live: boolean
  /** Quick session (spawned --no-session-persistence): no jsonl, so it can't be exported,
   *  deleted, branched, or renamed, and it vanishes on close. */
  ephemeral: boolean
  busy: boolean
  pendingCount: number
  /** Running background tasks on this session. Badged when not the active view. */
  bgCount: number
  /** The session's state for its mark and line 2; null for a dormant (on-disk only) row. */
  status: SessionStatus | null
}

interface MergedGroup {
  cwd: string
  label: string
  /** Defaults true for a live-only group whose process already spawned. */
  exists: boolean
  /** The directoryless group (cwd === chatDir): pinned to the top, labeled "Workbench",
   *  no per-group "+" (the New session button covers it). */
  isChatDir: boolean
  sessions: MergedSession[]
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

/** How long a deleted session can be undone before the on-disk delete fires. */
const UNDO_MS = 5000
/** Most undo toasts kept at once; a further delete commits the oldest immediately. */
const STACK_CAP = 3

interface PendingDelete {
  id: string
  projectSlug: string
  title: string
  at: number
}

export function SessionsSidebar({ collapsed: railMode = false }: { collapsed?: boolean }): JSX.Element {
  /** Collapsed project cwds. */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // Sessions pending an undoable delete, newest first, hidden from the list. Each commits on its own
  // 5s expiry, so a later delete never commits an earlier one.
  const [pending, setPendingState] = useState<PendingDelete[]>([])
  // Ref mirror so back-to-back deletes read the current list without waiting for a state flush, and so
  // the cap/expiry math stays out of a setState updater (updaters must be side-effect-free).
  const pendingRef = useRef<PendingDelete[]>([])
  const setPending = useCallback((next: PendingDelete[]): void => {
    pendingRef.current = next
    setPendingState(next)
  }, [])
  // Ids committed to on-disk delete but not yet dropped by refreshSessions(); kept hidden so rows
  // don't flash back between leaving the toast and leaving `groups`.
  const [committingIds, setCommittingIds] = useState<Set<string>>(() => new Set())
  // One expiry timer per pending id.
  const deleteTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  // sr-only announcement for the latest delete; coalesces rapid ones to the most recent.
  const [announce, setAnnounce] = useState({ text: '', at: 0 })
  // Toggling suffix so two same-titled deletes still differ as text; an unchanged aria-live node is silent.
  const announceSeq = useRef(0)

  const activeHandleId = useSession((s) => s.activeHandleId)
  const activateSession = useSession((s) => s.activateSession)
  const resumeSession = useSession((s) => s.resumeSession)
  const closeSession = useSession((s) => s.closeSession)
  const forkSession = useSession((s) => s.forkSession)
  const startSession = useSession((s) => s.startSession)
  // One guard shared by every group "+": startSession awaits the spawn before any store write,
  // so an unguarded double-click on a group header starts two sessions in that folder.
  const [startInGroup, groupSpawnPending] = useGuardedAsync((cwd: string) => startSession(cwd))
  const setNotice = useSession((s) => s.setNotice)
  // Store-owned so a store-side trigger (a `/rename` turn) can refresh the same copy this renders.
  const groups = useSession((s) => s.sessionGroups)
  const loading = useSession((s) => s.sessionsLoading)
  const refreshSessions = useSession((s) => s.refreshSessions)
  const chatDir = useSession((s) => s.chatDir)
  const modToasts = useSession((s) => s.modToasts)
  const modAnnounce = useSession((s) => s.modToastAnnounce)
  const dismissModToast = useSession((s) => s.dismissModToast)
  const browserToasts = useBrowserToasts()

  // Export a session to Markdown (on-disk sessions only). Reads the jsonl in main (safe on dormant sessions).
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

  const clearDeleteTimer = useCallback((id: string) => {
    const t = deleteTimers.current.get(id)
    if (t) {
      clearTimeout(t)
      deleteTimers.current.delete(id)
    }
  }, [])

  // Commit the irreversible on-disk delete. The id stays in `committingIds` (hidden) until
  // refreshSessions() drops the row from `groups`, so it never flashes back.
  const commitDelete = useCallback(async (pd: PendingDelete): Promise<void> => {
    setCommittingIds((cur) => new Set(cur).add(pd.id))
    await window.clui.deleteSession(pd.projectSlug, pd.id)
    // Session is gone: drop its remembered model/effort so the sidecar doesn't leak.
    forgetSessionModel(pd.id)
    await refreshSessions()
    setCommittingIds((cur) => {
      const next = new Set(cur)
      next.delete(pd.id)
      return next
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Hide the row and start its own timer; the on-disk delete fires only when that expires.
  const requestDelete = useCallback(
    (id: string, projectSlug: string, title: string, liveHandleId?: string) => {
      // If live, stop the process now so the live counter and dots update at once. Undo restores only the on-disk transcript.
      if (liveHandleId) void closeSession(liveHandleId)

      const pd: PendingDelete = { id, projectSlug, title, at: Date.now() }
      let next = [pd, ...pendingRef.current.filter((p) => p.id !== id)]
      // Over the cap: the oldest commits now.
      if (next.length > STACK_CAP) {
        for (const overflow of next.slice(STACK_CAP)) {
          clearDeleteTimer(overflow.id)
          void commitDelete(overflow)
        }
        next = next.slice(0, STACK_CAP)
      }
      setPending(next)

      const t = setTimeout(() => {
        deleteTimers.current.delete(id)
        void commitDelete(pd)
        setPending(pendingRef.current.filter((p) => p.id !== id))
      }, UNDO_MS)
      deleteTimers.current.set(id, t)
      setAnnounce({ text: `Deleted ${title}. Undo available.${'\u200b'.repeat(++announceSeq.current % 2)}`, at: pd.at })
    },
    [clearDeleteTimer, commitDelete, closeSession, setPending]
  )

  const undoDelete = useCallback(
    (id: string) => {
      clearDeleteTimer(id)
      setPending(pendingRef.current.filter((p) => p.id !== id))
      // The process is stopped, but the transcript survives on disk. Re-scan so the row reappears as resumable.
      void refreshSessions()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [clearDeleteTimer, setPending]
  )

  // Cancel any pending timers on unmount.
  useEffect(() => {
    const timers = deleteTimers.current
    return () => timers.forEach(clearTimeout)
  }, [])

  // Shallow signature of the live sessions: re-renders only when identity/busy/pending-count changes.
  const liveSig = useSession(
    useShallow((s) =>
      Object.values(s.sessions).map(
        (v) =>
          `${v.handleId} ${v.sessionId ?? ''} ${v.cwd} ${v.busy ? 1 : 0} ${v.exited ? 1 : 0} ${v.pendingPermissions.length} ${Object.values(v.backgroundTasks).filter((t) => t.status === 'running').length} ${v.createdMs} ${v.title ?? ''} ${statusKey(v)}`
      )
    )
  )
  // A tuple through useShallow, so the header summary re-renders only when a count moves.
  const [liveCount, workingCount, needsCount] = useSession(
    useShallow((s) => {
      let live = 0
      let working = 0
      let needs = 0
      for (const v of Object.values(s.sessions)) {
        if (v.exited) continue
        live++
        const k = sessionStatusOf(v).kind
        if (k === 'working') working++
        else if (k === 'needs') needs++
      }
      return [live, working, needs]
    })
  )
  // Narrow key of persisted live session ids: changes only when the set of on-disk-visible live sessions changes.
  const liveIdsKey = useSession((s) =>
    Object.values(s.sessions)
      .map((v) => v.sessionId)
      .filter(Boolean)
      .sort()
      .join(',')
  )

  // Activate a live session or resume a dormant one, refusing when its folder is gone.
  const openMerged = useCallback(
    (s: MergedSession, exists: boolean, via: Via = 'keyboard'): void => {
      if (s.live && s.handleId) {
        const h = s.handleId
        const focusComposer = (): void => document.querySelector<HTMLElement>('[data-composer-input]')?.focus()
        // Re-clicking the active row still runs activateSession (it closes an open subagent
        // view) but doesn't animate: nothing is switching.
        if (h === useSession.getState().activeHandleId) {
          activateSession(h)
          return
        }
        runTagged('switch', { via, scope: getStage(), update: () => activateSession(h), after: focusComposer })
      } else if (!exists)
        setNotice(
          `Can't resume: ${s.cwd} no longer exists. The transcript is safe. You can still export or delete it from the row menu.`
        )
      else if (s.id) void resumeSession(s.cwd, s.id, undefined, s.hardTitle)
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

  useEffect(() => {
    void refreshSessions()
  }, [refreshSessions])

  // Re-scan disk when the set of live/persisted sessions changes so freshly-persisted sessions get their titles.
  useEffect(() => {
    void refreshSessions()
  }, [liveIdsKey, refreshSessions])

  // Ids to hide: those showing an undo toast plus any committed but not yet dropped by refreshSessions().
  const pendingIds = useMemo(() => {
    const s = new Set(committingIds)
    for (const p of pending) s.add(p.id)
    return s
  }, [pending, committingIds])

  // Merge on-disk groups with live sessions (read the store non-reactively; liveSig drives the re-render).
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

    // On-disk sessions, augmented with live info where the ids match. An exited live session counts as on-disk-only.
    const matchedHandles = new Set<string>()
    for (const g of groups) {
      for (const s of g.sessions) {
        const liveMatch = liveBySessionId.get(s.id)
        if (liveMatch) matchedHandles.add(liveMatch.handleId)
        const stillLive = Boolean(liveMatch) && !liveMatch!.exited
        ensureGroup(s.cwd).push({
          id: s.id,
          // Live slice's title wins so a rename shows before the CLI mirrors it to customTitle
          // and the next scan makes it authoritative.
          title: stillLive && liveMatch!.title ? liveMatch!.title : s.title,
          renamed: s.renamed,
          hardTitle: s.hardTitle,
          cwd: s.cwd,
          projectSlug: s.projectSlug,
          // Order by on-disk createdMs, never the live slice's: resuming mints a fresh slice with createdMs=now.
          createdMs: s.createdMs,
          onDisk: true,
          handleId: stillLive ? liveMatch!.handleId : undefined,
          live: stillLive,
          ephemeral: false,
          busy: liveMatch?.busy ?? false,
          pendingCount: liveMatch?.pendingPermissions.length ?? 0,
          bgCount: liveMatch
            ? Object.values(liveMatch.backgroundTasks).filter((t) => t.status === 'running').length
            : 0,
          status: stillLive ? sessionStatusOf(liveMatch!) : null
        })
      }
    }

    // Live-only sessions: any live session not matched to an on-disk row shows as its own row. An exited,
    // never-persisted one is dropped.
    for (const s of live) {
      if (matchedHandles.has(s.handleId)) continue
      if (s.exited) continue
      ensureGroup(s.cwd).push({
        id: s.sessionId,
        // Spawn-time title shows immediately before the jsonl lands; otherwise fall back to the first user message.
        title: sessionDisplayTitle(s),
        renamed: false,
        cwd: s.cwd,
        projectSlug: null,
        createdMs: s.createdMs,
        onDisk: false,
        handleId: s.handleId,
        live: true,
        ephemeral: s.ephemeral,
        busy: s.busy,
        pendingCount: s.pendingPermissions.length,
        bgCount: Object.values(s.backgroundTasks).filter((t) => t.status === 'running').length,
        status: sessionStatusOf(s)
      })
    }

    const out: MergedGroup[] = []
    for (const [cwd, sessions] of byCwd) {
      // Hide sessions pending an undoable delete. A null id can never be pending.
      const visible = sessions.filter((s) => !(s.id && pendingIds.has(s.id)))
      if (visible.length === 0) continue
      visible.sort((a, b) => b.createdMs - a.createdMs)
      // A cwd with no on-disk group is live-only and its process spawned successfully, so the folder exists.
      const exists = groups.find((g) => g.cwd === cwd)?.exists ?? true
      const isChatDir = !!chatDir && cwd === chatDir
      out.push({
        cwd,
        label: isChatDir ? 'Workbench' : basename(cwd) || cwd,
        exists,
        isChatDir,
        sessions: visible
      })
    }
    out.sort((a, b) => (b.sessions[0]?.createdMs ?? 0) - (a.sessions[0]?.createdMs ?? 0))
    // Pin the directoryless group above the recency-sorted project groups.
    const chatIdx = out.findIndex((g) => g.isChatDir)
    if (chatIdx > 0) out.unshift(out.splice(chatIdx, 1)[0])
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, liveSig, pendingIds, chatDir])

  // One ToastStack for both branches, kept as each fragment's last child so a rail toggle reconciles it
  // in place instead of remounting it.
  const stack = (
    <ToastStack
      items={[
        ...pending.map((p) => ({ kind: 'undo' as const, id: p.id, title: p.title, suffix: '· deleted', at: p.at })),
        ...browserToasts.items,
        ...modToasts.map((t) => ({ kind: 'mod' as const, ...t }))
      ].sort((a, b) => b.at - a.at)}
      durationMs={UNDO_MS}
      announce={[modAnnounce, browserToasts.announce].reduce((a, b) => (b.at > a.at ? b : a), announce).text}
      onUndo={(id) => (browserToasts.items.some((t) => t.id === id) ? browserToasts.onUndo(id) : undoDelete(id))}
      onDismiss={dismissModToast}
    />
  )

  if (railMode) {
    // Same source and order as the expanded list, flattened to one monogram column.
    const flat = merged.flatMap((g) => g.sessions.map((s) => ({ s, exists: g.exists })))
    return (
      <>
        <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto scrollbar-none pt-2.5 pb-3">
          {flat.map(({ s, exists }) => (
            <SessionMonogram
              key={s.handleId ?? s.id ?? `${s.cwd}-x`}
              session={s}
              active={Boolean(s.handleId) && s.handleId === activeHandleId}
              onOpen={(e) => openMerged(s, exists, viaOf(e))}
            />
          ))}
        </div>
        {stack}
      </>
    )
  }

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-col gap-1 px-1 pb-2">
          <div className="flex items-center justify-between">
            <span className="text-caps uppercase text-dim">Sessions</span>
            <button
              className="flex h-6 w-6 items-center justify-center rounded text-dim transition-colors hover:text-content"
              onClick={() => void refreshSessions()}
              title="Refresh sessions"
            >
              <IconRefresh className="h-3.5 w-3.5" />
            </button>
          </div>
          {/* Plain text, not a live region: it changes every turn, and announcing that would chatter. */}
          {liveCount > 0 && (
            <div data-ui="sidebar-summary" className="flex flex-wrap items-center gap-x-1.5 text-meta text-dim">
              <span data-ui="live-count" className="inline-flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden="true" />
                {liveCount} live
              </span>
              {workingCount > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1">
                    <span className="flex h-1.5 w-1.5 items-center justify-center rounded-full border border-dim" aria-hidden="true">
                      <span className="h-0.5 w-0.5 rounded-full bg-accent" />
                    </span>
                    {workingCount} working
                  </span>
                </>
              )}
              {needsCount > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="inline-flex items-center gap-1 text-warn">
                    <IconHand className="h-3 w-3" />
                    {needsCount} needs you
                  </span>
                </>
              )}
            </div>
          )}
        </div>
        <div className="-mr-1 min-h-0 flex-1 overflow-y-auto pr-1">
          {loading && merged.length === 0 && (
            <div className="flex flex-col gap-1.5 px-1 py-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-7 rounded-md bg-bg-raised/60" />
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
            const groupNeeds = g.sessions.filter((s) => s.status?.kind === 'needs').length
            const groupFailed = g.sessions.filter((s) => s.status?.kind === 'failed').length
            return (
              <div key={g.cwd} className="mb-1.5">
                <div className="group/hdr flex w-full items-center gap-1.5 rounded pr-1" title={g.cwd}>
                  {/* Toggle takes flex-1 so the label truncates; the "+" is a sibling (button-in-button is invalid). */}
                  <button
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded px-1 py-1 text-left text-label font-medium text-dim transition-colors -outline-offset-2 hover:text-content"
                    onClick={() => toggleGroup(g.cwd)}
                  >
                    <IconChevron
                      className={`h-3 w-3 shrink-0 transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                    />
                    <span className="truncate">{g.label}</span>
                  </button>
                  {/* The group header counts only the states that need attention. */}
                  {groupNeeds > 0 && (
                    <span className="flex shrink-0 items-center gap-0.5 text-badge text-warn" title={`${groupNeeds} waiting on you`}>
                      <IconHand className="h-3 w-3" />
                      {groupNeeds}
                      <span className="sr-only"> waiting on you</span>
                    </span>
                  )}
                  {groupFailed > 0 && (
                    <span className="flex shrink-0 items-center gap-0.5 text-badge text-err" title={`${groupFailed} with a failed turn`}>
                      <IconWarn className="h-3 w-3" />
                      {groupFailed}
                      <span className="sr-only"> with a failed turn</span>
                    </span>
                  )}
                  {/* Fixed slot reserved so the count stays put when the "+" fades in. Only for a live
                      project cwd; the directoryless group has no "+" (the New session button covers it). */}
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center">
                    {g.exists && !g.isChatDir && (
                      <button
                        className={`flex h-6 w-6 items-center justify-center rounded text-dim opacity-0 transition-opacity hover:text-content focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent group-hover/hdr:opacity-100 group-focus-within/hdr:opacity-100 ${
                          groupSpawnPending ? 'pointer-events-none opacity-40' : ''
                        }`}
                        aria-label={`New session in ${g.label}`}
                        aria-busy={groupSpawnPending || undefined}
                        title="New session here"
                        onClick={() => void startInGroup(g.cwd)}
                      >
                        <IconPlus className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                  <span className="shrink-0 text-meta font-medium tabular-nums text-dim">
                    {g.sessions.length}
                  </span>
                </div>
                {!isCollapsed && (
                  <div className="mt-0.5 flex flex-col gap-0.5">
                    {g.sessions.map((s) => (
                      <SessionRow
                        key={s.handleId ?? s.id ?? `${g.cwd}-x`}
                        session={s}
                        active={Boolean(s.handleId) && s.handleId === activeHandleId}
                        onOpen={(e) => openMerged(s, g.exists, viaOf(e))}
                        onClose={s.live && s.handleId ? () => void closeSession(s.handleId!) : undefined}
                        onDelete={
                          s.onDisk && s.projectSlug && s.id
                            ? () => requestDelete(s.id!, s.projectSlug!, s.title, s.handleId)
                            : undefined
                        }
                        onExport={s.onDisk && s.id ? () => void exportSession(s.id!, s.title) : undefined}
                        // Branching spawns into the same cwd, so it's unavailable once the folder is gone. Export and delete only touch the transcript.
                        // An ephemeral session has no jsonl to branch from, so it's omitted there too.
                        onFork={
                          s.id && g.exists && !s.ephemeral ? () => void forkSession(s.cwd, s.id!) : undefined
                        }
                        onChanged={refreshSessions}
                      />
                    ))}
                  </div>
                )}
                {/* Hairline separating the pinned directoryless group from the project groups below;
                    skipped when there's nothing below it to separate. */}
                {g.isChatDir && merged.length > 1 && (
                  <div className="mt-2 border-b border-border" aria-hidden="true" />
                )}
              </div>
            )
          })}
        </div>
      </div>
      {stack}
    </>
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
  onOpen: (e: React.MouseEvent) => void
  onClose?: () => void
  /** Request an undoable delete. On-disk sessions only. */
  onDelete?: () => void
  /** Export this session to Markdown. On-disk sessions only; reads jsonl, no resume. */
  onExport?: () => void
  /** Fork this session to a new branch. Needs a session id. */
  onFork?: () => void
  onChanged: () => Promise<void>
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(session.title)
  const titleBtnRef = useRef<HTMLButtonElement>(null)
  const lineId = useId()
  // Return focus to the title after a keyboard commit/cancel (Enter/Esc drop focus to body);
  // a mouse blur-commit leaves focus on whatever was clicked, so don't steal it back.
  const wasEditing = useRef(false)
  useEffect(() => {
    if (wasEditing.current && !editing && document.activeElement === document.body) titleBtnRef.current?.focus()
    wasEditing.current = editing
  }, [editing])

  const commitRename = async (): Promise<void> => {
    setEditing(false)
    const next = name.trim()
    if (session.id && next && next !== session.title) {
      if (session.handleId) {
        // Live: push onto the running process, which writes customTitle. No sidecar needed.
        useSession.getState().renameLiveSession(session.handleId, next)
      } else {
        // Dormant: hold it in the sidecar; it flushes to customTitle on next resume.
        await window.clui.renameSession(session.id, next)
      }
      await onChanged()
    } else {
      setName(session.title)
    }
  }
  const startRename = (): void => {
    setName(session.title)
    setEditing(true)
  }
  // Rename lives in the kebab menu for on-disk sessions only.
  const onRename = session.onDisk ? startRename : undefined

  // Dormant titles are `dim` (6.65:1), not `faint`.
  const titleTone = active || session.live ? 'text-content' : 'text-dim'
  const st = session.status

  return (
    <div
      data-ui="sidebar-row"
      className={`group relative flex cursor-pointer items-center gap-2 rounded-md py-1.5 pl-3 pr-1.5 transition-colors ${st ? 'min-h-11' : ''} ${
        active ? 'surface-row-selected' : 'hover:bg-bg-raised'
      }`}
      // The whole row opens the session for a pointer; the title button stays the one keyboard stop.
      // Clicks on the row's own controls, its menu, or the rename field are theirs.
      onClick={(e) => {
        if (editing || (e.target as HTMLElement).closest('button, input, a, [popover]')) return
        onOpen(e)
      }}
    >
      {active && <span className="absolute inset-y-1 left-0 w-[3px] rounded-full bg-accent" aria-hidden="true" />}

      {/* The mark's shape carries the state, so it never rests on colour alone. */}
      <span className="flex h-[18px] min-w-3.5 shrink-0 items-center justify-center gap-0.5">
        {st && <RowMark status={st} spin={!active} />}
      </span>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-1">
          {session.ephemeral && !editing && <IconGhost className="h-3 w-3 shrink-0 text-dim" />}
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
              ref={titleBtnRef}
              className={`min-w-0 flex-1 cursor-pointer truncate rounded text-left text-xs ${titleTone}`}
              // Rename is the kebab or F2, never a title click: on a dormant row the click resumes.
              onClick={onOpen}
              aria-current={active || undefined}
              onKeyDown={(e) => {
                if (e.key === 'F2' && onRename) {
                  e.preventDefault()
                  onRename()
                }
              }}
              aria-describedby={st ? lineId : undefined}
              title={`${session.title}${session.live ? '\n(live: click to view, no reload)' : '\n(click to resume)'}`}
            >
              {session.title}
            </button>
          )}
        </div>
        {st && !editing && (
          <div className="flex min-w-0 items-center gap-2 text-meta">
            <span
              id={lineId}
              className="min-w-0 flex-1 truncate"
              title={`${statusText(st)}${session.ephemeral ? ' · Not saved' : ''}`}
            >
              <StatusLine status={st} />
              {session.ephemeral && <span className="text-dim"> · Not saved</span>}
            </span>
            {session.bgCount > 0 && (
              <span
                className="flex shrink-0 items-center gap-0.5 text-badge text-info"
                title={`${session.bgCount} background task${session.bgCount > 1 ? 's' : ''} running`}
              >
                <IconSendToTray className="h-3 w-3" />
                {session.bgCount}
                <span className="sr-only"> background</span>
              </span>
            )}
          </div>
        )}
      </div>

      {!editing && (
        // Hidden with opacity, not display:none, so keyboard focus can still reach them.
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {onClose && (
            <button
              className="flex h-6 w-6 items-center justify-center rounded text-dim transition-colors hover:text-content focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              title={
                session.ephemeral
                  ? 'Close and discard (not saved)'
                  : 'Close: stops the process, keeps the transcript to resume later'
              }
              aria-label={
                session.ephemeral
                  ? `Close and discard “${session.title}” (not saved)`
                  : `Close “${session.title}” (keep transcript)`
              }
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
              onRename && { key: 'rename', label: 'Rename', icon: <IconEdit className="h-4 w-4" />, onClick: onRename, hint: 'F2' },
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

/** A working session that isn't the one on screen spins its ring, since nothing else in view shows
 *  that it's working. */
function RowMark({ status, spin }: { status: SessionStatus; spin: boolean }): JSX.Element {
  switch (status.kind) {
    case 'needs':
      return (
        <>
          <IconHand className="h-3.5 w-3.5 text-warn" />
          {status.count > 1 && <span className="text-badge text-warn">{status.count}</span>}
        </>
      )
    case 'failed':
      return <IconWarn className="h-3.5 w-3.5 text-err" />
    case 'working':
      return (
        <span
          className={`flex h-2.5 w-2.5 items-center justify-center rounded-full border-[1.5px] border-dim ${spin ? 'mark-spin' : ''}`}
          aria-hidden="true"
        >
          <span className="h-1 w-1 rounded-full bg-accent" />
        </span>
      )
    case 'idle':
      return <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden="true" />
  }
}

/** Line 2: "Needs you: Allow Write", "Last turn failed", the now-line in mono, or "Idle". */
function StatusLine({ status }: { status: SessionStatus }): JSX.Element {
  if (status.kind === 'needs')
    return (
      <>
        <span className="text-warn">{status.lead}</span>
        {status.rest && <span className="text-dim">: {status.rest}</span>}
      </>
    )
  if (status.kind === 'working')
    return (
      <span className="font-mono text-dim">
        <span className="sr-only">Working: </span>
        {status.lead}
        {status.rest && <span className="ml-2">{status.rest}</span>}
      </span>
    )
  return <span className="text-dim">{status.lead}</span>
}

/** A 2-char session monogram for the collapsed rail: first char of the first word + first char of the
 *  next word that isn't a version token; a single word gives its first two chars. Uppercased. */
function monogram(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = words[0]
  const second = words.slice(1).find((w) => !/^v?\d+$/i.test(w))
  if (second) return (first[0] + second[0]).toUpperCase()
  return first.slice(0, 2).toUpperCase()
}

/** Collapsed-rail tile for one session. The corner badge is the row mark reduced to a shape (hand →
 *  diamond, alert → triangle); the aria-label and tooltip carry the full text. The badge's ring is the
 *  rail's surface colour (bg-bg), which cuts the badge out of the tile. */
function SessionMonogram({
  session,
  active,
  onOpen
}: {
  session: MergedSession
  active: boolean
  onOpen: (e: React.MouseEvent) => void
}): JSX.Element {
  const st = session.status
  const project = basename(session.cwd)
  let label = `${session.title}, ${project}`
  if (st)
    label += `, ${
      st.kind === 'needs'
        ? 'needs you'
        : st.kind === 'failed'
          ? 'last turn failed'
          : st.kind === 'working'
            ? `working: ${statusText(st)}`
            : 'idle'
    }`
  if (session.bgCount > 0)
    label += `, ${session.bgCount} background task${session.bgCount > 1 ? 's' : ''} running`

  const working = st?.kind === 'working'
  const needs = st?.kind === 'needs'
  const tone = active || working || needs ? 'text-content' : session.live ? 'text-dim' : 'text-faint'
  const fill = active ? 'bg-row-selected' : working || needs ? 'bg-bg-raised' : 'border border-border'

  return (
    <div className="relative flex shrink-0 items-center justify-center">
      {active && (
        <span className="absolute -left-[7px] top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-accent" aria-hidden="true" />
      )}
      <button
        data-ui="sidebar-row"
        className={`relative flex h-7 w-7 items-center justify-center rounded-lg text-badge transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${fill} ${tone} ${
          !active && !working && !needs ? 'hover:bg-bg-raised' : ''
        }`}
        aria-label={label}
        aria-current={active || undefined}
        title={label}
        onClick={onOpen}
      >
        {monogram(session.title)}
        {st?.kind === 'needs' && (
          <span className="absolute -right-1 -top-1 h-2 w-2 rotate-45 rounded-[1px] bg-warn ring-2 ring-bg" aria-hidden="true" />
        )}
        {st?.kind === 'failed' && (
          <svg className="absolute -right-1.5 -top-1.5 h-[13px] w-[13px]" viewBox="0 0 13 13" aria-hidden="true">
            <path
              d="M6.5 2 L11.5 11 H1.5 Z"
              fill="var(--color-err)"
              stroke="var(--color-bg)"
              strokeWidth="2"
              strokeLinejoin="round"
              paintOrder="stroke"
            />
          </svg>
        )}
        {st?.kind === 'working' && (
          <span
            className={`absolute -right-1 -top-1 flex h-2 w-2 items-center justify-center rounded-full border-[1.5px] border-dim bg-bg ring-2 ring-bg ${
              active ? '' : 'mark-spin'
            }`}
            aria-hidden="true"
          >
            <span className="h-[3px] w-[3px] rounded-full bg-accent" />
          </span>
        )}
        {st?.kind === 'idle' && (
          <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-ok ring-2 ring-bg" aria-hidden="true" />
        )}
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
  /** Keyboard-accelerator hint shown right-aligned, so the visible menu teaches the invisible key. */
  hint?: string
}

/** Session-row overflow (kebab) menu holds the rare actions as text-labeled items so they clear the 44px target.
 *  The trigger is a `menu`-button; the open menu is `role="menu"` with roving focus, click-outside closes, focus returns to the trigger.
 *  Renders nothing if there are no items. */
function RowMenu({
  title,
  items
}: {
  title: string
  items: RowMenuItem[]
}): JSX.Element | null {
  const [focusIdx, setFocusIdx] = useState(0)
  const p = usePopover({ placement: 'down', align: 'end' })
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    if (p.open) itemRefs.current[focusIdx]?.focus()
  }, [p.open, focusIdx])

  if (items.length === 0) return null

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
      p.close({ via: 'keyboard', returnFocus: false })
    }
  }

  return (
    <div className="relative">
      <button
        {...p.triggerProps}
        className="flex h-6 w-6 items-center justify-center rounded text-dim transition-colors hover:text-content focus-visible:opacity-100"
        aria-haspopup="menu"
        aria-label={`More actions for “${title}”`}
        title="More actions"
        onClick={(e) => {
          e.stopPropagation()
          setFocusIdx(0)
          p.triggerProps.onClick(e)
        }}
      >
        <IconMore className="h-4 w-4" />
      </button>
      <div
        {...p.popoverProps}
        role="menu"
        aria-label={`Actions for “${title}”`}
        className="pop-base pop glass-thick min-w-[188px] rounded-lg p-1"
        onKeyDown={onMenuKey}
      >
        {items.map((it, i) => (
          <button
            key={it.key}
            ref={(el) => (itemRefs.current[i] = el)}
            role="menuitem"
            tabIndex={i === focusIdx ? 0 : -1}
            className={`relative flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-label text-content -outline-offset-2 hover:bg-[var(--glass-row-hover)] focus-visible:bg-[var(--glass-row-hover)] ${
              it.danger ? 'mt-1 border-t border-[var(--glass-edge)] pt-2' : ''
            }`}
            onClick={(e) => {
              e.stopPropagation()
              p.close({ via: viaOf(e), returnFocus: false })
              it.onClick()
            }}
          >
            {/* Destructive reads by mark and icon, since err text fails on glass. */}
            {it.danger && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-err" aria-hidden="true" />}
            <span className={`shrink-0 ${it.danger ? 'text-err' : 'text-dim'}`}>{it.icon}</span>
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.hint && <span className="shrink-0 text-meta text-dim">{it.hint}</span>}
          </button>
        ))}
      </div>
    </div>
  )
}
