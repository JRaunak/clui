/**
 * Renderer state: many concurrent Claude sessions, each with its own chat
 * transcript, streaming flags, permission queue, context ring, and picker
 * choices, assembled from the streamed DomainEvents.
 *
 * Keep-sessions-alive model (terminal-tab behavior): every started/resumed
 * session keeps its `claude` subprocess ALIVE in the background. Switching
 * sessions only changes `activeHandleId` (the session the UI views); it never
 * kills or respawns a process, so switching is instant and a background session
 * can keep streaming while you look at another. Processes are stopped only on an
 * explicit close, on quit (main's `stopAll`), or by the live-process cap below.
 *
 * The main process is already multi-session: `SessionManager` keys every session
 * by an app-local `handleId` and every pushed event is tagged with it
 * (`TaggedEvent`). So this store installs ONE persistent subscription and routes
 * each event into `sessions[handleId]`.
 */
import { create } from 'zustand'
import type { DomainEvent, PermissionSuggestion, SessionTask, SlashCommandInfo } from '../../shared/events'
import type { ProjectGroup } from '../../shared/sessions'
import { autoCompactPercent, suggestCompactPercent } from './lib/compaction'
import type { PermissionModeChoice, PermissionVerdict, WireAttachment } from '../../shared/ipc'
import { clampEffort, reconcileModelChoice, supportsUltracodeToggle, contextWindowForModel, EFFORT_CHOICES, type EffortChoice, type ModelChoice } from '../../shared/settings'

/** A tool-permission request awaiting the user's decision. */
export interface PendingPermission {
  requestId: string
  toolName: string
  input: unknown
  displayName?: string
  description?: string
  /** Actions the CLI suggests with this request (2.1.245+), e.g. "accept edits this session". */
  permissionSuggestions?: PermissionSuggestion[]
}

/**
 * A background task (Bash run_in_background shell / backgrounded subagent) that
 * keeps running after the turn's `result` fires. Tracked separately from the
 * turn-level `busy` flag; its lifecycle is driven by the bg-task-* events.
 */
export interface BackgroundTask {
  taskId: string
  description: string
  taskType?: string
  /** The launching Agent tool_use id, present for backgrounded SUBAGENTS
   *  (taskType 'local_agent'). It equals the parent_tool_use_id the forwarded-transcript
   *  (`subagentMessages`) is keyed by, so a subagent row can open its SubagentView.
   *  Absent for bg bash shells (taskType 'local_bash'), which have no transcript. */
  toolUseId?: string
  /** 'running' until a terminal notification/update flips it. */
  status: 'running' | 'completed' | 'killed' | 'failed'
  /** Wall-clock ms when started; drives the per-task elapsed timer. */
  startMs: number
  /** True while a user-requested TaskStop is in flight (tool-mediated; not instant). */
  stopping?: boolean
}

/**
 * One forwarded entry from a running subagent's internal transcript, in the order it
 * streamed: a text/thinking run, or a TOOL CALL the subagent made. One ordered list
 * (rather than text + a separate tools map, as an assistant ChatMessage keeps) because
 * append order IS the render order here: no rebuilt-from-disk path to reconcile.
 */
export type SubagentMessage =
  | { kind: 'text' | 'thinking'; role: 'assistant' | 'user'; text: string }
  | { kind: 'tool'; tool: ToolCall }

/** Nesting: a child subagent spawned by another subagent, surfaced as a
 *  clickable card inside the parent's transcript. `childToolUseId` is the child's own
 *  parent_tool_use_id, the key its forwarded transcript (`subagentMessages`) streams
 *  under, so the card can drill into it. */
export interface NestedSubagent {
  childToolUseId: string
  name: string
  description?: string
  subagentType?: string
}

/** A dynamic-workflow agent within a phase (from `workflow_progress`). */
export interface WorkflowAgent {
  index: number
  label: string
  phaseIndex: number
  state: string
  promptPreview?: string
  agentId?: string
}

/** A live dynamic workflow (ultracode): its phase→agent tree + status. */
export interface WorkflowState {
  taskId: string
  name: string
  description: string
  phases: { index: number; title: string }[]
  agents: WorkflowAgent[]
  totalTokens?: number
  /** null while running; set to the terminal status when it ends. */
  endedStatus: string | null
}

/** An ordered piece of an assistant message (a text run or a tool call ref), so the
 *  transcript renders text and tools in true stream order rather than lumping all
 *  text above all tools. */
export type MessageBlock = { kind: 'text'; text: string } | { kind: 'tool'; id: string }

/** A displayable attachment on a USER bubble: an image thumbnail or a document/text
 *  file chip. Present on live bubbles the composer created AND on resumed user turns
 *  (images recovered from the transcript). */
export type MessageAttachment =
  | { kind: 'image'; previewUrl: string; name?: string; w?: number; h?: number }
  | { kind: 'document'; name: string; bytes: number }
  | { kind: 'text'; name: string; bytes: number; lines: number }

/** What the composer hands `sendMessage`: the wire payload for the CLI plus the
 *  display metadata for the optimistic user bubble. */
export interface SendAttachment {
  wire: WireAttachment
  display: MessageAttachment
}

/** An inbound cross-session peer message rendered as its own attributed transcript block
 *  (`role:'peer'`). `pending` = the anonymous placeholder shown from command_lifecycle:started
 *  until the peer-origin result backfills the sender (`from`) + body (`text`). */
export interface PeerMessage {
  from: string
  pending: boolean
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'peer'
  /** Visible text (assistant text deltas concatenated), kept for the fallback
   *  render path + transcript rebuild; live rendering uses `blocks` for ordering.
   *  For a 'peer' message this holds the peer's body. */
  text: string
  /** Shown collapsed. */
  thinking: string
  tools: ToolCall[]
  /** Ordered text/tool blocks as they streamed. Empty for rebuilt-from-disk
   *  messages (which fall back to text-then-tools rendering). */
  blocks: MessageBlock[]
  /** Attachments the user added to this turn (image thumbnails / file chips in their
   *  own bubble). Optional so the huge majority of messages stay untouched. */
  attachments?: MessageAttachment[]
  /** Set on a `role:'peer'` message: the inbound cross-session block's sender + pending
   *  state. Absent on every normal user/assistant message. */
  peer?: PeerMessage
}

/**
 * A message the user composed WHILE a turn was running. Held renderer-side (NOT yet
 * dispatched to the CLI) so it can be EDITED or CANCELLED before its turn starts, and so
 * it renders at the transcript TAIL (below the streaming response) instead of being
 * spliced mid-transcript. Dispatched FIFO at the next turn boundary. Handing it to the
 * CLI immediately (the `/btw` path) would make it uneditable and mis-ordered, so Clui
 * holds it instead.
 */
export interface QueuedMessage {
  id: string
  text: string
  attachments?: SendAttachment[]
}

export interface ToolCall {
  id: string
  name: string
  input: unknown
  result?: string
  isError?: boolean
  /** Wall-clock ms when the tool_use started; drives the running-elapsed timer.
   *  Optional: only set for live tool calls; rebuilt-from-disk tools are already
   *  complete (result present), so they never show the timer. */
  startMs?: number
  /** Set when the user backgrounds this running foreground tool: makes the card read
   *  "launched" not "done" (its result lands at move-time but carries no bg flag). */
  sentToBackground?: boolean
}

/** All state for a single live session, keyed by its `handleId` in the store. */
export interface PerSessionState {
  /** App-local routing key (from the main SessionManager); durable across respawns. */
  handleId: string
  /** CLI-assigned session id, captured from the init event (null until then). */
  sessionId: string | null
  /** Title assigned at spawn (`-n`: a branch auto-name or an explicit named session), so the
   *  sidebar shows it before the jsonl exists on disk. null → derive from messages/on-disk. */
  title: string | null
  cwd: string
  /** The model the CLI actually reports for this session (from the init event). */
  model: string | null
  /** The mode the CLI actually reports for this session (from the init event). */
  permissionMode: string | null
  /** The user's selected mode choice for this session (drives the picker). */
  modeChoice: PermissionModeChoice
  /** The mode the MODEL switched into (only ever plan), shown on the chip in place of the
   *  user's modeChoice without overwriting it. null while not in plan. */
  modelMode: PermissionModeChoice | null
  /** The user's selected model choice for this session (drives the picker). */
  modelChoice: ModelChoice
  /** Ultracode on for this session (xhigh + workflow orchestration). Per-session,
   *  live-toggled, persisted in the session-models sidecar. */
  ultracode: boolean
  /** The user's selected effort choice for this session (drives the picker). */
  effortChoice: EffortChoice
  /** Context-window utilization (0–100) for the ring, or null before first turn. */
  contextPercent: number | null
  /** Resident context tokens (input + cache), for the ring's tooltip. */
  contextTokens: number | null
  /** The model's context window in tokens, for the ring's tooltip. */
  contextWindow: number | null
  /**
   * The token-runway level at which the user last dismissed the compact suggestion,
   * or null if not dismissed this fill-cycle. The suggestion re-arms once at the
   * "last-call" runway (below the initial dismissal); resets to null when context
   * drops back under the trigger (a fresh fill). Drives the in-chat compact row.
   */
  compactDismissedAtRunway: number | null
  /** Cumulative session cost in USD (summed from each turn's `result` event). */
  costUsd: number | null
  /** True if this session was resumed from history (context carried by the CLI). */
  resumed: boolean
  /** Number of messages in the index at which live turns begin (history above). */
  historyCount: number
  /** True while a turn is streaming. */
  busy: boolean
  messages: ChatMessage[]
  /** Messages composed while a turn was running: held renderer-side (editable/cancelable),
   *  rendered at the transcript tail, dispatched FIFO at the next turn boundary. */
  queuedMessages: QueuedMessage[]
  pendingPermissions: PendingPermission[]
  /** Files written/edited this session, most-recent first. */
  changedFiles: string[]
  /** Background tasks keyed by taskId (running + recently-terminal, ordered by start). */
  backgroundTasks: Record<string, BackgroundTask>
  /**
   * Subagent transcript: a running subagent's forwarded text/thinking AND tool calls in
   * stream order, keyed by the parent Agent tool_use id. Populated from the
   * `subagent-message` / `subagent-tool` / `subagent-tool-result` events (needs
   * `initialize {forwardSubagentText:true}`), correlated to the launching Agent tool card.
   */
  subagentMessages: Record<string, SubagentMessage[]>
  /** Nesting: child subagents spawned BY a subagent, keyed by the PARENT
   *  subagent's tool_use id. Drives the nested "Agent →" cards inside SubagentView.
   *  A child's own transcript lives in `subagentMessages` under its childToolUseId. */
  subagentChildren: Record<string, NestedSubagent[]>
  /** Live dynamic workflows (ultracode), keyed by workflow task_id. Populated from
   *  workflow-started/progress/ended events; drives the tray chip + phase tree. */
  workflows: Record<string, WorkflowState>
  /** The CLI's live slash-command list (from the initialize response). The
   *  composer filters this to a curated headless-safe allowlist. Empty until the
   *  init handshake lands → composer falls back to the hardcoded built-ins. */
  slashCommands: SlashCommandInfo[]
  /** Live task list (Task tool family), read from disk by the main process and
   *  pushed as `task-list` snapshots (last-write-wins). Empty when the session has
   *  no tasks; drives the transcript's task puck + checklist panel. */
  tasks: SessionTask[]
  /** Transient errors to surface. */
  lastError: string | null
  /**
   * True once the underlying process has exited for real (NOT an effort respawn,
   * which is swallowed in the main process). The slice is kept so the transcript
   * stays readable, but the session is no longer live: the sidebar stops showing
   * it as running and offers resume-from-disk instead.
   */
  exited: boolean
  /** Wall-clock ms when this session was opened (stable ordering of live sessions). */
  createdMs: number
  /** Wall-clock ms of the last activity (for LRU eviction under the cap). */
  lastActivityMs: number
}

/**
 * Max concurrent live `claude` processes. Unlike terminal tabs, each live session
 * is a real subprocess (memory + possibly an API socket), so we cap them. When a
 * new session would exceed the cap we evict the least-recently-active session that
 * is NOT busy and NOT active; if every candidate is busy we never kill one, and
 * instead surface a notice and let the count run over.
 */
const LIVE_SESSION_CAP = 8

interface SessionStore {
  /** All live sessions, keyed by handleId. */
  sessions: Record<string, PerSessionState>
  /** The session the UI currently views (null = none open → welcome screen). */
  activeHandleId: string | null
  /** Transient app-level notice (e.g. a session was evicted by the cap). */
  notice: string | null
  /**
   * The `parent_tool_use_id` of the subagent/workflow whose transcript is being
   * VIEWED in the maximized transcript view (null = normal chat). Scoped to the
   * active session's Agent tool_use ids. Cleared on ← Chat / Esc / session switch.
   * This is the LAST element of `subagentTrail` (the deepest open subagent), kept
   * as a derived convenience so existing readers (App gate, findOpen guard) are untouched.
   */
  viewingSubagent: string | null
  /**
   * Nesting: the drill-down breadcrumb of subagent tool_use ids. Entering a
   * transcript from an Agent card / bg tray RESETS it to `[id]`; drilling into a nested
   * child PUSHES; the header "← back" POPS. Empty = normal chat. `viewingSubagent` mirrors
   * its tail. (A workflow trail is always length 1: workflows don't nest this way.)
   */
  subagentTrail: string[]

  // ── Search UI state (app-level) ─────────────────────────────────────────────
  /** True when the ⌘F in-transcript find bar is open (find-in-current-conversation). */
  findOpen: boolean
  /** True when the ⌘⇧F global search overlay is open. */
  globalSearchOpen: boolean
  /**
   * A jump request for Chat: scroll to + flash the message with this id. `nonce`
   * makes repeated jumps to the SAME id re-fire (Chat watches the nonce). No need to
   * clear it after consumption, since Chat keys off the nonce change.
   */
  scrollTarget: { messageId: string; nonce: number } | null

  /** On-disk session list (grouped by project), owned here so both the sidebar and
   *  any store-side trigger read/refresh one copy. Sourced from `listSessions()`. */
  sessionGroups: ProjectGroup[]
  /** True while a `refreshSessions()` scan is in flight (drives the sidebar skeleton). */
  sessionsLoading: boolean
  /** Re-scan `~/.claude/projects` and replace `sessionGroups`. Awaitable so a caller can
   *  sequence work after the list lands (e.g. the delete-commit that hides a row). */
  refreshSessions: () => Promise<void>

  /** Open/close the ⌘F find bar (no-op-open while viewing a subagent transcript). */
  setFindOpen: (open: boolean) => void
  /** Open/close the ⌘⇧F global search overlay. */
  setGlobalSearchOpen: (open: boolean) => void
  /** Request Chat scroll to + flash a message by id (from a find or a global hit). */
  requestScrollTo: (messageId: string) => void

  /** Start a NEW session in `cwd` and make it active. */
  startSession: (
    cwd: string,
    mode?: PermissionModeChoice,
    opts?: { model?: ModelChoice; effort?: EffortChoice; name?: string }
  ) => Promise<void>
  /** Resume an on-disk session (loads history) and make it active. */
  resumeSession: (cwd: string, resumeSessionId: string, mode?: PermissionModeChoice) => Promise<void>
  /** Fork a session (live or dormant) → a NEW live branch carrying its context,
   *  original untouched (`--fork-session`). Fork-from-HEAD; never short-circuits to an
   *  existing live session (the point is a new branch). */
  forkSession: (cwd: string, sourceSessionId: string, mode?: PermissionModeChoice) => Promise<void>
  /** View an already-live session without touching its process (instant switch). */
  activateSession: (handleId: string) => void
  /** Stop a live session's process and drop its slice. */
  closeSession: (handleId: string) => Promise<void>
  /** Move the active view to the next (dir=1) / previous (dir=-1) live session,
   *  in sidebar order, wrapping around. No-op with fewer than 2 live sessions. */
  cycleSession: (dir: 1 | -1) => void

  /**
   * Send a user turn. `attachments` carries both the lean wire payload (image
   * blocks sent to the CLI) and a display thumbnail for the user's own bubble.
   */
  sendMessage: (text: string, attachments?: SendAttachment[]) => Promise<void>
  /** Edit a still-queued message's text (before it's dispatched at the turn boundary). */
  editQueuedMessage: (id: string, text: string) => void
  /** Remove a still-queued message (never dispatched). */
  cancelQueuedMessage: (id: string) => void
  interrupt: () => Promise<void>
  /** Stop a running background task (tool-mediated TaskStop; costs a turn). */
  stopBackgroundTask: (handleId: string, taskId: string) => Promise<void>
  /** Move a running foreground tool to the background (keeps running in the tray). */
  backgroundTask: (toolUseId: string) => Promise<boolean>
  /** Clear the LINGERING completed subagents + ended workflows from the active session's
   *  trays (fired when they're opened, displaced by new same-kind work, or a grace timer
   *  elapses). Never touches running items. `kind` scopes it to one tray or both. */
  clearCompletedBgWork: (kind?: 'subagent' | 'workflow') => void
  /** Drop changed-files that no longer exist on disk (deleted this turn). */
  pruneChangedFiles: (handleId: string) => Promise<void>
  /** Change the active session's permission mode mid-session (per-session only). */
  setPermissionMode: (mode: PermissionModeChoice) => Promise<void>
  /** Change the active session's model live (per-session only). */
  setModel: (model: ModelChoice) => Promise<void>
  /** Change the active session's effort live (per-session only). */
  setEffort: (effort: EffortChoice) => Promise<void>
  /** Toggle ultracode live for the active session (per-session only). */
  setUltracode: (on: boolean) => Promise<void>
  respondPermission: (verdict: PermissionVerdict) => Promise<void>
  /** Dismiss the in-chat compact suggestion for the active session at the current
   *  runway (it re-arms once near auto-compact; resets when context drops). */
  dismissCompactSuggestion: () => void
  /** Route one tagged event into its session's slice. */
  applyEvent: (handleId: string, e: DomainEvent) => void
  /** Set the transient app-level notice (e.g. an attachment rejection). */
  setNotice: (message: string) => void
  /** Dismiss the transient app-level notice. */
  dismissNotice: () => void
  /** Open the maximized transcript view for a subagent (by parent_tool_use_id). Resets
   *  the nesting trail to just this id (fresh entry from an Agent card / bg tray). */
  viewSubagent: (parentToolUseId: string) => void
  /** Nesting: drill INTO a nested child subagent, pushing it onto the trail so
   *  the header shows a breadcrumb + "← back" to the parent. */
  pushSubagent: (childToolUseId: string) => void
  /** Nesting: go back up one level (pop the trail); closes the view if at root. */
  popSubagent: () => void
  /** Nesting: jump to a specific breadcrumb depth (truncate the trail to it). */
  gotoSubagentDepth: (depth: number) => void
  /** Close the transcript view entirely, returning to the chat (clears the trail). */
  closeSubagentView: () => void
}

/** The active session's slice, or null when nothing is open. */
export function activeSlice(store: SessionStore): PerSessionState | null {
  return store.activeHandleId ? (store.sessions[store.activeHandleId] ?? null) : null
}

/**
 * Immutably merge `patch` into one session's slice, returning the `set` payload (or `{}`
 * if the handle is gone). Every mutating action funnels the two-level spread through here
 * so the shape and its not-null guard live in ONE place: hand-writing
 * `{ sessions: { ...s.sessions, [id]: { ...s.sessions[id], ...patch } } }` at each site
 * risks a dropped inner spread silently clobbering the whole slice, which TS can't catch
 * because the literal is well-typed. Read the base slice from the fresh `s`, never a stale capture.
 */
function patchSlice(
  s: SessionStore,
  handleId: string,
  patch: Partial<PerSessionState>
): Partial<SessionStore> {
  const cur = s.sessions[handleId]
  return cur ? { sessions: { ...s.sessions, [handleId]: { ...cur, ...patch } } } : {}
}

/**
 * Select a field from the ACTIVE session's slice (null when none is open). Keeps
 * the narrow-selector re-render behavior: components re-render only when the
 * selected value changes, not on every event for any session.
 *
 * IMPORTANT: the selector must return a STABLE value when the slice is null.
 * zustand v5 uses `useSyncExternalStore` with Object.is, so a selector that
 * returns a fresh `[]`/`{}` on every call (e.g. `s?.messages ?? []`) triggers an
 * infinite render loop. Use the shared `EMPTY_*` constants below for the null
 * fallback so the reference stays identical across renders.
 */
export function useActive<T>(selector: (slice: PerSessionState | null) => T): T {
  return useSession((s) => selector(activeSlice(s)))
}

/** Stable empty fallbacks for array selectors (see the useActive note above). */
export const EMPTY_MESSAGES: ChatMessage[] = []
export const EMPTY_PENDING: PendingPermission[] = []
export const EMPTY_STRINGS: string[] = []
/** Stable empty ref for the queued-messages list (zustand-v5 selector safety). */
export const EMPTY_QUEUED: QueuedMessage[] = []
/** Stable empty ref for a subagent's message list (zustand-v5 selector safety). */
export const EMPTY_SUBAGENT_MSGS: SubagentMessage[] = []
/** Stable empty ref for a subagent's nested-children list (zustand-v5 selector safety). */
export const EMPTY_NESTED_SUBAGENTS: NestedSubagent[] = []
/** Stable empty ref for the live slash-command list (zustand-v5 selector safety). */
export const EMPTY_SLASH_COMMANDS: SlashCommandInfo[] = []
/** Stable empty ref for the live task list (zustand-v5 selector safety). */
export const EMPTY_TASKS: SessionTask[] = []

/** Read shares the file_path key but writes nothing, so changed-files gates on the tool
 *  name, not the key's presence. */
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])

// --- One persistent event subscription (installed lazily on first use) ---

let subscribed = false
/**
 * Events that arrived for a handle whose slice does not exist yet, in the tiny
 * window between `startSession` spawning (main assigns the handle) and the store
 * inserting the slice. Buffered by handleId, flushed when the slice lands, so no
 * `session-init` is ever dropped (closes the pre-handleId race).
 */
const earlyBuffer = new Map<string, DomainEvent[]>()

/**
 * Accrued cost (USD) per CLI sessionId, remembered across close→resume within an
 * app run. The CLI's `total_cost_usd` is PER-INVOCATION, not cumulative across a
 * `--resume` (verified: turn1 $0.114, resumed turn2 reports only its own $0.026),
 * and cost is NOT persisted in the jsonl, so we accumulate it here and re-seed a
 * resumed/respawned session's slice from it, instead of resetting to null.
 * Best-effort/in-memory: a fresh app launch resuming an old session starts at $0
 * for new turns (there's no historical cost on disk to recover).
 */
const costBySessionId = new Map<string, number>()

/**
 * Last-known available model ids (full inference-profile forms). Populated by
 * `beginSession` from `listModels()`, used in `session-init` to reconcile the
 * picker's `modelChoice` to the model the CLI actually reports (so a mid-session
 * `set_model` that survives a resume is reflected in the picker, not overwritten by
 * the stale Settings default). Empty until the first session starts, when reconciliation
 * falls back to the reported id, which is still correct.
 */
let knownModelIds: string[] = []

/**
 * Per-session model+effort, mirrored from the `session-models.json` sidecar. Written
 * on every mid-session set_model/set_effort; read on resume so the switch survives
 * (the CLI reverts to the settings.json default on --resume otherwise). sessionId →
 * {model?, effort?}.
 */
const modelPrefsBySessionId = new Map<
  string,
  { model?: ModelChoice; effort?: EffortChoice; ultracode?: boolean }
>()

/** Remember a session's model/effort/ultracode (in-memory + sidecar). Merges fields. */
function rememberModelPrefs(
  sessionId: string,
  prefs: { model?: ModelChoice; effort?: EffortChoice; ultracode?: boolean }
): void {
  if (!sessionId) return
  const cur = modelPrefsBySessionId.get(sessionId) ?? {}
  const next = {
    model: prefs.model ?? cur.model,
    effort: prefs.effort ?? cur.effort,
    ultracode: prefs.ultracode ?? cur.ultracode
  }
  modelPrefsBySessionId.set(sessionId, next)
  void window.clui.setSessionModel(sessionId, next)
}

/** Drop a session's remembered cost AND model/effort (call on permanent delete). */
export function forgetSessionCost(sessionId: string): void {
  costBySessionId.delete(sessionId)
  void window.clui.deleteSessionCost(sessionId)
  modelPrefsBySessionId.delete(sessionId)
  void window.clui.deleteSessionModel(sessionId)
}

/**
 * Load persisted per-session costs from the sidecar into the in-memory map.
 * Called once at app startup so a session resumed after a relaunch shows its
 * accrued cost. In-memory values (from the live run) always win over disk.
 */
export async function loadPersistedCosts(): Promise<void> {
  try {
    const persisted = await window.clui.getSessionCosts()
    for (const [sid, usd] of Object.entries(persisted)) {
      if (!costBySessionId.has(sid)) costBySessionId.set(sid, usd)
    }
  } catch {
    // best-effort: cost display just starts empty if the sidecar is unreadable
  }
  void ensureModelPrefsLoaded()
}

/** Load the per-session model/effort sidecar into `modelPrefsBySessionId` once (memoized;
 *  the startup warm and the resume `await` share one read). In-memory prefs from the live
 *  run win via the `has` guard, so this only fills cold entries after a relaunch. */
let modelPrefsLoaded: Promise<void> | null = null
export function ensureModelPrefsLoaded(): Promise<void> {
  if (!modelPrefsLoaded) {
    modelPrefsLoaded = (async () => {
      try {
        const models = await window.clui.getSessionModels()
        for (const [sid, prefs] of Object.entries(models)) {
          if (modelPrefsBySessionId.has(sid)) continue
          // Validate the sidecar's effort against the known set (defensive against manual
          // edits / a CLI enum change); drop an unrecognized effort rather than trust it.
          const effort =
            prefs.effort && (EFFORT_CHOICES as string[]).includes(prefs.effort)
              ? (prefs.effort as EffortChoice)
              : undefined
          modelPrefsBySessionId.set(sid, { model: prefs.model, effort, ultracode: prefs.ultracode })
        }
      } catch {
        // best-effort: resume just falls back to the Settings default model/effort
      }
    })()
  }
  return modelPrefsLoaded
}

function ensureSubscribed(applyEvent: (handleId: string, e: DomainEvent) => void): void {
  if (subscribed) return
  subscribed = true
  window.clui.onSessionEvent(({ handleId, event }) => {
    applyEvent(handleId, event)
    // After a turn ends, prune changed-files that were deleted this turn (incl. by
    // the agent via Bash rm, which surfaces no file_path). Fire-and-forget.
    if (event.type === 'result') void useSession.getState().pruneChangedFiles(handleId)
  })
}

/** Insert a freshly-created slice and flush any events that raced ahead of it. */
function insertSlice(
  set: (fn: (s: SessionStore) => Partial<SessionStore>) => void,
  applyEvent: (handleId: string, e: DomainEvent) => void,
  slice: PerSessionState
): void {
  set((s) => ({
    sessions: { ...s.sessions, [slice.handleId]: slice },
    activeHandleId: slice.handleId
  }))
  const buffered = earlyBuffer.get(slice.handleId)
  if (buffered) {
    earlyBuffer.delete(slice.handleId)
    for (const e of buffered) applyEvent(slice.handleId, e)
  }
}

/** Shared start/resume: seed a slice, spawn the process, wire it up. */
async function beginSession(
  get: () => SessionStore,
  set: (fn: (s: SessionStore) => Partial<SessionStore>) => void,
  opts: {
    cwd: string
    resumeSessionId?: string
    fork?: boolean
    permissionMode?: PermissionModeChoice
    /** Explicit model/effort, outranking the Settings default. Only the test harness
     *  passes these. The UI has no "start a session as X" control, it switches after. */
    model?: ModelChoice
    effort?: EffortChoice
    /** Session title → `-n` at spawn (named-session dialog); not persisted. */
    name?: string
  }
): Promise<void> {
  ensureSubscribed(get().applyEvent)
  evictIfOverCap(get, set, opts.cwd)

  // Resolve per-session choices: explicit arg, else the global Settings default.
  // These are seeded ONCE here (a brand-new/resumed session); re-activating an
  // already-live session never re-seeds them, so per-session picks stick.
  const { values: settings } = await window.clui.getSettings()
  const choice = opts.permissionMode ?? settings.permissionMode
  // On RESUME, restore the session's last-used model/effort from the sidecar (the CLI
  // reverts to the settings.json default on --resume, so a mid-session switch would
  // otherwise be lost). Fresh sessions use the Settings default. `remembered` is only
  // consulted for a resume with a known sessionId. Await the sidecar load first: it's
  // warmed fire-and-forget at startup, so a resume-click before that lands would read
  // an empty map and revert to the default.
  if (opts.resumeSessionId) await ensureModelPrefsLoaded()
  const remembered = opts.resumeSessionId ? modelPrefsBySessionId.get(opts.resumeSessionId) : undefined
  const modelChoice = opts.model ?? remembered?.model ?? settings.model
  const effortChoice = opts.effort ?? remembered?.effort ?? settings.effort
  // Ultracode is off by default on a fresh session; restored from the sidecar on resume.
  const ultracode = remembered?.ultracode ?? false
  // Cache the available model ids so session-init can reconcile the picker to the
  // CLI's actually-running model (best-effort; empty on failure → reconcile falls
  // back to the reported id).
  void window.clui.listModels().then(({ ids }) => { if (ids.length) knownModelIds = ids })

  // On resume, reconstruct prior history from the transcript so it renders in the
  // chat, then continue streaming new turns on top. Best-effort / display-only.
  let history: ChatMessage[] = []
  let resumedContextTokens: number | null = null
  if (opts.resumeSessionId) {
    try {
      const t = await window.clui.readTranscript(opts.resumeSessionId)
      history = t.messages.map((m) => ({
        id: m.id,
        // A recovered inbound peer message becomes a 'peer' block; it's resolved (never
        // pending) since it's read whole from disk.
        role: m.peer ? ('peer' as const) : m.role,
        peer: m.peer ? { from: m.peer.from, pending: false } : undefined,
        text: m.text,
        thinking: m.thinking,
        tools: m.tools.map((tc) => ({ ...tc })),
        // Rebuilt-from-disk: no ordered blocks → MessageView falls back to the
        // text-then-tools layout (ordering within a resumed turn isn't preserved
        // in the transcript, and it's display-only history anyway).
        blocks: [],
        // Drop-file: recovered attachments render in the user bubble. Images show as
        // thumbnails (the recovered data-URL is the preview), document/text as
        // metadata chips (name + size; bytes not re-inlined into the store on resume).
        attachments: m.attachments?.length
          ? m.attachments.map((a) =>
              a.kind === 'image'
                ? { kind: 'image' as const, previewUrl: a.dataUrl }
                : a.kind === 'document'
                  ? { kind: 'document' as const, name: a.name, bytes: a.bytes }
                  : { kind: 'text' as const, name: a.name, bytes: a.bytes, lines: a.lines }
            )
          : undefined
      }))
      resumedContextTokens = t.contextTokens
    } catch {
      // Transcript unreadable/format drift: resume still works, just no history.
      history = []
    }
  }

  // Seed the context ring from the transcript's last usage so a resumed session
  // shows its REAL fill (~90% for a big session) immediately, not 0% until the
  // first new turn. Window from the model id (1M for [1m], else 200K), matching
  // the live mapper; refined by the next result event once a turn runs.
  const seededWindow = /\[1m\]/i.test(modelChoice) ? 1_000_000 : 200_000
  const seededTokens = resumedContextTokens
  const seededPercent =
    seededTokens != null ? Math.min(100, Math.round((seededTokens / seededWindow) * 100)) : null

  // Pass model/effort explicitly. On resume these are the REMEMBERED per-session
  // values (from the sidecar). Verified: --model/--effort ARE honored on a --resume
  // spawn, and the CLI otherwise reverts to the settings.json default (dropping the
  // user's mid-session switch). On a fresh session they're the Settings default.
  const { handleId } = await window.clui.startSession({
    ...opts,
    permissionMode: choice,
    model: modelChoice,
    effort: effortChoice,
    ultracode
  })

  const now = Date.now()
  insertSlice(set, get().applyEvent, {
    handleId,
    // A fork gets a NEW id from the CLI, so don't seed the source's id: that would make the
    // fork masquerade as the source's on-disk row until session-init reconciles. Resume keeps it.
    sessionId: opts.fork ? null : (opts.resumeSessionId ?? null),
    title: opts.name ?? null,
    cwd: opts.cwd,
    model: null,
    permissionMode: null,
    modeChoice: choice,
    modelMode: null,
    modelChoice,
    effortChoice,
    ultracode,
    contextPercent: seededPercent,
    contextTokens: seededTokens,
    contextWindow: seededTokens != null ? seededWindow : null,
    compactDismissedAtRunway: null,
    // Re-seed accrued cost when resuming a session we've already spent on this app
    // run (cost isn't persisted on disk, and the CLI's per-invocation total_cost
    // resets across --resume, so carry our own running total forward).
    costUsd: opts.resumeSessionId ? (costBySessionId.get(opts.resumeSessionId) ?? null) : null,
    resumed: Boolean(opts.resumeSessionId),
    historyCount: history.length,
    busy: false,
    messages: history,
    queuedMessages: EMPTY_QUEUED,
    pendingPermissions: [],
    changedFiles: [],
    backgroundTasks: {},
    subagentMessages: {},
    subagentChildren: {},
    workflows: {},
    slashCommands: EMPTY_SLASH_COMMANDS,
    tasks: EMPTY_TASKS,
    lastError: null,
    exited: false,
    createdMs: now,
    lastActivityMs: now
  })
}

/**
 * Enforce the live-process cap before opening a new session. Evicts the
 * least-recently-active session that is neither busy nor active; if none is
 * evictable (all busy), leaves the count over-cap and surfaces a notice.
 */
function evictIfOverCap(
  get: () => SessionStore,
  set: (fn: (s: SessionStore) => Partial<SessionStore>) => void,
  newCwd: string
): void {
  const { sessions, activeHandleId } = get()
  const live = Object.values(sessions)
  if (live.length < LIVE_SESSION_CAP) return

  const candidates = live
    .filter((s) => !s.busy && s.handleId !== activeHandleId)
    .sort((a, b) => a.lastActivityMs - b.lastActivityMs)
  const victim = candidates[0]

  if (!victim) {
    set(() => ({
      notice: `${live.length} live sessions are all busy — finish or close some to free memory.`
    }))
    return
  }

  const label = victim.messages.find((m) => m.role === 'user')?.text.slice(0, 40) || 'a session'
  void window.clui.stopSession(victim.handleId)
  set((s) => {
    const next = { ...s.sessions }
    delete next[victim.handleId]
    return {
      sessions: next,
      notice: `Closed background session (${label}) to stay under ${LIVE_SESSION_CAP} live sessions in ${basename(newCwd)}.`
    }
  })
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

/**
 * Commit a user turn: append the optimistic user bubble, set busy, and write it to the
 * CLI. Used both for an immediate send (idle) and for RELEASING a queued message at a
 * turn boundary, so the queued path and the direct path build the identical bubble.
 */
async function dispatchTurn(
  set: (fn: (s: SessionStore) => Partial<SessionStore>) => void,
  handleId: string,
  text: string,
  attachments?: SendAttachment[]
): Promise<void> {
  const userMsg: ChatMessage = {
    id: `u-${Date.now()}`,
    role: 'user',
    text,
    thinking: '',
    tools: [],
    blocks: [],
    attachments: attachments && attachments.length ? attachments.map((a) => a.display) : undefined
  }
  const now = Date.now()
  set((s) => {
    const slice = s.sessions[handleId]
    if (!slice) return {}
    return patchSlice(s, handleId, {
      messages: [...slice.messages, userMsg],
      busy: true,
      lastError: null,
      lastActivityMs: now
    })
  })
  const wire = attachments && attachments.length ? attachments.map((a) => a.wire) : undefined
  await window.clui.sendMessage(handleId, text, wire)
}

/** Find or create the current (last) assistant message to append streamed content. */
function currentAssistant(messages: ChatMessage[]): ChatMessage {
  const last = messages[messages.length - 1]
  if (last && last.role === 'assistant') return last
  const msg: ChatMessage = {
    id: `a-${Date.now()}-${messages.length}`,
    role: 'assistant',
    text: '',
    thinking: '',
    tools: [],
    blocks: []
  }
  messages.push(msg)
  return msg
}

/** Narrow a loose CLI task status to the tray's union: only 'killed'/'failed' are kept
 *  distinct; every other terminal string collapses to 'completed' (the tray only cares
 *  running-vs-not). One place so the bg-task-updated and -notification arms can't diverge. */
function narrowTaskStatus(status: string | undefined): BackgroundTask['status'] {
  return status === 'killed' || status === 'failed' ? status : 'completed'
}

/** The subagent (by its parent tool_use id) that started this bg task, or null when the
 *  main thread owns it. The CLI announces BOTH a subagent's backgrounded shell and a
 *  subagent it spawned as bg tasks of their own, which read as peers of the user's own
 *  work unless they're attributed back to the agent that started them. Two sources,
 *  because a spawned child never appears as a forwarded tool: a shell matches a
 *  `kind:'tool'` entry, a child agent matches a recorded `childToolUseId`. */
export function subagentOwnerOfTask(
  toolUseId: string | undefined,
  subagentMessages: Record<string, SubagentMessage[]>,
  subagentChildren: Record<string, NestedSubagent[]>
): string | null {
  if (!toolUseId) return null
  for (const [parentToolUseId, entries] of Object.entries(subagentMessages)) {
    for (const entry of entries) {
      if (entry.kind === 'tool' && entry.tool.id === toolUseId) return parentToolUseId
    }
  }
  for (const [parentToolUseId, children] of Object.entries(subagentChildren)) {
    if (children.some((c) => c.childToolUseId === toolUseId)) return parentToolUseId
  }
  return null
}

/** True for events that mutate the message list (need a fresh array copy). */
function touchesMessages(type: DomainEvent['type']): boolean {
  return (
    type === 'text-delta' ||
    type === 'thinking-delta' ||
    type === 'tool-use-start' ||
    type === 'tool-use-stop' ||
    type === 'tool-result' ||
    type === 'peer-pending' ||
    type === 'peer-message' ||
    type === 'peer-lifecycle-end'
  )
}

export const useSession = create<SessionStore>((set, get) => ({
  sessions: {},
  activeHandleId: null,
  notice: null,
  viewingSubagent: null,
  subagentTrail: [],
  findOpen: false,
  globalSearchOpen: false,
  scrollTarget: null,
  sessionGroups: [],
  sessionsLoading: true,

  refreshSessions: async () => {
    // TODO: CommandPalette still fetches listSessions() independently; fold it onto this
    // store copy so its list can't drift from the sidebar's.
    set(() => ({ sessionsLoading: true }))
    const groups = await window.clui.listSessions()
    set(() => ({ sessionGroups: groups, sessionsLoading: false }))
  },

  startSession: async (cwd, mode, opts) => {
    await beginSession(get, set, { cwd, permissionMode: mode, ...opts })
  },

  resumeSession: async (cwd, resumeSessionId, mode) => {
    // If this session is already live, just view it; never respawn.
    const existing = Object.values(get().sessions).find((s) => s.sessionId === resumeSessionId)
    if (existing) {
      get().activateSession(existing.handleId)
      return
    }
    await beginSession(get, set, { cwd, resumeSessionId, permissionMode: mode })
  },

  // Fork a session: branch it to a NEW live session carrying the full context,
  // leaving the original jsonl untouched (`--fork-session`). Fork-from-HEAD (whole-session
  // duplicate); works on live AND dormant sessions (both just need the id + cwd). Unlike
  // resume, we NEVER short-circuit to an existing live session; the point is a new branch.
  forkSession: async (cwd, sourceSessionId, mode) => {
    // Name the branch after exactly what the sidebar shows for the source (not a re-derived
    // title), so it reads as "Branch-" + what the user sees; deduped within the workspace.
    const { sessionGroups, sessions } = get()
    const liveSlice = Object.values(sessions).find((s) => s.sessionId === sourceSessionId)
    const shown = (
      sessionGroups.flatMap((g) => g.sessions).find((s) => s.id === sourceSessionId)?.title ??
      liveSlice?.title ??
      liveSlice?.messages.find((m) => m.role === 'user')?.text.trim()
    )?.trim()
    let name: string | undefined
    if (shown) {
      const taken = new Set<string>()
      for (const s of sessionGroups.find((g) => g.cwd === cwd)?.sessions ?? []) taken.add(s.title)
      for (const s of Object.values(sessions)) if (s.cwd === cwd && s.title) taken.add(s.title)
      const fit = (x: string): string => (x.length > 80 ? x.slice(0, 79) + '…' : x)
      name = fit(`Branch-${shown}`)
      for (let i = 2; taken.has(name); i++) name = fit(`Branch-${shown} ${i}`)
    }
    await beginSession(get, set, { cwd, resumeSessionId: sourceSessionId, fork: true, permissionMode: mode, name })
  },

  activateSession: (handleId) => {
    if (!get().sessions[handleId]) return
    set((s) => ({
      ...patchSlice(s, handleId, { lastActivityMs: Date.now() }),
      activeHandleId: handleId,
      // Switching sessions closes any open transcript view (its ids are scoped to
      // the previously-active session's Agent tool_use ids).
      viewingSubagent: null,
      subagentTrail: []
    }))
  },

  closeSession: async (handleId) => {
    await window.clui.stopSession(handleId)
    set((s) => {
      // Compute the neighbour BEFORE deleting, using the SAME order the sidebar
      // shows (createdMs desc), so closing the active session moves the highlight
      // to its visual neighbour (the row below, or the row above if it was last),
      // never to a random most-recently-used row elsewhere in the list. We only
      // ever hand off to another LIVE session; we NEVER auto-resume a dormant
      // on-disk one (that would silently spawn a claude process from a close), so
      // if this was the last live session we fall back to Welcome (null).
      let active = s.activeHandleId
      if (active === handleId) {
        const ordered = Object.values(s.sessions)
          .filter((v) => !v.exited)
          .sort((a, b) => b.createdMs - a.createdMs)
        const i = ordered.findIndex((v) => v.handleId === handleId)
        // Prefer the row ABOVE (the newer session, since the list is newest-first, so moving
        // up after closing an older one is the intuitive direction); if we closed
        // the topmost row, fall to the one below it.
        const neighbour = i === -1 ? undefined : (ordered[i - 1] ?? ordered[i + 1])
        active = neighbour?.handleId ?? null
      }
      const next = { ...s.sessions }
      delete next[handleId]
      return { sessions: next, activeHandleId: active }
    })
  },

  cycleSession: (dir) => {
    const { sessions, activeHandleId } = get()
    // Match the sidebar's live ordering (createdMs descending) so ⌃Tab moves in
    // the same visual order the user sees. Exited slices aren't cyclable targets.
    const live = Object.values(sessions)
      .filter((v) => !v.exited)
      .sort((a, b) => b.createdMs - a.createdMs)
    if (live.length < 2) return
    const idx = live.findIndex((v) => v.handleId === activeHandleId)
    // Wrap around; if nothing active, ⌃Tab → first, ⌃⇧Tab → last.
    const nextIdx =
      idx === -1
        ? dir === 1
          ? 0
          : live.length - 1
        : (idx + dir + live.length) % live.length
    get().activateSession(live[nextIdx].handleId)
  },

  setPermissionMode: async (mode) => {
    const active = activeSlice(get())
    if (!active) return
    // Optimistically reflect both the choice AND the resolved "active" mode. The
    // CLI applies the change live but does not re-emit a session-init event, so
    // we update the reported mode ourselves. 'inherit' has no mid-session
    // "unset", so the main process maps it to 'default'; mirror that here.
    set((s) =>
      patchSlice(s, active.handleId, {
        modeChoice: mode,
        // A manual pick wins: drop any model-driven override so the chip shows their choice.
        modelMode: null,
        permissionMode: mode === 'inherit' ? 'default' : mode
      })
    )
    await window.clui.setPermissionMode(active.handleId, mode)
  },

  setModel: async (model) => {
    const active = activeSlice(get())
    if (!active) return
    // If the new model doesn't support the current effort, clamp it down.
    const nextEffort = clampEffort(model, active.effortChoice)
    const prevEffort = active.effortChoice
    // Ultracode requires an xhigh-capable model, so switching to an incompatible one
    // (e.g. Haiku) must turn it OFF, else it'd stay on for a model that can't do it
    // (model switch is live, no respawn, so nothing else would clear it).
    const nextUltra = active.ultracode && supportsUltracodeToggle(model)
    const ultraChanged = nextUltra !== active.ultracode
    // Switching model can change the context window (1M ↔ 200K). Recompute it now from
    // the new id and rescale the ring % against it, else the ring keeps the old
    // window (wrong %, wrong auto-compact notch) until the next turn streams usage. The
    // authoritative window still arrives on the next `result`; this is the id-derived
    // estimate for the gap. Only rescale when we know the resident tokens.
    const nextWindow = contextWindowForModel(model)
    const nextPercent =
      active.contextTokens != null
        ? Math.min(100, Math.round((active.contextTokens / nextWindow) * 100))
        : active.contextPercent
    set((s) =>
      patchSlice(s, active.handleId, {
        modelChoice: model,
        effortChoice: nextEffort,
        ultracode: nextUltra,
        // Only reflect the window in the ring once we have tokens to scale against
        // (mirrors beginSession, which leaves window null until the first usage).
        contextWindow: active.contextTokens != null ? nextWindow : active.contextWindow,
        contextPercent: nextPercent
      })
    )
    // Remember the switch per-session so it survives a resume (the CLI reverts to
    // the settings.json default on --resume). Keyed by the CLI sessionId.
    if (active.sessionId) rememberModelPrefs(active.sessionId, { model, effort: nextEffort, ultracode: nextUltra })
    await window.clui.setModel(active.handleId, model)
    if (nextEffort !== prevEffort) await window.clui.setEffort(active.handleId, nextEffort)
    if (ultraChanged) await window.clui.setUltracode(active.handleId, nextUltra)
  },

  setEffort: async (effort) => {
    const active = activeSlice(get())
    if (!active) return
    set((s) => patchSlice(s, active.handleId, { effortChoice: effort }))
    if (active.sessionId) rememberModelPrefs(active.sessionId, { effort })
    await window.clui.setEffort(active.handleId, effort)
  },

  setUltracode: async (on) => {
    const active = activeSlice(get())
    if (!active) return
    // Only meaningful on xhigh-capable models; ignore on incompatible ones.
    if (on && !supportsUltracodeToggle(active.modelChoice)) return
    // Do NOT mutate the stored effortChoice. The CLI forces xhigh while ultracode is
    // on regardless of effortLevel; the picker DISPLAYS xhigh (derived) + disables while
    // on, and RESTORES the user's real effort when turned off. Mutating stored effort
    // would silently lose their prior choice on toggle-off.
    set((s) => patchSlice(s, active.handleId, { ultracode: on }))
    if (active.sessionId) rememberModelPrefs(active.sessionId, { ultracode: on })
    await window.clui.setUltracode(active.handleId, on)
  },

  sendMessage: async (text, attachments) => {
    const active = activeSlice(get())
    // A turn is valid with text OR at least one attachment (an attachments-only turn is fine).
    if (!active || (!text.trim() && !(attachments && attachments.length))) return
    // Composed while a turn is running → HOLD it renderer-side (editable/cancelable,
    // rendered at the tail) instead of dispatching now. It's sent FIFO at the next turn
    // boundary (see the `result` handler). We do NOT dispatch to the CLI here: dispatching
    // immediately would make it uneditable AND splice it mid-transcript (the ordering bug).
    if (active.busy) {
      const qm: QueuedMessage = { id: `q-${Date.now()}`, text, attachments }
      set((s) =>
        patchSlice(s, active.handleId, {
          queuedMessages: [...(s.sessions[active.handleId]?.queuedMessages ?? []), qm]
        })
      )
      return
    }
    await dispatchTurn(set, active.handleId, text, attachments)
  },
  editQueuedMessage: (id, text) =>
    set((s) => {
      const active = activeSlice(s)
      if (!active) return {}
      return patchSlice(s, active.handleId, {
        queuedMessages: active.queuedMessages.map((q) => (q.id === id ? { ...q, text } : q))
      })
    }),
  cancelQueuedMessage: (id) =>
    set((s) => {
      const active = activeSlice(s)
      if (!active) return {}
      return patchSlice(s, active.handleId, {
        queuedMessages: active.queuedMessages.filter((q) => q.id !== id)
      })
    }),

  interrupt: async () => {
    const active = activeSlice(get())
    if (!active) return
    // Optimistically clear busy so Stop is responsive. The CLI's `result` event
    // (which also clears it) may lag or, if the interrupt races the turn's end,
    // never arrive with new content, so don't leave the composer stuck on "Stop".
    set((s) => patchSlice(s, active.handleId, { busy: false }))
    await window.clui.interrupt(active.handleId)
  },

  stopBackgroundTask: async (handleId, taskId) => {
    const slice = get().sessions[handleId]
    const task = slice?.backgroundTasks[taskId]
    if (!task || task.status !== 'running') return
    // Mark it stopping until the task_updated:killed event lands.
    set((s) =>
      patchSlice(s, handleId, {
        backgroundTasks: {
          ...(s.sessions[handleId]?.backgroundTasks ?? {}),
          [taskId]: { ...task, stopping: true }
        }
      })
    )
    // Kill it directly over the control protocol (instant, no model turn). Fall back to
    // the tool-mediated stop (inject a turn telling the model to call TaskStop, which makes
    // the session busy) only if the control request errors or times out, since the protocol
    // drifts across CLI versions.
    const ok = await window.clui.stopTask(handleId, taskId)
    if (!ok) {
      set((s) => patchSlice(s, handleId, { busy: true }))
      await window.clui.sendMessage(
        handleId,
        `Stop the background task with id ${taskId} now using the TaskStop tool. Do not do anything else.`
      )
    }
  },

  backgroundTask: async (toolUseId) => {
    const active = activeSlice(get())
    if (!active) return false
    // Flag optimistically so the card flips to "launching…"/"launched" on click (the move-time
    // result carries no flag to infer from); revert if it wasn't backgrounded, e.g. tool already done.
    const setFlag = (val: boolean): void =>
      set((s) => {
        const slice = s.sessions[active.handleId]
        if (!slice) return {}
        const messages = slice.messages.map((m) =>
          m.tools.some((t) => t.id === toolUseId)
            ? { ...m, tools: m.tools.map((t) => (t.id === toolUseId ? { ...t, sentToBackground: val } : t)) }
            : m
        )
        return patchSlice(s, active.handleId, { messages })
      })
    setFlag(true)
    const ok = await window.clui.backgroundTask(active.handleId, toolUseId)
    if (!ok) setFlag(false)
    return ok
  },

  clearCompletedBgWork: (kind) =>
    set((s) => {
      const active = activeSlice(s)
      if (!active) return {}
      const patch: Partial<PerSessionState> = {}
      // Drop lingering terminal SUBAGENTS (keep running ones + any bash).
      if (kind !== 'workflow') {
        const nextTasks: Record<string, BackgroundTask> = {}
        for (const [id, t] of Object.entries(active.backgroundTasks)) {
          const lingeringSubagent = t.taskType === 'local_agent' && t.status !== 'running'
          if (!lingeringSubagent) nextTasks[id] = t
        }
        patch.backgroundTasks = nextTasks
      }
      // Drop ENDED workflows (keep running ones, endedStatus === null).
      if (kind !== 'subagent') {
        const nextWf: Record<string, WorkflowState> = {}
        for (const [id, w] of Object.entries(active.workflows)) {
          if (w.endedStatus === null) nextWf[id] = w
        }
        patch.workflows = nextWf
      }
      return patchSlice(s, active.handleId, patch)
    }),

  pruneChangedFiles: async (handleId) => {
    const slice = get().sessions[handleId]
    if (!slice || slice.changedFiles.length === 0) return
    const existing = await window.clui.filterExistingFiles(slice.changedFiles)
    // No change → don't touch state (avoid a needless re-render).
    if (existing.length === slice.changedFiles.length) return
    const keep = new Set(existing)
    set((s) => {
      const cur = s.sessions[handleId]
      if (!cur) return {}
      return patchSlice(s, handleId, { changedFiles: cur.changedFiles.filter((f) => keep.has(f)) })
    })
  },

  respondPermission: async (verdict) => {
    const active = activeSlice(get())
    if (!active) return
    // Optimistically dequeue the request being answered.
    set((s) =>
      patchSlice(s, active.handleId, {
        pendingPermissions: active.pendingPermissions.filter((p) => p.requestId !== verdict.requestId)
      })
    )
    await window.clui.respondPermission(active.handleId, verdict)
  },

  applyEvent: (handleId, e) => {
    // A queued message to dispatch AFTER the reducer commits (a turn boundary released
    // it). A holder object (not a bare `let`) so TS doesn't narrow it to `never` across
    // the `set` closure boundary (it can't see the closure mutation).
    const release: { queued: { handleId: string; msg: QueuedMessage } | null } = { queued: null }
    // Set in the session-init case, acted on post-commit (see there). Holder like `release`.
    const flush: { prefs: { sessionId: string; model: ModelChoice; effort: EffortChoice; ultracode: boolean } | null } =
      { prefs: null }
    // A `/rename` writes the session's on-disk title but emits no stream event to map, so
    // nothing else refreshes the sidebar. Detected at the turn boundary below (the CLI has
    // written the title by then) and acted on post-commit. Holder like `release`.
    const rescanSessions = { needed: false }
    set((state) => {
      const slice = state.sessions[handleId]
      // Slice not created yet: buffer until insertSlice flushes it (race guard).
      if (!slice) {
        const buf = earlyBuffer.get(handleId) ?? []
        buf.push(e)
        earlyBuffer.set(handleId, buf)
        return {}
      }

      // Only copy the message list for events that mutate it (keeps unrelated
      // events like context-usage and result from re-rendering the transcript).
      const messages = touchesMessages(e.type) ? slice.messages.slice() : slice.messages
      const patch: Partial<PerSessionState> = {}
      // Top-level (store-wide) notice to set, if any; survives a slice drop.
      let topLevelNotice: string | null = null
      // Set true to CLEAR the app-level notice (e.g. a fresh session-init resolves the
      // transient "Reconnecting…" notice from an effort/ultracode respawn).
      let clearNotice = false

      switch (e.type) {
        case 'session-init':
          // A pick made before the first message had no sessionId to persist under (null
          // until now), so persist it once the id exists. The null→real gate excludes a
          // resume, whose slice is already seeded from the sidecar, from re-flushing over it.
          if (!slice.sessionId && e.sessionId) {
            flush.prefs = {
              sessionId: e.sessionId,
              model: slice.modelChoice,
              effort: slice.effortChoice,
              ultracode: slice.ultracode
            }
          }
          patch.sessionId = e.sessionId
          patch.model = e.model
          patch.permissionMode = e.permissionMode
          // Reconcile the PICKER (modelChoice) to the model the CLI actually reports.
          // On resume, the CLI keeps the model the session last used (a mid-session
          // set_model survives --resume), but beginSession seeded modelChoice from the
          // stale Settings default, so the picker would lie (show Opus while the CLI
          // runs Sonnet). Adopt the reported model (mapped to the matching picker id).
          if (e.model) {
            const reconciled = reconcileModelChoice(slice.modelChoice, e.model, knownModelIds)
            if (reconciled !== slice.modelChoice) {
              patch.modelChoice = reconciled
              // Keep effort valid for the reconciled model (e.g. Sonnet vs Opus gates).
              patch.effortChoice = clampEffort(reconciled, slice.effortChoice)
            }
          }
          // Adopt the CLI's authoritative (symlink-resolved) cwd. We start a
          // session with e.g. /tmp/clui-scratch-a, but the CLI reports and writes
          // its jsonl under the resolved /private/tmp/clui-scratch-a. Adopting it
          // makes the live session group with its on-disk siblings instead of
          // spawning a duplicate group under the unresolved path (macOS /tmp).
          if (e.cwd) patch.cwd = e.cwd
          // Re-seed accrued cost for this sessionId (survives close→resume and
          // effort-respawn within an app run). Only when we don't already have a
          // higher running total on the slice, so we never lose in-session cost.
          if (e.sessionId) {
            const remembered = costBySessionId.get(e.sessionId)
            if (remembered !== undefined && remembered > (slice.costUsd ?? 0)) {
              patch.costUsd = remembered
            }
          }
          // A fresh init means any prior transient notice (e.g. the effort/ultracode
          // respawn "reconnecting…" message) is now resolved, so clear both the per-slice
          // error and the app-level notice.
          patch.lastError = null
          clearNotice = true
          break
        case 'permission-mode-changed': {
          // The model only switches INTO plan (via EnterPlanMode); any other reported mode is
          // the session's resting base, which for 'inherit' is their settings.json default and
          // isn't knowable here. So show plan as an override, clear otherwise, and never touch
          // modeChoice, so leaving plan falls back to the user's own pick.
          patch.permissionMode = e.mode
          patch.modelMode = e.mode === 'plan' ? 'plan' : null
          break
        }
        case 'text-delta': {
          const m = currentAssistant(messages)
          m.text += e.text
          // Extend the trailing text block, or start a new one (after a tool block)
          // so text that streams AFTER tools renders below them, in true order.
          const tail = m.blocks[m.blocks.length - 1]
          if (tail && tail.kind === 'text') tail.text += e.text
          else m.blocks.push({ kind: 'text', text: e.text })
          break
        }
        case 'thinking-delta': {
          const m = currentAssistant(messages)
          m.thinking += e.text
          break
        }
        case 'tool-use-start': {
          const m = currentAssistant(messages)
          m.tools.push({ id: e.id, name: e.name, input: {}, startMs: Date.now() })
          m.blocks.push({ kind: 'tool', id: e.id })
          break
        }
        case 'tool-use-stop': {
          const m = currentAssistant(messages)
          const t = m.tools.find((t) => t.id === e.id)
          if (t) {
            t.input = e.input
            if (WRITE_TOOLS.has(t.name)) {
              const inp = e.input as { file_path?: unknown; notebook_path?: unknown }
              const fp = typeof inp?.file_path === 'string' ? inp.file_path : inp?.notebook_path
              if (typeof fp === 'string' && fp) {
                patch.changedFiles = [fp, ...slice.changedFiles.filter((f) => f !== fp)]
              }
            }
          }
          break
        }
        case 'tool-result': {
          for (let i = messages.length - 1; i >= 0; i--) {
            const t = messages[i].tools.find((t) => t.id === e.toolUseId)
            if (t) {
              t.result = e.content
              t.isError = e.isError
              break
            }
          }
          break
        }
        case 'permission-request':
          patch.pendingPermissions = [
            ...slice.pendingPermissions,
            {
              requestId: e.requestId,
              toolName: e.toolName,
              input: e.input,
              displayName: e.displayName,
              description: e.description,
              permissionSuggestions: e.permissionSuggestions
            }
          ]
          patch.lastActivityMs = Date.now()
          break
        case 'permission-cancel':
          // The CLI withdrew this pending prompt, so drop it and the dialog closes.
          patch.pendingPermissions = slice.pendingPermissions.filter(
            (p) => p.requestId !== e.requestId
          )
          break
        case 'context-usage':
          patch.contextPercent = e.usedPercent
          patch.contextTokens = e.usedTokens
          patch.contextWindow = e.contextWindow
          // Reset the compact-suggestion dismissal when context drops back below the
          // trigger (a fresh fill-cycle after a manual/auto compact) so the row can
          // offer again. Uses the same window-class threshold as the suggestion.
          if (
            slice.compactDismissedAtRunway != null &&
            e.usedPercent < suggestCompactPercent(e.contextWindow)
          ) {
            patch.compactDismissedAtRunway = null
          }
          break
        case 'slash-commands':
          // The CLI's live command list from the initialize response. Stored raw;
          // the composer curates it to a headless-safe allowlist at render time.
          patch.slashCommands = e.commands
          break
        case 'task-list':
          // Authoritative disk snapshot (last-write-wins). Fall back to the shared
          // empty ref when the list is empty so the puck-gating selector stays stable.
          patch.tasks = e.tasks.length ? e.tasks : EMPTY_TASKS
          break
        case 'subagent-message': {
          // Accumulate a running subagent's forwarded text under its parent Agent
          // tool_use id. Rendered by SubagentView (opened from the Agent card / bg tray).
          const prev = slice.subagentMessages[e.parentToolUseId] ?? EMPTY_SUBAGENT_MSGS
          patch.subagentMessages = {
            ...slice.subagentMessages,
            [e.parentToolUseId]: [...prev, { role: e.role, kind: e.kind, text: e.text }]
          }
          patch.lastActivityMs = Date.now()
          break
        }
        case 'subagent-tool': {
          // A tool the subagent ran, appended to the SAME ordered list as its text so the
          // card renders where it actually happened. De-duped by tool id: the CLI forwards
          // full message snapshots, so the same tool_use block can arrive more than once.
          const prev = slice.subagentMessages[e.parentToolUseId] ?? EMPTY_SUBAGENT_MSGS
          if (prev.some((m) => m.kind === 'tool' && m.tool.id === e.toolUseId)) break
          patch.subagentMessages = {
            ...slice.subagentMessages,
            [e.parentToolUseId]: [
              ...prev,
              { kind: 'tool', tool: { id: e.toolUseId, name: e.name, input: e.input, startMs: Date.now() } }
            ]
          }
          patch.lastActivityMs = Date.now()
          break
        }
        case 'subagent-tool-result': {
          // Match the result to its card by tool id. Search EVERY transcript, not just
          // e.parentToolUseId: the CLI can forward a result under a different parent than
          // the tool_use it answers (seen with nesting), and the id is globally unique.
          const key = Object.keys(slice.subagentMessages).find((k) =>
            slice.subagentMessages[k].some((m) => m.kind === 'tool' && m.tool.id === e.toolUseId)
          )
          if (!key) break
          patch.subagentMessages = {
            ...slice.subagentMessages,
            [key]: slice.subagentMessages[key].map((m) =>
              m.kind === 'tool' && m.tool.id === e.toolUseId
                ? { kind: 'tool', tool: { ...m.tool, result: e.content, isError: e.isError } }
                : m
            )
          }
          patch.lastActivityMs = Date.now()
          break
        }
        case 'subagent-nested': {
          // Nesting: a subagent spawned a child. Record it under the PARENT's
          // tool_use id so SubagentView shows a nested "Agent →" card; de-dupe by
          // childToolUseId (a forwarded snapshot can repeat the same tool_use block).
          const prev = slice.subagentChildren[e.parentToolUseId] ?? EMPTY_NESTED_SUBAGENTS
          if (prev.some((c) => c.childToolUseId === e.childToolUseId)) break
          patch.subagentChildren = {
            ...slice.subagentChildren,
            [e.parentToolUseId]: [
              ...prev,
              {
                childToolUseId: e.childToolUseId,
                name: e.name,
                description: e.description,
                subagentType: e.subagentType
              }
            ]
          }
          patch.lastActivityMs = Date.now()
          break
        }
        case 'workflow-started':
          patch.workflows = {
            ...slice.workflows,
            [e.taskId]: {
              taskId: e.taskId,
              name: e.name,
              description: e.description,
              phases: [],
              agents: [],
              endedStatus: null
            }
          }
          patch.lastActivityMs = Date.now()
          break
        case 'workflow-progress': {
          // Replace the workflow's tree with the latest snapshot (task_progress is a
          // full snapshot each tick). Ignore if we never saw its start (defensive).
          const wf = slice.workflows[e.taskId]
          if (!wf) break
          patch.workflows = {
            ...slice.workflows,
            [e.taskId]: {
              ...wf,
              phases: e.phases.length ? e.phases : wf.phases,
              agents: e.agents.length ? e.agents : wf.agents,
              totalTokens: e.totalTokens ?? wf.totalTokens
            }
          }
          patch.lastActivityMs = Date.now()
          break
        }
        case 'workflow-ended': {
          const wf = slice.workflows[e.taskId]
          if (!wf) break
          patch.workflows = {
            ...slice.workflows,
            [e.taskId]: { ...wf, endedStatus: e.status ?? 'completed' }
          }
          break
        }
        case 'bg-task-started':
          patch.backgroundTasks = {
            ...slice.backgroundTasks,
            [e.taskId]: {
              taskId: e.taskId,
              description: e.description,
              taskType: e.taskType,
              // Carried for backgrounded subagents so the tray row can open the
              // forwarded-transcript SubagentView (keyed by this = the PTU).
              toolUseId: e.toolUseId,
              status: 'running',
              startMs: Date.now()
            }
          }
          break
        case 'bg-task-updated': {
          // A terminal status → mark the task terminal (so the tray, which shows only
          // status==='running', stops listing it) but KEEP the entry so the imminent
          // bg-task-notification can still read its description for the toast. It's
          // removed on that notification (or by bg-tasks-changed dropping it from the
          // running snapshot). This ordering-independence fixes a missed completion
          // toast when task_updated(terminal) arrived before task_notification.
          const prev = slice.backgroundTasks[e.taskId]
          if (prev && e.status && e.status !== 'running') {
            patch.backgroundTasks = {
              ...slice.backgroundTasks,
              [e.taskId]: { ...prev, status: narrowTaskStatus(e.status) }
            }
          }
          break
        }
        case 'bg-task-notification': {
          // Terminal notification → toast + drop the task, but ONLY for a task we were
          // actually tracking. Two layers guard the reported "Background task finished:
          // Background task" phantom: the mapper only emits this for genuine local_bash
          // tasks, AND here we refuse to announce a task that was never in the tray
          // (no `prev` → nothing to report). Because bg-task-updated now MARKS terminal
          // instead of deleting, `prev` is still present here regardless of event
          // ordering, so the real completion toast is never missed.
          const prev = slice.backgroundTasks[e.taskId]
          if (prev) {
            const status = narrowTaskStatus(e.status)
            // LINGER (subagents): a backgrounded SUBAGENT has a reopenable transcript, so
            // instead of deleting the row we KEEP it in a terminal "done" state (still
            // clickable into SubagentView) until it's opened / displaced / times out. A bg
            // BASH shell has no transcript to reopen → delete it as before (its toast is
            // its only trace). Both still toast.
            if (prev.taskType === 'local_agent') {
              patch.backgroundTasks = { ...slice.backgroundTasks, [e.taskId]: { ...prev, status } }
            } else {
              const next = { ...slice.backgroundTasks }
              delete next[e.taskId]
              patch.backgroundTasks = next
            }
            const kind = prev.taskType === 'local_agent' ? 'Background subagent' : 'Background task'
            topLevelNotice = `${kind} ${e.status === 'killed' ? 'stopped' : 'finished'}: ${prev.description}`
          }
          break
        }
        case 'bg-tasks-changed': {
          // Authoritative running snapshot: keep tasks still running. A task that dropped
          // off has ended → remove it UNLESS it's a terminal SUBAGENT we're deliberately
          // lingering (kept clickable until cleared); terminal bash is dropped as before.
          const running = new Set(e.taskIds)
          const next: Record<string, BackgroundTask> = {}
          for (const [id, t] of Object.entries(slice.backgroundTasks)) {
            const lingering = t.taskType === 'local_agent' && t.status !== 'running'
            if (running.has(id) || lingering) next[id] = t
          }
          patch.backgroundTasks = next
          break
        }
        case 'peer-pending': {
          // The anonymous placeholder, above the reply that streams after (cause before effect).
          // A non-'assistant' role means the reply won't fold into it; a fresh message forms below.
          messages.push({
            id: `peer-${Date.now()}-${messages.length}`,
            role: 'peer',
            text: '',
            thinking: '',
            tools: [],
            blocks: [],
            peer: { from: '', pending: true }
          })
          patch.lastActivityMs = Date.now()
          break
        }
        case 'peer-message': {
          // Backfill the open placeholder in place (slot reserved from `started`, no shift).
          // If none is open (degraded result-only path), append a resolved block.
          const idx = messages.findLastIndex((m) => m.role === 'peer' && m.peer?.pending)
          if (idx >= 0) {
            messages[idx] = { ...messages[idx], text: e.body, peer: { from: e.from, pending: false } }
          } else {
            messages.push({
              id: `peer-${Date.now()}-${messages.length}`,
              role: 'peer',
              text: e.body,
              thinking: '',
              tools: [],
              blocks: [],
              peer: { from: e.from, pending: false }
            })
          }
          patch.lastActivityMs = Date.now()
          break
        }
        case 'peer-lifecycle-end': {
          // Lifecycle ended with a placeholder still pending (non-peer lifecycle, or a
          // cancelled send): drop it rather than leave a phantom.
          const idx = messages.findLastIndex((m) => m.role === 'peer' && m.peer?.pending)
          if (idx >= 0) messages.splice(idx, 1)
          break
        }
        case 'result':
          // A bg-subagent completion (`fromTaskNotification`) or a peer-woken turn (`fromPeer`)
          // arrives as its own result: cost is real (accrued below) but it's not the user's
          // turn ending, so it must not clear `busy`, release the queue, or trigger the
          // /rename rescan. Only a genuine user turn-end does those.
          if (!e.fromTaskNotification && !e.fromPeer) {
            patch.busy = false
            patch.lastActivityMs = Date.now()
            // A real turn boundary: if the user queued message(s) during this turn, release
            // the OLDEST now (FIFO). Dequeue it here and dispatch it after this set commits
            // (dispatch is async + re-sets busy; can't run inside the reducer). Remaining
            // queued messages wait for their own boundary.
            if (slice.queuedMessages.length > 0) {
              const [next, ...rest] = slice.queuedMessages
              patch.queuedMessages = rest
              release.queued = { handleId, msg: next }
            }
            // Matched at the command boundary (leading token only), so a mid-sentence
            // "/rename" or another command never triggers the re-scan.
            const lastUser = slice.messages.findLast((m) => m.role === 'user')
            if (lastUser && /^\/rename(\s|$)/.test(lastUser.text.trim())) rescanSessions.needed = true
          }
          // The CLI's `total_cost_usd` is PER-INVOCATION (not cumulative across a
          // --resume, and it resets on an effort-respawn), so ACCUMULATE it rather
          // than replace. Also remember it by sessionId so a later close→resume or
          // respawn re-seeds the running total instead of dropping to this turn's
          // cost. Undefined on some results (e.g. interrupted), a no-op then.
          // (Accrued for BOTH result kinds: the bg completion turn really did cost.)
          if (typeof e.totalCostUsd === 'number') {
            const nextCost = (slice.costUsd ?? 0) + e.totalCostUsd
            patch.costUsd = nextCost
            if (slice.sessionId) {
              costBySessionId.set(slice.sessionId, nextCost)
              // Persist to the sidecar so cost survives an app relaunch.
              void window.clui.setSessionCost(slice.sessionId, nextCost)
            }
          }
          break
        case 'error':
          // 'info' severity = transient status (e.g. "Reconnecting to exit ultracode…"
          // during an effort respawn) → top notice/toast, NOT the red in-chat error
          // box. It auto-clears on the next session-init after the respawn completes.
          if (e.severity === 'info') {
            topLevelNotice = e.message
            break
          }
          // A launch that fails before the CLI ever initialized (model===null),
          // e.g. a missing workspace folder or a bad CLI path, will have its slice
          // dropped on the imminent process-exit, taking a per-slice lastError with
          // it. So surface it ONLY as the app-level notice (top banner, survives the
          // drop), NOT also as the in-chat error box, which would (a) duplicate the
          // message and (b) vanish with the slice anyway. A mid-session error (model
          // already set) shows in-chat as before.
          if (slice.model === null) topLevelNotice = e.message
          else patch.lastError = e.message
          break
        case 'process-exit':
          // A real exit (effort respawns are swallowed in the main process and
          // never reach here). Mark the session no-longer-live but keep its slice.
          patch.busy = false
          patch.exited = true
          break
      }

      // A session that exits WITHOUT the CLI ever initializing THIS run is a
      // failed launch: ENOENT (bad CLI path) or a missing workspace folder. The
      // process never came up (model stays null until session-init), so there's no
      // live session to keep; drop the slice entirely instead of leaving a zombie
      // "exited" session that lingers in the store, mis-counts as live, and (the
      // reported bug) gets picked as the fallback when another session closes,
      // resurfacing its stale error. The transcript (if any) is untouched on disk,
      // so it stays resumable from the sidebar once the folder is back.
      if (e.type === 'process-exit' && slice.model === null) {
        const next = { ...state.sessions }
        delete next[handleId]
        const active =
          state.activeHandleId === handleId
            ? (Object.values(next)
                .filter((s) => !s.exited)
                .sort((a, b) => b.lastActivityMs - a.lastActivityMs)[0]?.handleId ?? null)
            : state.activeHandleId
        // Preserve any notice the preceding error event set (don't clear it just
        // because the slice is being dropped, since that notice IS the explanation).
        return { sessions: next, activeHandleId: active }
      }

      if (touchesMessages(e.type)) patch.messages = messages
      return {
        sessions: { ...state.sessions, [handleId]: { ...slice, ...patch } },
        ...(topLevelNotice !== null ? { notice: topLevelNotice } : clearNotice ? { notice: null } : {})
      }
    })
    // A turn boundary released a queued message: dispatch it now (async; re-sets busy +
    // appends its bubble via dispatchTurn). Runs AFTER the reducer committed the dequeue,
    // so the queue and the new turn never race. Fire-and-forget (matches sendMessage).
    if (release.queued) {
      void dispatchTurn(set, release.queued.handleId, release.queued.msg.text, release.queued.msg.attachments)
    }
    if (rescanSessions.needed) void get().refreshSessions()
    // Side-effect, so it runs after the reducer commits, not inside the updater.
    if (flush.prefs) {
      rememberModelPrefs(flush.prefs.sessionId, {
        model: flush.prefs.model,
        effort: flush.prefs.effort,
        ultracode: flush.prefs.ultracode
      })
    }
  },

  setNotice: (message) => set(() => ({ notice: message })),
  dismissNotice: () => set(() => ({ notice: null })),
  dismissCompactSuggestion: () =>
    set((s) => {
      const active = activeSlice(s)
      if (!active) return {}
      // Record the runway (tokens-until-auto-compact) at dismissal, so the suggestion
      // can re-arm ONCE when runway shrinks into the last-call band (see compaction.ts).
      const auto = active.contextWindow ? autoCompactPercent(active.contextWindow) : null
      const runway =
        auto != null && active.contextTokens != null && active.contextWindow
          ? Math.max(0, Math.round((auto / 100) * active.contextWindow) - active.contextTokens)
          : 0
      return patchSlice(s, active.handleId, { compactDismissedAtRunway: runway })
    }),
  // Fresh entry from an Agent card / bg tray / workflow chip → the trail is just [id].
  viewSubagent: (parentToolUseId) =>
    set(() => ({ viewingSubagent: parentToolUseId, subagentTrail: [parentToolUseId] })),
  // Nesting: drill into a child by pushing it; `viewingSubagent` mirrors the tail.
  // Guard against pushing a dupe (e.g. double-click) so "back" always makes progress.
  pushSubagent: (childToolUseId) =>
    set((s) =>
      s.subagentTrail[s.subagentTrail.length - 1] === childToolUseId
        ? {}
        : { viewingSubagent: childToolUseId, subagentTrail: [...s.subagentTrail, childToolUseId] }
    ),
  // Pop one level; at the root this closes the view (empty trail → back to chat).
  popSubagent: () =>
    set((s) => {
      const trail = s.subagentTrail.slice(0, -1)
      return { subagentTrail: trail, viewingSubagent: trail[trail.length - 1] ?? null }
    }),
  // Truncate the trail to `depth+1` entries (breadcrumb click); clamps defensively.
  gotoSubagentDepth: (depth) =>
    set((s) => {
      const trail = s.subagentTrail.slice(0, Math.max(1, depth + 1))
      return { subagentTrail: trail, viewingSubagent: trail[trail.length - 1] ?? null }
    }),
  closeSubagentView: () => set(() => ({ viewingSubagent: null, subagentTrail: [] })),

  // Search UI. Find-in-conversation only makes sense over the live Virtuoso
  // transcript, so opening it is a no-op while viewing a subagent transcript.
  setFindOpen: (open) =>
    set((s) => (open && s.viewingSubagent ? {} : { findOpen: open })),
  setGlobalSearchOpen: (open) => set(() => ({ globalSearchOpen: open })),
  requestScrollTo: (messageId) =>
    set((s) => ({ scrollTarget: { messageId, nonce: (s.scrollTarget?.nonce ?? 0) + 1 } }))
}))
