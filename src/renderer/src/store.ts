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
import { isListPriced, type DomainEvent, type ElicitationResponse, type PermissionDenial, type PermissionSuggestion, type RateLimit, type SessionTask, type SlashCommandInfo, type TurnEnd, type TurnUsage } from '../../shared/events'
import type { BlockedPrompt, CompactionMarker, ProjectGroup } from '../../shared/sessions'
import type { CurrentTurn } from './lib/instrument'
import { autoCompactPercent, suggestCompactPercent } from './lib/compaction'
import type { CluiApi, DispatchResult, EffortCaps, PermissionModeChoice, PermissionVerdict, WireAttachment } from '../../shared/ipc'
import { loadFailureOf, siteKeyOf, type BrowserEvent, type BrowserPaneState, type BrowserState, type TabState } from '../../shared/browser'
import { PERMISSION_MODE_LABELS, clampEffort, reconcileModelChoice, setLiveEfforts, supportsUltracodeToggle, contextWindowForModel, contextSizeLabel, latestModelInFamily, deriveModelInfo, modelCheckReason, EFFORT_CHOICES, type EffortChoice, type ModelChoice } from '../../shared/settings'
import type { ProcessedAttachment } from './lib/images'
import { pinWords, clipName, type AnnotateEvent } from '../../shared/annotate'
import {
  CAP_NOTE,
  CHANGE_READ_TOOL,
  isRefInput,
  MAX_REFS,
  messageGist,
  REF_NOTE_MAX,
  packetLayout,
  refKey,
  resourceOf,
  sentRefs,
  serializeContext,
  type ContextReference,
  type DraftReference,
  type DraftVisual,
  type RefFailure,
  type RefInput,
  type RefInvalid,
  type ReferenceInvalidation,
  type SourceVersion
} from '../../shared/context'
import { removalSpoken, pausedText, resourceLabel, shortLabel } from './lib/refCopy'
import type { Via } from './lib/motion'
import { CHANGE_BYTES_MAX, CHANGE_TEXT_BUDGET, type ChangeGitStatus, type FileChangeSummary, type GitPathStatus } from '../../shared/changes'
import { SURFACE_TAB_CAP, surfaceIdOf, type OpenIntent, type OpenedBy, type SavedTab, type SurfaceKind, type SurfaceSet, type SurfaceTab, type SurfacesRestore, type SurfacesSave } from '../../shared/surfaces'
import { clean, type SurfaceCommand, type SurfaceReply, type SurfaceTarget, type TabFact } from '../../shared/surface-tools'
import { turnEndLine } from './lib/turnEnd'
import { suffixes } from './lib/tree'
import { fileLike } from './lib/presentation'
import { isHtml } from '../../shared/html-view'

export type SettingsSection = 'general' | 'sessions' | 'pane' | 'advanced'
/** The sections with a second tab row, and their tabs. */
export type SettingsSubs = { sessions: 'new' | 'quick'; pane: 'general' | 'browser' | 'artifacts' }

/** A tool-permission request awaiting the user's decision. */
export interface PendingPermission {
  requestId: string
  toolName: string
  input: unknown
  displayName?: string
  description?: string
  /** Actions the CLI suggests with this request (2.1.245+), e.g. "accept edits this session". */
  permissionSuggestions?: PermissionSuggestion[]
  decisionReason?: string
  decisionReasonType?: string
  blockedPath?: string
  suppressAlwaysAllow?: boolean
  /** Set when a subagent asks: its Agent tool_use id and task description. */
  agentToolUseId?: string
  agentDescription?: string
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
export type MessageBlock = { kind: 'text'; text: string } | { kind: 'tool'; id: string } | ({ kind: 'hook' } & HookNote)

/** A hook's message in the transcript. `event` is absent when the CLI's wording didn't name one.
 *  Repeats within one message bump `count` in place, since PreToolUse hooks fire per tool call. */
export interface HookNote {
  event?: string
  matcher?: string
  /** Set for a plugin's line: a `ui_log`, or a toast from a session that wasn't being viewed. */
  plugin?: string
  text: string
  count: number
}

/** One plugin's `ui_status` line. */
export interface ModStatusLine {
  plugin: string
  text: string
}

/** A plugin's toast card. `count` bumps when the same plugin repeats the same text while it shows. */
export interface ModToast {
  id: string
  plugin: string
  text: string
  durationMs: number
  count: number
  at: number
}

/** A displayable attachment on a USER bubble: an image thumbnail or a document/text
 *  file chip. Present on live bubbles the composer created AND on resumed user turns
 *  (images recovered from the transcript). */
export type MessageAttachment =
  | { kind: 'image'; previewUrl: string; name?: string; w?: number; h?: number; blockIndex?: number }
  | { kind: 'image-unavailable'; blockIndex: number }
  | { kind: 'document'; name: string; bytes: number; blockIndex?: number }
  | { kind: 'text'; name: string; bytes: number; lines: number; blockIndex?: number }
export type ShownAttachment = Exclude<MessageAttachment, { kind: 'image-unavailable' }>

/** What the composer hands `sendMessage`: the wire payload for the CLI plus the
 *  display metadata for the optimistic user bubble. */
export interface SendAttachment {
  wire: WireAttachment
  display: ShownAttachment
}

/** An inbound cross-session peer message rendered as its own attributed transcript block
 *  (`role:'peer'`). `pending` = the anonymous placeholder shown from command_lifecycle:started
 *  until the peer-origin result backfills the sender (`from`) + body (`text`). */
export interface PeerMessage {
  from: string
  pending: boolean
}

/** A background task whose end woke Claude for a turn of its own. A `running` monitor is a
 *  provisional guess, made when a turn starts on its own while monitors watch. */
export interface WokenTask {
  kind: 'agent' | 'command' | 'monitor'
  description: string
  status: 'completed' | 'failed' | 'killed' | 'running'
  /** A monitor's tool_use id. */
  id?: string
}

/** A Monitor tool call's life, kept past its bash task so the row keeps its final state. */
export interface MonitorRecord {
  taskId: string
  description: string
  status: 'running' | 'completed' | 'killed' | 'failed'
  startMs: number
  /** Wakes counted on this monitor, shared ones included. */
  wakes: number
  /** Of those, wakes while another monitor was also running. */
  sharedWakes: number
  /** Summed cost of those wakes. */
  costUsd: number
  /** Some counted wake was priced at list. */
  estimated: boolean
}

/** How a finished turn ended, for its footer. Its presence also closes the message, so whatever
 *  streams next (a background-woken turn) starts a message of its own. */
export interface TurnRecord {
  reason?: TurnEnd
  durationMs?: number
  /** Background tasks the turn launched itself, not ones its subagents started. */
  bgTaskIds?: string[]
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
  /** Rule-denied tool calls this turn, rendered as a notice under the turn. */
  denials?: PermissionDenial[]
  /** This turn's usage breakdown, rendered as a disclosure trailer. Absent on
   *  rebuilt-from-disk history (not persisted). */
  usage?: TurnUsage
  compaction?: CompactionMarker
  /** Hook messages from before Claude replied, under a user bubble. On an assistant message
   *  they make it a standalone marker for notes that arrived outside a turn. */
  hookNotes?: HookNote[]
  /** On a user message: a UserPromptSubmit hook stopped it. */
  blocked?: BlockedPrompt
  turnEnd?: TurnRecord
  /** The background tasks whose end started this turn. */
  wokenBy?: WokenTask[]
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
  /** What the user typed, never serialized context. */
  text: string
  /** With their crop bytes until dispatch. */
  refs: DraftReference[]
  /** The user's own attachments only. */
  attachments?: SendAttachment[]
  /** Set while references it held went stale: the queue waits on it until the user reviews it. */
  needsReview?: ReferenceInvalidation[]
}

/** Where a reference action lands: null is the draft, else a queued message's id. */
export type RefTarget = string | null
/** `invalidateSource`'s resource for every change ref at once: they lose access together, never per file. */
export const CHANGE_REFS = 'change:*'
/** `budget`: the change refs' text would pass CHANGE_TEXT_BUDGET for the message. */
export type AddRefResult = { status: 'added'; id: string } | { status: 'duplicate'; id: string; key: string } | { status: 'cap' } | { status: 'budget' } | { status: 'invalid' }

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
  /** Auto mode couldn't reach its classifier, so the call was held back without running. */
  notRun?: boolean
  /** A Stop or Send now ended the call while it ran. */
  stopped?: boolean
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
  /** Ultracode on for this session (workflow orchestration at the stored effort). Per-session,
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
  /** Quick session: spawned with `--no-session-persistence`, so no transcript ever hits disk.
   *  Drives the "Not saved" marker and reduces the sidebar row to a live-only, close-to-discard row. */
  ephemeral: boolean
  /** Number of messages in the index at which live turns begin (history above). */
  historyCount: number
  /** True while a turn is streaming. */
  busy: boolean
  /** A foreground turn was interrupted (Stop) and we're awaiting its terminal result: that
   *  result is swallowed (cost only) but still marks the FIFO turn boundary. Distinct from
   *  idle so a new prompt QUEUES rather than dispatching a second concurrent turn whose busy
   *  the late result would clear and whose bubble late text would attach to. */
  interrupting: boolean
  /** Wall-clock ms when the current foreground turn started, null when idle. Drives the
   *  WorkingStatus timer from the clock so it survives session-switch / detail remounts and
   *  resets per queued turn. */
  turnStartMs: number | null
  thinkingTokens: number | null
  compacting: boolean
  /** Polite transcript-level announcement: compaction progress, a hook-blocked prompt. */
  statusAnnounce: string
  messages: ChatMessage[]
  /** Messages composed while a turn was running: held renderer-side (editable/cancelable),
   *  rendered at the transcript tail, dispatched FIFO at the next turn boundary. */
  queuedMessages: QueuedMessage[]
  /** Composer draft for THIS session: text + staged attachments held in the slice, so it
   *  survives switching sessions and the Composer unmounting for a detail view. */
  draftText: string
  draftAttachments: ProcessedAttachment[]
  pendingPermissions: PendingPermission[]
  /** Files Claude changed this session, most-recent first, mirrored from the main-side ledger. */
  changes: FileChangeSummary[]
  /** Background tasks keyed by taskId (running + recently-terminal, ordered by start). */
  backgroundTasks: Record<string, BackgroundTask>
  /** Plugin status lines in first-arrival order. The CLI never replays them, so they last as long as the process. */
  modStatus: ModStatusLine[]
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
  /** Monitor tool calls by tool_use id. */
  monitors: Record<string, MonitorRecord>
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
  /** The CLI's latest API retry this turn, shown in the notice strip. Cleared as soon as
   *  the turn streams, ends, or is stopped. */
  apiRetry: ApiRetry | null
  apiRetryDismissed: boolean
  /** The retry copy for the live region: only a run's first and last attempts, so a ten-attempt
   *  run is two announcements, not ten. */
  apiRetryAnnounce: string
  /** Tool calls auto mode's classifier is still deciding on, by tool_use id. */
  checkingTools: Record<string, true>
  /** The account's latest usage-limit warning or block; null while usage is fine. */
  rateLimit: RateLimit | null
  rateLimitDismissed: boolean
  /** Set only when the limit's status changes, so each change is announced once. */
  rateLimitAnnounce: string
  /** Background tasks the running turn launched, handed to its footer at the result. */
  turnTasks: string[]
  /** Tasks that ended since the last result: what a background-woken turn is about. */
  endedTasks: WokenTask[]
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
  /** Browser for this session; null when its process started without the browser tools. */
  browser: BrowserTabs | null
  /** This session's Surfaces pane is showing in the right sidebar. */
  paneOpen: boolean
  /** The user's half or full choice for this session's pane when the Stage can split. Below
   *  SPLIT_MIN an open pane is full regardless, and that never counts as a choice. */
  surfacePaneFull: boolean
  /** Claude used the browser while this session was in the background; its pane opens on return. */
  paneAutoOpen: boolean
  /** The user hid the pane, so Claude's browser use leaves it hidden until their next prompt. */
  paneAutoOpenSuppressed: boolean
  /** The pane's tabs. Browser placements follow `browser` inside patchSlice. */
  surfaces: SurfaceSet
  /** Why the saved tabs weren't opened, for the picker until the session's first tab opens. */
  restoreNote: 'newer' | 'corrupt' | null
  /** The tab cap has closed a tab in this session, so later ones are only announced. */
  tabsEvicted: boolean
  annotate: AnnotateDraft
  /** References for the next message, in chip order. */
  contextRefs: DraftReference[]
  /** Why references left the draft, by resource (change refs by reason, `change:<reason>`), until reselected or
   *  dismissed. */
  referenceNotices: Record<string, ReferenceInvalidation>
  /** Whether this session's CLI has the change_read tool, from its init; null before the first one. */
  changeRead: boolean | null
  /** Where File, Tree and page adds land: null is the draft, else a queued message under review. */
  referenceEditTarget: RefTarget
  /** The composer's polite announcement for its chips row and notices. */
  refAnnounce: string
}

/** A tab the cap closed, held for its card's lifetime so Reopen can put it back where it was. */
export interface EvictedTab {
  id: string
  handleId: string
  tab: SurfaceTab
  index: number
  at: number
}

/** Elements pinned for the next message. `tab` is the tab being annotated now; `note` replaces the status
 *  line's hint after a refused pick, until the next pick. */
export interface AnnotateDraft {
  tab: number | null
  note: string | null
}

const IDLE_ANNOTATE: AnnotateDraft = { tab: null, note: null }
export const EMPTY_REFS: DraftReference[] = []
export const EMPTY_NOTICES: Record<string, ReferenceInvalidation> = {}

export const DRIVING_NOTE = "Point when it's done."

const REFUSED: Record<Extract<AnnotateEvent, { type: 'refused' }>['why'], string> = {
  password: "Password fields can't be added.",
  cap: CAP_NOTE,
  failed: "That element can't be added."
}

/** A session's browser tabs. A closed tab is one whose id is no longer in `tabs`. */
export interface BrowserTabs {
  /** In open order, which is also id order. */
  tabs: TabState[]
  viewed: number
  /** The session has had more than one tab at some point, so transcript rows name their tab. */
  multi: boolean
  /** The tab each browser tool call ran in, by tool_use id, in the order main reported them. */
  toolTabs: Record<string, number>
  /** Tabs Claude opened. Only these fade in. */
  enter: number[]
  /** Polite announcement of Claude opening and closing tabs, read by the tab strip. */
  announce: string
}

/** What the sign-in Gates send back to main. Never stored in the slice: it can carry a password. */
export type BrowserLoginVerdict = Parameters<CluiApi['browserLoginVerdict']>[2]

/**
 * Max concurrent live `claude` processes. Unlike terminal tabs, each live session
 * is a real subprocess (memory + possibly an API socket), so we cap them. When a
 * new session would exceed the cap we evict the least-recently-active session that
 * is NOT busy and NOT active; if every candidate is busy we never kill one, and
 * instead surface a notice and let the count run over.
 */
const LIVE_SESSION_CAP = 8

/** Tone of the app-level notice banner, driving its color + icon. */
export type NoticeTone = 'success' | 'warn' | 'error' | 'info'

export type ApiRetry = Omit<Extract<DomainEvent, { type: 'api-retry' }>, 'type'>

export function apiRetryCopy(r: ApiRetry): string {
  const secs = Math.max(1, Math.ceil(r.delayMs / 1000))
  const cause = r.status === null ? "Couldn't reach the API." : `The API returned ${r.status}.`
  return r.attempt === r.maxRetries
    ? `${cause} Last retry in ${secs}s.`
    : `${cause} Retrying in ${secs}s, attempt ${r.attempt} of ${r.maxRetries}.`
}
const WINDOWS: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly' }

/** When a limit resets, as a clock time: `at 3:40 PM`, `Tuesday at 3:40 PM`, `on Oct 20`. After
 *  "until" the same-day and later forms drop their preposition. */
export function resetPhrase(resetsAtSec: number, afterUntil: boolean, now = new Date()): string {
  const at = new Date(resetsAtSec * 1000)
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at)
  const days = Math.round((new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000)
  if (days <= 0) return afterUntil ? time : `at ${time}`
  if (days <= 6) return `${new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(at)} at ${time}`
  const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(at)
  return afterUntil ? date : `on ${date}`
}

export function rateLimitCopy(r: RateLimit, now = new Date()): string {
  const reset = r.resetsAt === undefined ? null : r.resetsAt
  if (r.status === 'rejected') {
    if (r.extraUsage) {
      return reset === null
        ? "Usage limit reached. Extra usage is on, so Claude keeps going and it's billed to your account."
        : `Usage limit reached. Extra usage is on, so Claude keeps going and it's billed to your account until ${resetPhrase(reset, true, now)}.`
    }
    return `Usage limit reached. Claude can't respond until ${reset === null ? 'it resets' : resetPhrase(reset, true, now)}.`
  }
  const window = r.window ? WINDOWS[r.window] : undefined
  const used =
    r.utilization === undefined
      ? "You're close to your usage limit."
      : `You've used ${Math.round(r.utilization * 100)}% of your ${window ? `${window} limit` : 'usage limit'}.`
  return reset === null ? used : `${used} It resets ${resetPhrase(reset, false, now)}.`
}

/** The transient app-level notice: a message plus the tone that channels its styling. */
export interface Notice {
  message: string
  tone: NoticeTone
}

interface SessionStore {
  /** All live sessions, keyed by handleId. */
  sessions: Record<string, PerSessionState>
  /** The session the UI currently views (null = none open → welcome screen). */
  activeHandleId: string | null
  /** Transient app-level notice (e.g. a session was evicted by the cap). */
  notice: Notice | null
  /** Polite announcement from the browser (a login Clui filled), read by the browser pane's live region. */
  browserAnnounce: string
  /** `defaultMode` from ~/.claude/settings.json, null when it sets none; undefined until first read. */
  systemPermissionMode: string | null | undefined
  /** Re-read it (read-only), at app start and when the window regains focus. */
  refreshSystemPermissionMode: () => Promise<string | null>
  /** Plugin toasts for the viewed session, newest first. */
  modToasts: ModToast[]
  /** The latest plugin toast for the toast stack's live region; `at` lets it lose to a newer delete announcement. */
  modToastAnnounce: { text: string; at: number }
  /** Each session's first eviction by the tab cap, one card each, newest first. */
  evictedTabs: EvictedTab[]
  evictedAnnounce: { text: string; at: number }
  /** Puts an evicted tab back at its old index, else at the end, and shows it. */
  reopenEvicted: (id: string) => void
  /** Effort ceilings from ~/.claude/settings.json (read-only), so the picker/chip show
   *  the effort that will actually run under a `maxEffortLevel` cap. Read via `effortCap`. */
  effortCaps: EffortCaps
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
  /** The user's size choice for the subagent pane when the Stage can split: false = half, true = full.
   *  Below SPLIT_MIN an open pane is full regardless, and that never counts as a choice. Persisted. */
  paneFull: boolean
  setPaneFull: (full: boolean) => void
  /** The Stage is at least SPLIT_MIN wide, the only width where a half pane renders as half. */
  stageWide: boolean
  setStageWide: (wide: boolean) => void
  /** Called on Claude's browser tool use in placement `id`. True means open the viewed session's pane
   *  now on that tab; a background session is marked to open when it's next activated. */
  autoOpenPane: (handleId: string, id: string) => boolean
  /** The next side pane to mount opened without being asked for, so it must leave focus alone. */
  paneOpenedQuietly: boolean
  /** Content sits under the top band or the pane header, the only time their glass shows. Written
   *  on change, never per scroll event. */
  primaryScrolled: boolean
  /** The handle whose transcript last reported primaryScrolled. The band holds its fade until the
   *  report for the open session lands, so a session that opens scrolled shows its tint at once. */
  primaryScrolledFor: string | null
  setPrimaryScrolled: (scrolled: boolean) => void
  secondaryScrolled: boolean
  setSecondaryScrolled: (scrolled: boolean) => void

  // ── Search UI state (app-level) ─────────────────────────────────────────────
  /** True when the ⌘F in-transcript find bar is open (find-in-current-conversation). */
  findOpen: boolean
  /** The message the find bar's current match points at, for the transcript's persistent marker. */
  findActiveId: string | null
  setFindActiveId: (id: string | null) => void
  /** True when the ⌘⇧F global search overlay is open. */
  globalSearchOpen: boolean
  /** The Settings section showing; null while Settings is closed. */
  settingsSection: SettingsSection | null
  /** Each sub-nav's tab for this open of Settings; a missing one shows its first tab. */
  settingsSub: Partial<SettingsSubs>
  /**
   * A jump request for Chat: scroll to the message with this id, washing it when `flash` is set.
   * `nonce` makes repeated jumps to the SAME id re-fire (Chat watches the nonce). No need to
   * clear it after consumption, since Chat keys off the nonce change.
   */
  scrollTarget: { messageId: string; nonce: number; align?: 'start'; flash?: Via } | null
  /** The prompt whose reply is at the top of the transcript, shown in the top band's middle
   *  slot; null while that prompt is itself the top row, or while no transcript is mounted. */
  currentTurn: CurrentTurn | null
  setCurrentTurn: (v: CurrentTurn | null) => void

  /** On-disk session list (grouped by project), owned here so both the sidebar and
   *  any store-side trigger read/refresh one copy. Sourced from `listSessions()`. */
  sessionGroups: ProjectGroup[]
  /** True while a `refreshSessions()` scan is in flight (drives the sidebar skeleton). */
  sessionsLoading: boolean
  /** The "no directory" cwd (~/.clui or the configured default), fetched once and cached so
   *  the sidebar, status bar, and composer can recognize a directoryless session by an exact
   *  cwd match without each re-hitting IPC. null until `loadChatDir` resolves. */
  chatDir: string | null
  /** Re-scan `~/.claude/projects` and replace `sessionGroups`. Awaitable so a caller can
   *  sequence work after the list lands (e.g. the delete-commit that hides a row).
   *  `quiet` skips `sessionsLoading` so a mid-session rescan can't flash the skeleton. */
  refreshSessions: (quiet?: boolean) => Promise<void>

  /** Re-read the CLI effort caps from ~/.claude/settings.json into `effortCaps`. Called at
   *  startup and on each session start, so a settings.json edit is picked up at that boundary. */
  loadEffortCaps: () => Promise<void>

  /** Fetch + cache the chat dir into `chatDir` once (idempotent). Called at startup. */
  loadChatDir: () => Promise<void>

  /** Open/close the ⌘F find bar (no-op-open while viewing a subagent transcript). */
  setFindOpen: (open: boolean) => void
  /** Open/close the ⌘⇧F global search overlay. */
  setGlobalSearchOpen: (open: boolean) => void
  /** Open Settings on a section and sub-tab, or switch to them while open. Without a section it opens on General. */
  openSettings: {
    (section?: SettingsSection): void
    <S extends keyof SettingsSubs>(section: S, sub: SettingsSubs[S]): void
  }
  closeSettings: () => void
  /** Request Chat scroll to a message by id; `flash` marks where the reader landed. */
  requestScrollTo: (messageId: string, opts?: { align?: 'start'; flash?: Via }) => void

  /** Start a NEW session in `cwd` and make it active. */
  startSession: (
    cwd: string,
    mode?: PermissionModeChoice,
    opts?: { model?: ModelChoice; effort?: EffortChoice; name?: string; ephemeral?: boolean }
  ) => Promise<void>
  /** Resume an on-disk session (loads history) and make it active. `hardTitle` (a sidecar
   *  rename or on-disk customTitle) is re-asserted as `-n` so the resumed session stays
   *  peer-discoverable under that name; omit for a derived (first-message) title. */
  resumeSession: (
    cwd: string,
    resumeSessionId: string,
    mode?: PermissionModeChoice,
    hardTitle?: string
  ) => Promise<void>
  /** Fork a session (live or dormant) → a NEW live branch carrying its context,
   *  original untouched (`--fork-session`). Fork-from-HEAD; never short-circuits to an
   *  existing live session (the point is a new branch). */
  forkSession: (cwd: string, sourceSessionId: string, mode?: PermissionModeChoice) => Promise<void>
  /** View an already-live session without touching its process (instant switch). */
  activateSession: (handleId: string) => void
  /** Push a rename onto a LIVE session (updates its discovery name via `/rename`), deferring
   *  to turn-end if busy. Dormant sessions use `window.clui.renameSession` (the sidecar). */
  renameLiveSession: (handleId: string, name: string) => void
  /** Stop a live session's process and drop its slice. */
  closeSession: (handleId: string) => Promise<void>
  /** Move the active view to the next (dir=1) / previous (dir=-1) live session,
   *  in sidebar order, wrapping around. No-op with fewer than 2 live sessions. */
  cycleSession: (dir: 1 | -1) => void

  /**
   * Send a user turn. `attachments` carries both the lean wire payload (image
   * blocks sent to the CLI) and a display thumbnail for the user's own bubble.
   */
  sendMessage: (text: string, attachments?: SendAttachment[], opts?: { now?: boolean; refs?: DraftReference[] }) => Promise<void>
  /** Send a queued message now, cutting the running turn's step, instead of at the turn's end. */
  sendQueuedNow: (id: string) => void
  /** Edit a still-queued message's text (before it's dispatched at the turn boundary). */
  editQueuedMessage: (id: string, text: string) => void
  /** Remove a still-queued message (never dispatched). */
  cancelQueuedMessage: (id: string) => void
  /** Set a session's composer draft text (per-handle so it survives switches). */
  setDraftText: (handleId: string, text: string) => void
  /** Append staged attachments to a session's draft, bound to the handle the conversion
   *  started for so a late async result can't land in another session's draft. */
  addDraftAttachments: (handleId: string, atts: ProcessedAttachment[]) => void
  /** Remove one staged draft attachment by id. */
  removeDraftAttachment: (handleId: string, id: string) => void
  /** Clear a session's draft (text + attachments) once a successful send has consumed it. */
  clearDraft: (handleId: string) => void
  interrupt: () => Promise<void>
  /** Stop a running background task (tool-mediated TaskStop; costs a turn). */
  stopBackgroundTask: (handleId: string, taskId: string) => Promise<void>
  /** Move a running foreground tool to the background (keeps running in the tray). */
  backgroundTask: (toolUseId: string) => Promise<boolean>
  /** Clear the LINGERING completed subagents + ended workflows from the active session's
   *  trays (fired when they're opened, displaced by new same-kind work, or a grace timer
   *  elapses). Never touches running items. `kind` scopes it to one tray or both. */
  clearCompletedBgWork: (kind?: 'subagent' | 'workflow') => void
  /** Re-read the session's Claude changes, which re-checks each file's presence on disk. */
  refreshChanges: (handleId: string) => Promise<void>
  /** Git decoration by absolute path, the last reply for each path whichever session asked, so a
   *  checkout shared by two sessions decorates at once. */
  gitStatus: ChangeGitStatus
  /** Re-read Git decoration for a session's changed files. A reply older than the handle's latest request is dropped. */
  refreshGitStatus: (handleId: string) => Promise<void>
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
  /** Set the transient app-level notice. Tone defaults to 'warn' so a caller that omits it
   *  gets the amber banner. */
  setNotice: (message: string, tone?: NoticeTone) => void
  /** Dismiss the transient app-level notice. */
  dismissNotice: () => void
  dismissModToast: (id: string) => void
  /** Hide the active session's retry strip for the rest of this retry run. */
  dismissApiRetry: () => void
  /** Hide the active session's usage-limit strip until the limit's status changes. */
  dismissRateLimit: () => void
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
  /** Route one browser event from main into its session's slice. */
  applyBrowserEvent: (handleId: string, e: BrowserEvent) => void
  applyAnnotateEvent: (handleId: string, e: AnnotateEvent) => void
  /** Annotate on or off in the active session's viewed tab; refused while Claude drives it. */
  toggleAnnotate: () => void
  /** Stage a reference on the edit target (or `opts.target`). Refuses a duplicate, the 21st, a malformed input, or
   *  change text past the message budget. A change ref needs `bytes`, its mint's measured size. */
  addRef: (handleId: string, input: RefInput, opts?: { target?: RefTarget; visual?: DraftVisual; pinId?: number; bytes?: number }) => AddRefResult
  removeRef: (handleId: string, id: string, target?: RefTarget) => void
  /** The user's note on one reference, kept as typed up to REF_NOTE_MAX; an empty one is deleted. */
  setRefNote: (handleId: string, id: string, note: string | undefined, target: RefTarget) => void
  moveRef: (handleId: string, id: string, delta: -1 | 1, target?: RefTarget) => void
  /** Draft only, by id, so a reference added since survives. */
  clearRefs: (handleId: string, ids: readonly string[]) => void
  dismissReferenceNotice: (handleId: string, resourceId: string) => void
  /** The one place staleness removes references. Returns how many went. */
  invalidateSource: (handleId: string, resourceId: string, cause: { reason: RefFailure | 'session'; version?: SourceVersion }) => number
  setReferenceEditTarget: (handleId: string, target: RefTarget) => void
  /** Re-checks a queued message's references; true when it may send, and an idle session's head sends now. */
  acceptReview: (handleId: string, queueId: string) => Promise<boolean>
  /** A respawn's draft references: files that pass on the new session stay, the rest become notices. */
  carryRefs: (handleId: string, refs: readonly DraftReference[]) => Promise<void>
  announceRefs: (handleId: string, text: string) => void
  /** The transcript's polite region, which stays mounted while the pane is closed. */
  announceStatus: (handleId: string, text: string) => void
  /** Answer a sign-in Gate. The verdict goes straight to main. */
  respondBrowserLogin: (requestId: string, verdict: BrowserLoginVerdict) => Promise<void>
  /** Answers a page's local network ask; the strip goes once main clears the tab's netAsk. */
  /** False when the choice couldn't be saved: the strip stays up and says so. */
  decideLocalNet: (site: string, allow: boolean) => Promise<boolean>
  /** Repeats in the browser pane's live region even when `text` matches the last announcement. */
  announceBrowser: (text: string) => void
  /** Answer an MCP elicitation Gate. */
  respondElicitation: (requestId: string, response: ElicitationResponse) => Promise<void>
  /** Set the active session's pane. Opening it replaces a subagent view and needs a cwd; with no tabs it
   *  shows the picker. Half or full is an explicit size choice, kept for that session. */
  setPane: (next: BrowserPaneState) => void
  /** The band's toggle: hides a showing pane, else opens it on paneTarget, or on the picker when there's
   *  nothing to show. `apply` makes the pane change, so a
   *  pointer caller can wrap it in a transition. */
  togglePane: (apply?: (next: BrowserPaneState) => void) => void
  /** ⇧⌘B: hides a pane that shows the browser, else shows a browser tab. */
  toggleBrowser: (apply?: (next: BrowserPaneState) => void) => void
  /** Shows browser tab `tab`, else the last one viewed, else a new one, opening the pane if it's hidden. */
  revealBrowser: (tab: number | null, apply?: (next: BrowserPaneState) => void) => Promise<void>
  /** Places a non-browser surface and applies its intent. Returns its id. */
  openSurface: (handleId: string, spec: SurfaceSpec | { kind: 'browser'; tab: number }, intent: OpenIntent, actor: 'user' | 'claude', openedBy: OpenedBy) => string
  /** Closing the active tab activates its neighbour in `order`; a browser placement closes its tab in main. The last tab hides the pane. */
  closeSurface: (handleId: string, id: string) => void
  /** Clears `unseen`, applies a pending destination, and views a browser placement's tab in main. */
  activateSurface: (handleId: string, id: string) => void
  /** View fields of a non-browser tab. A viewState whose kind isn't the tab's is refused. */
  setSurfaceView: (handleId: string, id: string, patch: SurfaceViewPatch) => void
  /** Stop and reset act on every tab and Stop also interrupts the running turn; the others act on the viewed tab. */
  browserDrive: (action: 'stop' | 'handback' | 'takeover' | 'reset') => Promise<void>
  /** Activates the tab's placement at once; main shows its page, reloading it if it was suspended. */
  viewBrowserTab: (tab: number) => void
  /** Main appends and views the new tab, and its tab-opened event puts it in the strip, active. */
  newBrowserTab: () => Promise<void>
}

export type SurfaceSpec = Pick<SurfaceTab, 'kind' | 'key' | 'title'> &
  Partial<Pick<SurfaceTab, 'mode' | 'location' | 'highlight' | 'provenance'>>
export type SurfaceViewPatch = Partial<Pick<SurfaceTab, 'mode' | 'location' | 'selection' | 'highlight' | 'viewState' | 'sourceView' | 'reveal' | 'back'>>

/**
 * The effort ceiling the CLI will enforce for a model, or undefined when none is set. A
 * per-model `modelSettings[id]` cap outranks the top-level one. Reads the current
 * `effortCaps` snapshot; a component using this in render should also subscribe to
 * `effortCaps` so a startup / session-start load triggers a re-render.
 */
export function effortCap(modelId: ModelChoice): EffortChoice | undefined {
  const { maxEffortLevel, modelSettings } = useSession.getState().effortCaps
  return modelSettings?.[modelId]?.maxEffortLevel ?? maxEffortLevel
}

/** The active session's slice, or null when nothing is open. */
export function activeSlice(store: SessionStore): PerSessionState | null {
  return store.activeHandleId ? (store.sessions[store.activeHandleId] ?? null) : null
}

/** The permission mode in effect. The CLI can run a pick as something else without saying so
 *  (auto on a model that can't run it starts as default), so its reported mode outranks the pick
 *  when they disagree. Under 'inherit' the reported mode is what settings.json or a resumed plan
 *  resolved to, so it's inherited, not a downgrade. A reported mode the picker doesn't know
 *  falls back to the pick. */
export function effectiveMode(
  s: Pick<PerSessionState, 'modelMode' | 'modeChoice' | 'permissionMode'>
): { mode: PermissionModeChoice; downgraded: boolean; inherited: boolean } {
  if (s.modelMode) return { mode: s.modelMode, downgraded: false, inherited: s.modeChoice === 'inherit' }
  const reported = s.permissionMode
  if (reported && reported !== s.modeChoice && reported in PERMISSION_MODE_LABELS)
    return s.modeChoice === 'inherit'
      ? { mode: reported as PermissionModeChoice, downgraded: false, inherited: true }
      : { mode: reported as PermissionModeChoice, downgraded: true, inherited: false }
  return { mode: s.modeChoice, downgraded: false, inherited: false }
}

/** What the composer chip shows for the mode in effect. System Default isn't a mode, so when the
 *  session resolved to one Clui doesn't know the chip names it as written (`raw`), and with nothing
 *  reported yet (the settings read failed) it reads Interactive, which is what an unset default runs as. */
export function chipMode(mode: PermissionModeChoice, reported: string | null): { mode: PermissionModeChoice; raw: string | null } {
  if (mode !== 'inherit') return { mode, raw: null }
  return reported ? { mode, raw: reported } : { mode: 'default', raw: null }
}

/** The session's shown title: its explicit/branch name, else the first user message
 *  (truncated), else 'Untitled'. One derivation so the footer and the sidebar row can't drift. */
export function sessionDisplayTitle(slice: Pick<PerSessionState, 'title' | 'messages'> | null): string {
  if (!slice) return 'Untitled'
  const firstUser = messageGist(slice.messages.find((m) => m.role === 'user')?.text ?? '').trim()
  return slice.title ?? (firstUser ? firstUser.slice(0, 80) : 'Untitled')
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
  if (!cur) return {}
  let next = { ...cur, ...patch }
  if (next.browser !== cur.browser) next = placeBrowser(next)
  if (next.restoreNote && next.surfaces.order.length) next = { ...next, restoreNote: null }
  return { sessions: { ...s.sessions, [handleId]: next } }
}

export const EMPTY_SURFACES: SurfaceSet = { order: [], active: null, tabs: {}, browserLastViewedAt: {}, browserUnseen: {} }

/** How long after the user last touched the pane a Claude focus request waits in the background. */
export const PANE_RECENT_MS = 10_000
let paneInputAt = 0
/** Input in the pane: the renderer's own, or genuine input in its native page that main forwards. */
export function notePaneInput(at = Date.now()): void {
  paneInputAt = at
}

export const placement = (tab: number): string => `browser:${tab}`

/** The browser tab a placement id names, else null. */
export function browserTabOf(id: string | null | undefined): number | null {
  return id?.startsWith('browser:') ? Number(id.slice(8)) : null
}

export function surfaceKindOf(set: SurfaceSet, id: string | null): SurfaceKind | null {
  if (!id) return null
  return browserTabOf(id) !== null ? 'browser' : (set.tabs[id]?.kind ?? null)
}

/** The placement of main's viewed tab, else the last browser placement in the strip. */
export function browserTargetOf(s: PerSessionState): string | null {
  const b = s.browser
  if (!b) return null
  if (b.tabs.some((t) => t.id === b.viewed)) return placement(b.viewed)
  return s.surfaces.order.findLast((id) => browserTabOf(id) !== null) ?? null
}

/** What the band's toggle shows or would show. A tab Claude drives wins while the pane is hidden, so the
 *  toggle's dot, glyph and click agree. */
export function paneTarget(s: PerSessionState): string | null {
  if (s.paneOpen) return s.surfaces.active
  const b = s.browser
  const used = b ? Object.values(b.toolTabs) : []
  const driving = b?.tabs.filter((t) => t.drive === 'driving').map((t) => t.id) ?? []
  const recent = used.findLast((n) => driving.includes(n)) ?? driving[0]
  return recent !== undefined ? placement(recent) : (s.surfaces.active ?? browserTargetOf(s))
}

/** The nearest survivor in `now` to where `id` sat in `was`, right first, then left. */
function neighbourOf(was: string[], id: string, now: string[]): string | null {
  const i = was.indexOf(id)
  return was.slice(i + 1).find((x) => now.includes(x)) ?? was.slice(0, Math.max(0, i)).findLast((x) => now.includes(x)) ?? null
}

const without = <T>(rec: Record<string, T>, keep: (id: string) => boolean): Record<string, T> => {
  const ids = Object.keys(rec)
  return ids.every(keep) ? rec : Object.fromEntries(ids.filter(keep).map((id) => [id, rec[id]]))
}

/**
 * Keeps the browser placements in step with `browser`, in the same update: every tab has one, a closed
 * tab's goes, and an active placement that went hands over to its neighbour. An active browser
 * placement follows main's viewed tab. With nothing left to show the pane stays open on the picker.
 */
function placeBrowser<T extends Pick<PerSessionState, 'surfaces' | 'browser'>>(slice: T): T {
  const set = slice.surfaces
  const b = slice.browser
  const live = b ? b.tabs.map((t) => placement(t.id)) : []
  const kept = set.order.filter((id) => browserTabOf(id) === null || live.includes(id))
  const added = live.filter((id) => !set.order.includes(id))
  const order = kept.length === set.order.length && !added.length ? set.order : [...kept, ...added]
  let active = set.active && !order.includes(set.active) ? neighbourOf(set.order, set.active, order) : set.active
  const viewed = b && b.tabs.some((t) => t.id === b.viewed) ? placement(b.viewed) : null
  if (viewed && browserTabOf(active) !== null) active = viewed
  const surfaces =
    order === set.order && active === set.active
      ? set
      : {
          ...set,
          order,
          active,
          browserUnseen: without(set.browserUnseen, (id) => order.includes(id) && id !== active),
          browserLastViewedAt: without(set.browserLastViewedAt, (id) => order.includes(id))
        }
  return surfaces === set ? slice : { ...slice, surfaces }
}

/** The slice fields that make `id` the active tab: unseen cleared, a pending destination applied, and
 *  a browser placement's tab viewed. The caller asks main to view that tab. The tree taking over from a
 *  file in the cwd reveals that file, unless Claude sent it somewhere. */
function activation(slice: PerSessionState, id: string, now: number, located = false): Partial<PerSessionState> {
  const set = slice.surfaces
  const tab = browserTabOf(id)
  if (tab !== null) {
    const { [id]: _seen, ...unseen } = set.browserUnseen
    return {
      surfaces: { ...set, active: id, browserUnseen: unseen, browserLastViewedAt: { ...set.browserLastViewedAt, [id]: now } },
      ...(slice.browser && slice.browser.viewed !== tab ? { browser: { ...slice.browser, viewed: tab } } : {})
    }
  }
  const cur = set.tabs[id]
  const { pendingShow, unseen, reveal: _r, ...rest } = cur
  const from = set.active ? set.tabs[set.active] : undefined
  // An unseen tree holds a destination Claude placed behind; that wins like a pending or just-sent one.
  const sent = located || !!pendingShow?.location || !!unseen
  const reveal = cur.kind === 'tree' && from?.kind === 'file' && !!slice.cwd && from.key.startsWith(`${slice.cwd}/`) && !sent ? from.key : null
  const next: SurfaceTab = { ...rest, ...pendingShow, ...(reveal ? { reveal } : {}), lastViewedAt: now }
  return { surfaces: { ...set, active: id, tabs: { ...set.tabs, [id]: next } } }
}

/** A tab's visible label in the strip. */
export function surfaceLabel(t: SurfaceTab): string {
  switch (t.kind) {
    case 'diff':
      return 'Claude changes'
    case 'tree':
      return t.title
    case 'file':
    case 'image':
    case 'doc':
    case 'sheet':
    case 'artifact':
      return basename(t.key)
    default: {
      const none: never = t.kind
      return none
    }
  }
}

/** The tab came back from the sidecar rather than being opened in this slice. */
export const restoredTab = (slice: Pick<PerSessionState, 'createdMs'> | null, tab: Pick<SurfaceTab, 'openedAt'>): boolean =>
  !!slice && tab.openedAt < slice.createdMs

/** The tab the cap closes to make room for `keep`: the inactive one viewed least recently. Tree and
 *  Claude changes are never closed. */
export function evictionVictim(set: SurfaceSet, keep: string): string | null {
  const tabs = Object.values(set.tabs)
  if (tabs.length < SURFACE_TAB_CAP) return null
  let pick: SurfaceTab | null = null
  for (const t of tabs) {
    if (t.kind === 'tree' || t.kind === 'diff' || t.id === set.active || t.id === keep) continue
    if (!pick || t.lastViewedAt < pick.lastViewedAt) pick = t
  }
  return pick?.id ?? null
}

function savedTab(t: SurfaceTab): SavedTab {
  const { id, kind, key, title, openedBy, mode, viewState, sourceView, openedAt, lastViewedAt, provenance } = t
  return { id, kind, key, title, openedBy, mode, viewState, sourceView, openedAt, lastViewedAt, provenance }
}

const surfacesSave = (s: PerSessionState): SurfacesSave => ({
  set: { order: s.surfaces.order, active: s.surfaces.active, tabs: Object.fromEntries(Object.entries(s.surfaces.tabs).map(([id, t]) => [id, savedTab(t)])) },
  open: s.paneOpen,
  full: s.surfacePaneFull
})

/**
 * A new or resumed slice's pane, from what the sidecar kept. Main has already restored the browser tabs
 * with their saved ids, so the placements follow them, and without browser access they drop out. Nothing
 * here counts as a change, so the first save waits for one.
 */
export function restoredPane(restore: SurfacesRestore, browser: boolean): Pick<PerSessionState, 'browser' | 'surfaces' | 'paneOpen' | 'surfacePaneFull' | 'restoreNote'> {
  const tabs = !browser ? null : restore.status === 'ok' && restore.entry.browserTabs ? restore.entry.browserTabs : { tabs: [], nextId: 1, viewed: 1 }
  const b: BrowserTabs | null = tabs && {
    tabs: tabs.tabs.map((t) => ({ ...BLANK_BROWSER, id: t.id, url: t.url })),
    viewed: tabs.viewed,
    multi: tabs.nextId > 2,
    toolTabs: {},
    enter: [],
    announce: ''
  }
  if (restore.status !== 'ok') {
    return {
      browser: b,
      surfaces: EMPTY_SURFACES,
      paneOpen: false,
      surfacePaneFull: false,
      restoreNote: restore.status === 'none' ? null : restore.status
    }
  }
  const { set, open, full } = restore.entry
  const lastViewed = Object.fromEntries((tabs?.tabs ?? []).map((t) => [placement(t.id), t.lastViewedAt]))
  const surfaces: SurfaceSet = { order: set.order, active: set.active, tabs: set.tabs, browserLastViewedAt: lastViewed, browserUnseen: {} }
  return { ...placeBrowser({ browser: b, surfaces }), paneOpen: open, surfacePaneFull: full, restoreNote: null }
}

/** Focus sits in the pane, where a switch Claude asked for would unmount it. A renderer without focus
 *  over a browser tab has handed it to the native page. */
const focusInPane = (onBrowser: boolean): boolean =>
  typeof document !== 'undefined' &&
  (!!document.activeElement?.closest('[data-ui="pane-secondary"]') || (onBrowser && !document.hasFocus()))

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

/** The session's pane is open, at half or full. */
export const selectPaneOpen = (s: PerSessionState | null): boolean => !!s?.paneOpen
export const EMPTY_TABS: TabState[] = []

/** The tab whose page the pane shows. */
export function viewedTabOf(b: BrowserTabs | null | undefined): TabState | null {
  return b?.tabs.find((t) => t.id === b.viewed) ?? null
}

/** Any tab of the session's browser is in one of `drives`. */
export function anyTabIn(b: BrowserTabs | null | undefined, ...drives: BrowserState['drive'][]): boolean {
  return !!b?.tabs.some((t) => drives.includes(t.drive))
}
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
const EMPTY_MOD_STATUS: ModStatusLine[] = []
/** Stable empty ref for a session's staged draft attachments (zustand-v5 selector safety). */
export const EMPTY_ATTACHMENTS: ProcessedAttachment[] = []

/** Stable empty ref for a session's Claude changes (zustand-v5 selector safety). */
export const EMPTY_CHANGES: FileChangeSummary[] = []

/** Latest Git status request per handle. */
const gitGen = new Map<string, number>()
const sameGit = (a: GitPathStatus | undefined, b: GitPathStatus): boolean => !!a && JSON.stringify(a) === JSON.stringify(b)

const EMPTY_WOKEN: WokenTask[] = []
const EMPTY_MONITORS: Record<string, MonitorRecord> = {}
const EMPTY_CHECKING: Record<string, true> = {}

function withoutKey<T>(rec: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = rec
  return rest
}

/** Each session's one pending timer for its usage limit's reset, replaced by every new limit event. */
const rateLimitTimers = new Map<string, ReturnType<typeof setTimeout>>()

// --- One persistent event subscription (installed lazily on first use) ---

let subscribed = false
/**
 * Events that arrived for a handle whose slice does not exist yet, in the tiny
 * window between `startSession` spawning (main assigns the handle) and the store
 * inserting the slice. Buffered by handleId, flushed when the slice lands, so no
 * `session-init` is ever dropped (closes the pre-handleId race).
 */
const earlyBuffer = new Map<string, DomainEvent[]>()
/** Max events buffered for one not-yet-inserted handle, so a start that never completes
 *  can't grow without bound. */
const EARLY_BUFFER_CAP = 500
/** Handles whose slice was deleted (closed/evicted/failed). Their late stream events are
 *  discarded rather than buffered forever waiting for an insertSlice that will never come.
 *  Handle ids are fresh uuids, never reused, so this only grows on churn;
 *  bounded below. */
const retiredHandles = new Set<string>()
const RETIRED_CAP = 1000

/** Tombstone a deleted handle: drop any buffered events for it and remember it as retired
 *  so future late events are discarded. */
function retireHandle(handleId: string): void {
  earlyBuffer.delete(handleId)
  retiredHandles.add(handleId)
  if (retiredHandles.size > RETIRED_CAP) {
    const oldest = retiredHandles.values().next().value
    if (oldest !== undefined) retiredHandles.delete(oldest)
  }
}

/** A rename typed on a LIVE-but-busy session, held until its turn ends so the `/rename`
 *  suppress window can't swallow a real turn's result. */
const pendingLiveRename = new Map<string, string>()

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
  { model?: ModelChoice; effort?: EffortChoice; ultracode?: boolean; contextWindow?: number }
>()

/** Remember a session's model/effort/ultracode (in-memory + sidecar). Merges fields. */
function rememberModelPrefs(
  sessionId: string,
  prefs: { model?: ModelChoice; effort?: EffortChoice; ultracode?: boolean; contextWindow?: number }
): void {
  if (!sessionId) return
  const cur = modelPrefsBySessionId.get(sessionId) ?? {}
  const next = {
    model: prefs.model ?? cur.model,
    effort: prefs.effort ?? cur.effort,
    ultracode: prefs.ultracode ?? cur.ultracode,
    contextWindow: prefs.contextWindow ?? cur.contextWindow
  }
  modelPrefsBySessionId.set(sessionId, next)
  void window.clui.setSessionModel(sessionId, next)
}

/** Drop a session's remembered model/effort (call on permanent delete) so the
 *  model-prefs sidecar doesn't accumulate dead entries. */
export function forgetSessionModel(sessionId: string): void {
  modelPrefsBySessionId.delete(sessionId)
  void window.clui.deleteSessionModel(sessionId)
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
          modelPrefsBySessionId.set(sid, { model: prefs.model, effort, ultracode: prefs.ultracode, contextWindow: prefs.contextWindow })
        }
      } catch {
        // best-effort: resume just falls back to the Settings default model/effort
      }
    })()
  }
  return modelPrefsLoaded
}

/** A session's pane saves at most this often. */
const SAVE_MS = 500
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Sends a session's pending save now. `sync` blocks until main has it, for the window's unload. */
function flushSurfaces(handleId: string, sync = false): void {
  const t = saveTimers.get(handleId)
  if (!t) return
  clearTimeout(t)
  saveTimers.delete(handleId)
  const slice = useSession.getState().sessions[handleId]
  if (!slice) return
  if (sync) window.clui.saveSurfacesSync(handleId, surfacesSave(slice))
  else void window.clui.saveSurfaces(handleId, surfacesSave(slice))
}

/** A slice saves only once something in its pane changes after it was created, restored state included. */
function watchSurfaces(): void {
  useSession.subscribe((s, prev) => {
    if (s.sessions === prev.sessions) return
    for (const [handleId, slice] of Object.entries(s.sessions)) {
      const was = prev.sessions[handleId]
      if (!was || was === slice || saveTimers.has(handleId)) continue
      if (slice.surfaces === was.surfaces && slice.paneOpen === was.paneOpen && slice.surfacePaneFull === was.surfacePaneFull && slice.browser?.tabs === was.browser?.tabs) continue
      saveTimers.set(handleId, setTimeout(() => flushSurfaces(handleId), SAVE_MS))
    }
  })
  window.addEventListener('beforeunload', () => {
    for (const handleId of [...saveTimers.keys()]) flushSurfaces(handleId, true)
  })
}

/** A session that can't read changes drops the change refs it holds, however `changeRead` got there. */
function watchChangeRead(): void {
  useSession.subscribe((s, prev) => {
    if (s.sessions === prev.sessions) return
    for (const [handleId, slice] of Object.entries(s.sessions)) {
      if (slice.changeRead !== false || prev.sessions[handleId]?.changeRead === false) continue
      queueMicrotask(() => useSession.getState().invalidateSource(handleId, CHANGE_REFS, { reason: 'denied' }))
    }
  })
}

/** A mint answered `denied` before the session's init said so. */
export function denyChangeRead(handleId: string): void {
  useSession.setState((s) => (s.sessions[handleId]?.changeRead === false ? {} : patchSlice(s, handleId, { changeRead: false })))
}

const hidden = (): boolean => typeof document !== 'undefined' && document.hidden

/** What the pane shows a session, as surface_state reports it. Lines and labels only, never selected text. */
export function paneFacts(handleId: string): SurfaceReply {
  const st = useSession.getState()
  const slice = st.sessions[handleId]
  if (!slice) return { outcome: 'unavailable' }
  const set0 = slice.surfaces
  const span = (l: { start: number; end: number } | undefined) => l && { start: l.start, end: l.end }
  const fact = (id: string): TabFact | null => {
    const tab = browserTabOf(id)
    if (tab !== null) return slice.browser ? { kind: 'browser', tab, claude: false, unseen: !!set0.browserUnseen[id] } : null
    const t = set0.tabs[id]
    if (!t) return null
    const at = t.location
    const pend = t.pendingShow?.location
    const sel = span(t.selection?.lines)
    const hl = span(t.highlight?.lines)
    return {
      kind: t.kind,
      ...(t.kind === 'diff' ? { files: slice.changes.length } : { path: t.kind === 'tree' ? (at?.file ?? slice.cwd) : t.key }),
      claude: t.openedBy === 'claude',
      unseen: !!t.unseen,
      ...(t.kind !== 'tree' && at?.line ? { location: { line: at.line, ...(at.endLine ? { endLine: at.endLine } : {}) } } : {}),
      ...(sel ? { selection: sel } : {}),
      ...(hl ? { highlight: hl } : {}),
      ...(pend ? { pending: { ...(pend.line ? { line: pend.line } : {}), ...(pend.endLine ? { endLine: pend.endLine } : {}) } } : {})
    }
  }
  const seen = (id: string): number => (browserTabOf(id) !== null ? (set0.browserLastViewedAt[id] ?? 0) : (set0.tabs[id]?.lastViewedAt ?? 0))
  const active = set0.active ? fact(set0.active) : null
  const rest = set0.order
    .filter((id) => id !== set0.active)
    .sort((a, b) => seen(b) - seen(a))
    .flatMap((id) => fact(id) ?? [])
  const session =
    handleId !== st.activeHandleId ? 'background' : hidden() ? 'minimized' : st.viewingSubagent || st.settingsSection !== null || slice.pendingPermissions.length ? 'covered' : 'shown'
  return {
    pane: slice.paneOpen ? 'open' : 'closed',
    ...(slice.paneOpen ? { width: slice.surfacePaneFull || !st.stageWide ? 'wide' : 'half' } : {}),
    session,
    ...(active ? { active } : {}),
    tabs: rest.slice(0, 11),
    omitted: Math.max(0, rest.length - 11)
  }
}

/** Claude's surface_open, through the same intent rules as every other open. Main has authorized the target. */
export function openForClaude(handleId: string, a: SurfaceTarget & { focus: boolean }): SurfaceReply {
  const st = useSession.getState()
  const slice = st.sessions[handleId]
  if (!slice) return { outcome: 'unavailable' }
  const lines = a.kind === 'file' && a.line ? { start: a.line, end: a.endLine ?? a.line } : null
  const spec =
    a.kind === 'browser'
      ? { kind: a.kind, tab: a.tab }
      : a.kind === 'file'
        ? { kind: a.kind, key: a.path, title: basename(a.path), ...(lines ? { location: { line: lines.start, ...(a.endLine ? { endLine: a.endLine } : {}) }, highlight: { lines } } : {}) }
        : a.kind === 'tree'
          ? { kind: a.kind, key: '', title: basename(slice.cwd), location: { file: a.path } }
          : { kind: a.kind, key: '', title: 'Claude changes', ...(a.path ? { location: { file: a.path } } : {}) }
  const id = st.openSurface(handleId, spec, a.focus ? 'focus' : 'prepare', 'claude', 'claude')
  const now = useSession.getState()
  const after = now.sessions[handleId]
  if (!after) return { outcome: 'unavailable' }
  if (!after.paneOpen && after.paneAutoOpenSuppressed && after.surfaces.active === id) return { outcome: 'pane-closed' }
  const visible = handleId === now.activeHandleId && !hidden()
  const shown =
    visible && after.paneOpen && !now.viewingSubagent && now.settingsSection === null && after.surfaces.active === id && !after.surfaces.tabs[id]?.pendingShow
  return { outcome: shown ? 'shown' : a.focus && !visible ? 'deferred' : 'prepared' }
}

const answered = new Set<string>()
/** Applies each command at most once and refuses one main has already given up on. */
export function answerSurface(cmd: SurfaceCommand): void {
  if (answered.has(cmd.reqId) || Date.now() > cmd.expiresAt) return
  answered.add(cmd.reqId)
  if (answered.size > 256) answered.delete(answered.values().next().value as string)
  void window.clui.surfaceReply(cmd.reqId, cmd.op === 'state' ? paneFacts(cmd.handleId) : openForClaude(cmd.handleId, cmd.args))
}

function ensureSubscribed(applyEvent: (handleId: string, e: DomainEvent) => void): void {
  if (subscribed) return
  subscribed = true
  watchSurfaces()
  watchChangeRead()
  window.clui.onSurfaceCommand(answerSurface)
  window.clui.onSessionEvent(({ handleId, event }) => {
    applyEvent(handleId, event)
    // A turn can delete a changed file without a tool result naming it (Bash rm), so its
    // end re-checks which files are still on disk.
    if (event.type === 'result') void useSession.getState().refreshChanges(handleId)
  })
  window.clui.onRefSourceChanged(({ handleId, path, reason, version }) => {
    useSession.getState().invalidateSource(handleId, `file:${path}`, { reason, ...(version ? { version } : {}) })
  })
  window.clui.onChangesEvent(({ handleId, summaries }) => {
    const prev = useSession.getState().sessions[handleId]
    useSession.setState((s) => patchSlice(s, handleId, { changes: summaries }))
    if (prev) prepareChanges(handleId, prev, summaries)
  })
}

/** Claude's edits mark the Claude changes tab without moving the view or focus. The tab opens next on the first file
 *  changed while it was unseen. History replayed on a resume isn't news, so an update with nothing before it counts
 *  only mid-turn. */
function prepareChanges(handleId: string, prev: PerSessionState, next: FileChangeSummary[]): void {
  if (prev.changes === EMPTY_CHANGES && !prev.busy) return
  const before = new Map(prev.changes.map((c) => [c.path, c.editIds.length]))
  const fresh = next.find((c) => (before.get(c.path) ?? 0) < c.editIds.length)
  const st = useSession.getState()
  // An HTML page Claude creates is its artifact, a tab of its own beside the Claude changes entry.
  for (const c of next) {
    if (before.has(c.path) || !c.created || !isHtml(c.path) || !c.editIds[0] || !prev.sessionId) continue
    const provenance = { sessionId: prev.sessionId, creatingEditId: c.editIds[0] }
    st.openSurface(handleId, { kind: 'artifact', key: c.path, title: basename(c.path), provenance }, 'prepare', 'claude', 'change')
  }
  const set0 = st.sessions[handleId]?.surfaces
  if (!fresh || !set0 || set0.active === 'diff' || set0.tabs.diff?.unseen) return
  st.openSurface(handleId, { kind: 'diff', key: '', title: 'Claude changes', location: { file: fresh.path } }, 'prepare', 'claude', 'change')
  // With no tab to show, a hidden pane's toggle targets the new tab; it stays unseen until the pane is shown on it.
  const cur = useSession.getState().sessions[handleId]
  const shown = cur.paneOpen && !(handleId === st.activeHandleId && st.viewingSubagent)
  if (set0.active === null && !shown) useSession.setState((s) => patchSlice(s, handleId, { surfaces: { ...s.sessions[handleId].surfaces, active: 'diff' } }))
}

/** Insert a freshly-created slice and flush any events that raced ahead of it. */
function insertSlice(
  set: (fn: (s: SessionStore) => Partial<SessionStore>) => void,
  applyEvent: (handleId: string, e: DomainEvent) => void,
  slice: PerSessionState
): void {
  set((s) => {
    const sessions = { ...s.sessions, [slice.handleId]: slice }
    return {
      sessions,
      // A pane restored open mounts without taking focus.
      ...arriveWithPane(sessions, slice.handleId, s.stageWide, surfacePaneShown(s)),
      activeHandleId: slice.handleId,
      // A new/resumed session becomes active, so any open detail view (scoped to the
      // previously-active session's tool ids) must close.
      viewingSubagent: null,
      subagentTrail: []
    }
  })
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
    /** Quick session: spawn with `--no-session-persistence` (no on-disk transcript). */
    ephemeral?: boolean
  }
): Promise<void> {
  ensureSubscribed(get().applyEvent)
  evictIfOverCap(get, set, opts.cwd)
  // Refresh the effort caps at each session start so a settings.json edit is reflected.
  void get().loadEffortCaps()

  // Resolve per-session choices: explicit arg, else the global Settings default.
  // These are seeded ONCE here (a brand-new/resumed session); re-activating an
  // already-live session never re-seeds them, so per-session picks stick.
  const { values: settings } = await window.clui.getSettings()
  // A Quick session runs a fixed profile (resolved once, here): the configured quick permission
  // mode instead of the normal per-session/default one.
  const choice = opts.ephemeral ? settings.quickPermissionMode : (opts.permissionMode ?? settings.permissionMode)
  // System Default shows as the mode settings.json resolves to from the start. The CLI's init has
  // the final word, since a project's settings or a managed policy can set their own.
  let seededMode: string | null = null
  if (choice === 'inherit') {
    const cached = get().systemPermissionMode
    const system = cached === undefined ? await get().refreshSystemPermissionMode() : cached
    // Unset means Interactive. A mode Clui doesn't know is kept as written, so the chip can name it.
    seededMode = system === null ? 'default' : system
  }
  // On RESUME, restore the session's last-used model/effort from the sidecar (the CLI
  // reverts to the settings.json default on --resume, so a mid-session switch would
  // otherwise be lost). Fresh sessions use the Settings default. `remembered` is only
  // consulted for a resume with a known sessionId. Await the sidecar load first: it's
  // warmed fire-and-forget at startup, so a resume-click before that lands would read
  // an empty map and revert to the default.
  if (opts.resumeSessionId) await ensureModelPrefsLoaded()
  const remembered = opts.resumeSessionId ? modelPrefsBySessionId.get(opts.resumeSessionId) : undefined
  let modelChoice = opts.model ?? remembered?.model ?? settings.model
  let effortChoice = opts.effort ?? remembered?.effort ?? settings.effort
  // Quick profile: the latest live model of the configured family (never a hardcoded id) at
  // locked high effort. No effort UI in the ephemeral composer, so seeding it here IS the lock.
  if (opts.ephemeral) {
    const { ids } = await window.clui.listModels()
    modelChoice = latestModelInFamily(settings.quickModelFamily, ids.map(deriveModelInfo)) ?? modelChoice
    effortChoice = 'high'
  }
  // Ultracode is off by default on a fresh session; restored from the sidecar on resume.
  const ultracode = remembered?.ultracode ?? false
  // Cache the available model ids so session-init can reconcile the picker to the
  // CLI's actually-running model (best-effort; empty on failure → reconcile falls
  // back to the reported id).
  void window.clui.listModels().then(({ ids }) => { if (ids.length) knownModelIds = ids })

  // On resume, reconstruct prior history from the transcript so it renders in the
  // chat, then continue streaming new turns on top. Best-effort / display-only.
  // Seed a resumed session's cost from its transcript scan (the CLI persists cumulative
  // cost per turn as a cost-state record, carried across --resume). The live max-replace
  // on result events corrects it once a new turn completes.
  const resumedCostUsd = opts.resumeSessionId
    ? (get().sessionGroups.flatMap((g) => g.sessions).find((s) => s.id === opts.resumeSessionId)?.costUsd ?? null)
    : null

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
        compaction: m.compaction,
        blocked: m.blocked,
        usage: m.usage,
        // A turn read back from disk is over, so a new turn's text never extends it.
        turnEnd: m.role === 'assistant' ? { durationMs: m.durationMs } : undefined,
        text: m.text,
        thinking: m.thinking,
        tools: m.tools.map((tc) => ({ ...tc })),
        // Rebuilt-from-disk: no ordered blocks → MessageView falls back to the
        // text-then-tools layout (ordering within a resumed turn isn't preserved
        // in the transcript, and it's display-only history anyway).
        blocks: [],
        // Drop-file: recovered attachments render in the user bubble. Images show as
        // thumbnails (the recovered data-URL is the preview), document/text as
        // metadata chips (name + size; bytes not re-inlined into the store on resume),
        // and an unrecoverable image as an "Image not available" note.
        attachments: m.attachments?.length
          ? m.attachments.map((a): MessageAttachment => (a.kind === 'image' ? { kind: 'image', previewUrl: a.dataUrl, blockIndex: a.blockIndex } : a))
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
  const seededWindow = remembered?.contextWindow ?? contextWindowForModel(modelChoice)
  const seededTokens = resumedContextTokens
  const seededPercent =
    seededTokens != null ? Math.min(100, Math.round((seededTokens / seededWindow) * 100)) : null

  // Pass model/effort explicitly. On resume these are the REMEMBERED per-session
  // values (from the sidecar). Verified: --model/--effort ARE honored on a --resume
  // spawn, and the CLI otherwise reverts to the settings.json default (dropping the
  // user's mid-session switch). On a fresh session they're the Settings default.
  const { handleId, browser, surfaces } = await window.clui.startSession({
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
    // A hard-titled resume passes its name here, so the footer title agrees with the
    // sidebar (and the re-asserted `-n`) instead of falling back to the first message.
    title: opts.name ?? null,
    cwd: opts.cwd,
    model: null,
    permissionMode: seededMode,
    modeChoice: choice,
    modelMode: null,
    modelChoice,
    effortChoice,
    ultracode,
    contextPercent: seededPercent,
    contextTokens: seededTokens,
    contextWindow: seededTokens != null ? seededWindow : null,
    compactDismissedAtRunway: null,
    costUsd: resumedCostUsd,
    resumed: Boolean(opts.resumeSessionId),
    ephemeral: Boolean(opts.ephemeral),
    historyCount: history.length,
    busy: false,
    interrupting: false,
    turnStartMs: null,
    thinkingTokens: null,
    compacting: false,
    statusAnnounce: '',
    messages: history,
    queuedMessages: EMPTY_QUEUED,
    draftText: '',
    draftAttachments: EMPTY_ATTACHMENTS,
    pendingPermissions: [],
    changes: EMPTY_CHANGES,
    backgroundTasks: {},
    modStatus: EMPTY_MOD_STATUS,
    subagentMessages: {},
    subagentChildren: {},
    workflows: {},
    monitors: EMPTY_MONITORS,
    slashCommands: EMPTY_SLASH_COMMANDS,
    tasks: EMPTY_TASKS,
    lastError: null,
    apiRetry: null,
    apiRetryDismissed: false,
    apiRetryAnnounce: '',
    checkingTools: EMPTY_CHECKING,
    rateLimit: null,
    rateLimitDismissed: false,
    rateLimitAnnounce: '',
    turnTasks: EMPTY_STRINGS,
    endedTasks: EMPTY_WOKEN,
    exited: false,
    createdMs: now,
    lastActivityMs: now,
    ...restoredPane(surfaces, browser),
    paneAutoOpen: false,
    paneAutoOpenSuppressed: false,
    tabsEvicted: false,
    annotate: IDLE_ANNOTATE,
    contextRefs: EMPTY_REFS,
    referenceNotices: EMPTY_NOTICES,
    changeRead: null,
    referenceEditTarget: null,
    refAnnounce: ''
  })
  // Main rebuilds a resume's changes from its transcripts. A push that lands before the slice
  // exists is dropped, so pull once the slice is in.
  if (opts.resumeSessionId) void get().refreshChanges(handleId)
}

/** In-flight resume ids: a reservation so two concurrent resumes of the SAME durable
 *  session can't both spawn a second writer for one conversation. */
const resumingIds = new Set<string>()
/** Monotonic session-list refresh token: a slow scan that finishes after a newer one
 *  started is dropped, so it can't overwrite fresher rename/delete state. */
let refreshGen = 0

/** A session is doing live work (not evictable) if a turn is streaming, a message is
 *  queued, a permission is pending, or a background task / workflow is still running.
 *  `!busy` alone reads a session with a running background agent as idle. */
function hasLiveWork(s: PerSessionState): boolean {
  return (
    s.busy ||
    s.queuedMessages.length > 0 ||
    s.pendingPermissions.length > 0 ||
    Object.values(s.backgroundTasks).some((t) => t.status === 'running') ||
    Object.values(s.workflows).some((w) => w.endedStatus === null)
  )
}

/**
 * Enforce the live-process cap before opening a new session. Evicts the
 * least-recently-active session with NO live work; if none is evictable, leaves the
 * count over-cap and surfaces a notice. Exited slices hold no process, so they don't
 * count toward the cap.
 */
function evictIfOverCap(
  get: () => SessionStore,
  set: (fn: (s: SessionStore) => Partial<SessionStore>) => void,
  newCwd: string
): void {
  const { sessions, activeHandleId } = get()
  const live = Object.values(sessions).filter((s) => !s.exited)
  if (live.length < LIVE_SESSION_CAP) return

  const candidates = live
    .filter((s) => s.handleId !== activeHandleId && !hasLiveWork(s))
    .sort((a, b) => a.lastActivityMs - b.lastActivityMs)
  const victim = candidates[0]

  if (!victim) {
    set(() => ({
      notice: {
        message: 'All live sessions are working. Finish or close one to free memory.',
        tone: 'warn'
      }
    }))
    return
  }

  const label = victim.messages.find((m) => m.role === 'user')?.text.slice(0, 40) || 'a session'
  flushSurfaces(victim.handleId)
  void window.clui.stopSession(victim.handleId)
  retireHandle(victim.handleId)
  set((s) => {
    const next = { ...s.sessions }
    delete next[victim.handleId]
    return {
      sessions: next,
      notice: {
        message: `Closed background session (${label}) to stay under ${LIVE_SESSION_CAP} live sessions in ${basename(newCwd)}.`,
        tone: 'warn'
      }
    }
  })
}

/** A tab's page before anything has loaded. Main opens tab 1 with every browser session and doesn't
 *  report it, so the renderer seeds it. Its view is created the first time the pane opens. */
const BLANK_BROWSER: BrowserState = {
  url: 'about:blank',
  title: '',
  loading: false,
  canBack: false,
  canForward: false,
  drive: 'idle',
  suspended: false,
  still: null,
  loginWall: null,
  netAsk: null,
  loadError: null
}

/** How long an undo card stays up, and so how long Reopen can bring back an evicted tab. */
export const UNDO_MS = 5000
let evictSeq = 0

/**
 * Makes room under the tab cap before `keep` opens. The first eviction in a session gets a card that
 * can reopen the tab; later ones are only announced, so opening 40 files doesn't bury the stack.
 */
function evictFor(
  get: () => SessionStore,
  set: (fn: (s: SessionStore) => Partial<SessionStore>) => void,
  handleId: string,
  keep: string
): void {
  const cur = get().sessions[handleId]
  const victim = cur && evictionVictim(cur.surfaces, keep)
  if (!cur || !victim) return
  const set0 = cur.surfaces
  const { [victim]: tab, ...tabs } = set0.tabs
  const surfaces = { ...set0, order: set0.order.filter((x) => x !== victim), tabs }
  const label = surfaceLabel(tab)
  if (cur.tabsEvicted) {
    set((s) => patchSlice(s, handleId, { surfaces, statusAnnounce: toggled(`Closed ${label} to stay under ${SURFACE_TAB_CAP} tabs.`) }))
    return
  }
  const at = Date.now()
  const card: EvictedTab = { id: `evicted-${++evictSeq}`, handleId, tab, index: set0.order.indexOf(victim), at }
  const text = toggled(`Closed ${label}. Clui keeps up to ${SURFACE_TAB_CAP} tabs per session and closed the one you viewed least recently.`)
  set((s) => ({ ...patchSlice(s, handleId, { surfaces, tabsEvicted: true }), evictedTabs: [card, ...s.evictedTabs], evictedAnnounce: { text, at } }))
}

/** The card's time ran out on the toast stack, which owns the clock so it can pause it. */
export function expireEvicted(id: string): void {
  useSession.setState((s) => ({ evictedTabs: s.evictedTabs.filter((c) => c.id !== id) }))
}

let announceSeq = 0
/** The toggling zero-width space makes a repeated announcement a text change, which is what gets read. */
const toggled = (text: string): string => `${text}${'\u200b'.repeat(++announceSeq % 2)}`
/** What a screen reader hears when Claude puts tab `id` on screen; `opened` when the pane or the tab is new. */
function shownCopy(s: PerSessionState, id: string | null, opened: boolean): string {
  const tab = id ? s.surfaces.tabs[id] : undefined
  const verb = opened ? 'Claude opened' : 'Claude is showing'
  if (!tab) {
    const n = browserTabOf(id)
    const title = clean(s.browser?.tabs.find((t) => t.id === n)?.title ?? '')
    return `${verb} ${title ? `${title} in ` : ''}the browser`
  }
  const at = tab.location
  if (tab.kind === 'diff') return `${verb} its changes${at?.file ? ` to ${basename(at.file)}` : ''}`
  if (tab.kind === 'tree') {
    const rel = at?.file?.startsWith(`${s.cwd}/`) ? at.file.slice(s.cwd.length + 1) : at?.file && basename(at.file)
    return `${verb} ${rel ? `${rel} in ` : ''}the file tree`
  }
  const files = s.surfaces.order.flatMap((x) => (fileLike(s.surfaces.tabs[x]?.kind) ? [s.surfaces.tabs[x].key] : []))
  const dir = suffixes(files).get(tab.key)
  const name = dir ? `${basename(tab.key)} in ${dir}` : basename(tab.key)
  if (at?.line && at.endLine && at.endLine > at.line) return `${verb} lines ${at.line} to ${at.endLine} of ${name}`
  return `${verb} ${name}${at?.line ? ` at line ${at.line}` : ''}`
}

/** Says `text` only while the document is visible. */
const said = (text: string): { statusAnnounce?: string } => (typeof document !== 'undefined' && document.hidden ? {} : { statusAnnounce: toggled(text) })

/** The Stage already shows a Surfaces pane, so the next session's pane reuses it without remounting. */
const surfacePaneShown = (s: SessionStore): boolean => !s.viewingSubagent && !!(s.activeHandleId && s.sessions[s.activeHandleId]?.paneOpen)

/** The payload for a session becoming active. Arriving isn't a request to work in its browser pane,
 *  so a pane that mounts on arrival leaves focus where it was. A deferred open comes up here at half
 *  with no motion; a narrow Stage leaves its flag for a later visit. Only the mount clears the quiet
 *  flag, so it is set only when the pane will mount; a stray flag would skip focus on the next open. */
function arriveWithPane(
  sessions: SessionStore['sessions'],
  handleId: string | null,
  stageWide: boolean,
  paneShown: boolean
): Partial<SessionStore> {
  const cur = handleId ? sessions[handleId] : undefined
  if (!handleId || !cur) return {}
  const quiet = paneShown ? {} : { paneOpenedQuietly: true }
  if (cur.paneOpen) return quiet
  if (!cur.paneAutoOpen || !stageWide) return {}
  return {
    sessions: {
      ...sessions,
      [handleId]: { ...cur, paneOpen: true, surfacePaneFull: false, paneAutoOpen: false, ...said(shownCopy(cur, cur.surfaces.active, true)) }
    },
    ...quiet
  }
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

type Setter = (fn: (s: SessionStore) => Partial<SessionStore>) => void

const NOT_DELIVERED = 'Message not delivered. The session may have stopped. Resume it and try again.'
const NOT_BUILT = "Message not sent: Clui couldn't build it. This is a bug; the text is kept above."
const IDLE_TURN = { busy: false, interrupting: false, turnStartMs: null, thinkingTokens: null, compacting: false } as const

/**
 * Commit a user turn: append the optimistic user bubble, set busy, and write it to the
 * CLI. Used both for an immediate send (idle) and for RELEASING a queued message at a
 * turn boundary, so the queued path and the direct path build the identical bubble.
 */
async function dispatchTurn(set: Setter, handleId: string, text: string, attachments?: SendAttachment[], refs: DraftReference[] = EMPTY_REFS): Promise<void> {
  const userMsg = userBubble(handleId, text, attachments, refs)
  const now = Date.now()
  set((s) => {
    const slice = s.sessions[handleId]
    if (!slice) return {}
    return patchSlice(s, handleId, {
      messages: [...slice.messages, userMsg],
      busy: true,
      interrupting: false,
      turnStartMs: now,
      lastError: null,
      statusAnnounce: '',
      lastActivityMs: now
    })
  })
  // Rolling back busy keeps the composer from a permanent Stop with no running turn. The bubble stays, so the text isn't lost.
  await deliver(set, handleId, userMsg.id, { text, refs, attachments, now: false }, IDLE_TURN)
}

/** The optimistic bubble. Its text omits the packetId until main's accepted text replaces it. */
function userBubble(handleId: string, text: string, attachments: SendAttachment[] | undefined, refs: DraftReference[]): ChatMessage {
  const { visualIndex, attachmentBase } = packetLayout(refs)
  let shown = text
  try {
    shown = serializeContext(sentRefs(refs, useSession.getState().sessions[handleId]?.cwd ?? null), text, { packetId: null })
  } catch {
    // Main refuses the same packet as invalid and says so.
  }
  const crops: MessageAttachment[] = refs.flatMap((d) =>
    d.visual ? [{ kind: 'image', previewUrl: `data:image/jpeg;base64,${d.visual.data}`, w: d.visual.w, h: d.visual.h, blockIndex: visualIndex.get(d.ref.id) }] : []
  )
  const atts = [...crops, ...(attachments ?? []).map((a, i) => ({ ...a.display, blockIndex: attachmentBase + i }))]
  return { id: `u-${crypto.randomUUID()}`, role: 'user', text: shown, thinking: '', tools: [], blocks: [], attachments: atts.length ? atts : undefined }
}

/** One record per resource for `lost`, the shape both a draft notice and a paused queued row read. */
function invalidations(lost: readonly { ref: ContextReference; reason: RefFailure | 'session' }[]): ReferenceInvalidation[] {
  const by = new Map<string, ReferenceInvalidation>()
  for (const { ref, reason } of lost) {
    const change = ref.kind === 'change'
    // Change refs lose access as a set, so one notice per reason covers every file's.
    const id = change ? `change:${reason}` : resourceOf(ref)
    const rec = by.get(id) ?? {
      resourceId: id,
      label: change ? 'changes' : resourceLabel(ref),
      oldVersion: ref.kind === 'browser' ? ref.pin.source.docId : ref.kind === 'file' ? (ref.sourceVersion ?? '') : '',
      at: Date.now(),
      reason,
      removed: []
    }
    rec.removed.push({ id: ref.id, label: shortLabel(ref), ...(ref.note ? { note: ref.note } : {}) })
    by.set(id, rec)
  }
  return [...by.values()]
}

/** Write one packet and apply main's answer. A stale reference sends nothing: the message goes back to the queue
 *  head, paused for review, and nothing behind it releases first. */
async function deliver(
  set: Setter,
  handleId: string,
  bubbleId: string,
  p: { text: string; refs: DraftReference[]; attachments?: SendAttachment[]; now: boolean },
  rollback: Partial<PerSessionState>
): Promise<DispatchResult | null> {
  let r: DispatchResult
  try {
    r = await window.clui.sendMessage(handleId, { text: p.text, refs: p.refs, attachments: p.attachments?.map((a) => a.wire) ?? [], now: p.now })
  } catch {
    set((s) => (s.sessions[handleId] ? patchSlice(s, handleId, { ...rollback, lastError: NOT_DELIVERED }) : {}))
    return null
  }
  set((s) => {
    const slice = s.sessions[handleId]
    if (!slice) return {}
    if (r.ok) return patchSlice(s, handleId, { messages: slice.messages.map((m) => (m.id === bubbleId ? { ...m, text: r.text } : m)) })
    if (r.reason === 'invalid') return patchSlice(s, handleId, { ...rollback, lastError: NOT_BUILT })
    if (r.reason !== 'stale') return {}
    const bad = new Map(r.invalid.map((x) => [x.id, x.reason]))
    const lost = p.refs.flatMap((d) => (bad.has(d.ref.id) ? [{ ref: d.ref, reason: bad.get(d.ref.id)! }] : []))
    const held: QueuedMessage = {
      id: `q-${crypto.randomUUID()}`,
      text: p.text,
      refs: p.refs.filter((d) => !bad.has(d.ref.id)),
      ...(p.attachments?.length ? { attachments: p.attachments } : {}),
      needsReview: invalidations(lost)
    }
    return patchSlice(s, handleId, {
      ...rollback,
      messages: slice.messages.filter((m) => m.id !== bubbleId),
      queuedMessages: [held, ...slice.queuedMessages],
      refAnnounce: toggled(`Paused. ${held.needsReview!.map(pausedText).join(' ')}`)
    })
  })
  if (!r.ok && r.reason === 'stale') afterRefsChange(handleId)
  return r
}

const SENT_NOW = 'Sent.'
const CUT_FOR_MESSAGE = 'Claude stopped its current step to answer.'

/** Send a message now, cutting the running turn's step. Its bubble goes in at once and `busy`
 *  stays as it is: the message's own result ends the work, not the cut turn's. */
async function sendNowTurn(set: Setter, handleId: string, text: string, attachments?: SendAttachment[], refs: DraftReference[] = EMPTY_REFS): Promise<void> {
  const userMsg = userBubble(handleId, text, attachments, refs)
  set((s) => {
    const slice = s.sessions[handleId]
    if (!slice) return {}
    return patchSlice(s, handleId, { messages: [...slice.messages, userMsg], lastActivityMs: Date.now() })
  })
  const r = await deliver(set, handleId, userMsg.id, { text, refs, attachments, now: true }, {})
  if (!r?.ok) return
  if (r.joined) set((s) => (s.sessions[handleId] ? patchSlice(s, handleId, { statusAnnounce: toggled(SENT_NOW) }) : {}))
  // The turn ended before the message reached the CLI, so it runs as a turn of its own.
  else {
    set((s) => {
      const slice = s.sessions[handleId]
      return slice && !slice.busy ? patchSlice(s, handleId, { busy: true, interrupting: false, turnStartMs: Date.now() }) : {}
    })
  }
}

let refSeq = 0
const lastSync = new Map<string, { order: string; watches: string }>()
const syncDue = new Map<string, boolean>()

export function refsOf(slice: PerSessionState, target: RefTarget): DraftReference[] | null {
  return target === null ? slice.contextRefs : (slice.queuedMessages.find((q) => q.id === target)?.refs ?? null)
}

function withRefs(slice: PerSessionState, target: RefTarget, refs: DraftReference[]): Partial<PerSessionState> {
  return target === null ? { contextRefs: refs } : { queuedMessages: slice.queuedMessages.map((q) => (q.id === target ? { ...q, refs } : q)) }
}

/**
 * Tells main which pins still back a reference and which the edit target outlines, and which files to watch.
 * Coalesced to the end of the tick, so a draft that becomes a queued item in one step never drops its pins in
 * between. `force` resends an unchanged order, to drop the outline of a pin the store refused.
 */
function afterRefsChange(handleId: string, force = false): void {
  const due = syncDue.has(handleId)
  syncDue.set(handleId, (syncDue.get(handleId) ?? false) || force)
  if (!due) queueMicrotask(() => flushRefs(handleId))
}

function flushRefs(handleId: string): void {
  const force = syncDue.get(handleId) ?? false
  syncDue.delete(handleId)
  let slice = useSession.getState().sessions[handleId]
  if (!slice) return void lastSync.delete(handleId)
  // A queued message under review that sent or was cancelled hands adds back to the draft.
  if (slice.referenceEditTarget !== null && !refsOf(slice, slice.referenceEditTarget)) {
    useSession.setState((s) => patchSlice(s, handleId, { referenceEditTarget: null }))
    slice = useSession.getState().sessions[handleId]!
  }
  const all = [slice.contextRefs, ...slice.queuedMessages.map((q) => q.refs)].flat()
  const target = refsOf(slice, slice.referenceEditTarget) ?? slice.contextRefs
  const shown = target.flatMap((d, i): [number, number][] => (d.pinId === undefined ? [] : [[d.pinId, i + 1]]))
  const order = { keep: [...new Set(all.flatMap((d) => (d.pinId === undefined ? [] : [d.pinId])))], shown, room: Math.max(0, MAX_REFS - target.length) }
  const seen = new Set<string>()
  const watches = all
    .flatMap((d) => (d.ref.kind === 'file' && d.ref.lines ? [{ path: d.ref.path, version: d.ref.sourceVersion }] : []))
    .filter((w) => !seen.has(`${w.path}\0${w.version}`) && !!seen.add(`${w.path}\0${w.version}`))
    .slice(0, MAX_REFS)
  const prev = lastSync.get(handleId)
  const next = { order: JSON.stringify(order), watches: JSON.stringify(watches) }
  lastSync.set(handleId, next)
  if (force || prev?.order !== next.order) void window.clui.syncAnnotationOrder(handleId, order).catch(() => {})
  if (prev?.watches !== next.watches) void window.clui.syncRefWatches(handleId, watches).catch(() => {})
  const a = slice.annotate
  if (a.note === CAP_NOTE && order.room > 0) useSession.setState((s) => patchSlice(s, handleId, { annotate: { ...a, note: null } }))
}

/** A result ends the user's turn when it isn't a background or peer turn's, or when one of
 *  those took the user's message in. */
function endsUserTurn(e: Extract<DomainEvent, { type: 'result' }>): boolean {
  return (!e.fromTaskNotification && !e.fromPeer) || !!e.answersUser
}

/** A turn that starts on its own while monitors watch was most likely woken by one of them. */
export function runningMonitorWakes(monitors: Record<string, MonitorRecord>): WokenTask[] {
  return Object.entries(monitors).flatMap(([id, r]) =>
    r.status === 'running' ? [{ kind: 'monitor' as const, id, description: r.description, status: 'running' as const }] : []
  )
}

/** The monitors a background turn is billed to: the ones its caption names; for a turn the CLI opened
 *  without streaming, the tasks that ended before it, else every running monitor. */
export function wakeCandidates(woken: WokenTask[] | undefined, ended: WokenTask[], monitors: Record<string, MonitorRecord>): string[] {
  const named = woken ?? (ended.length ? ended : null)
  if (named) return named.flatMap((t) => (t.kind === 'monitor' && t.id ? [t.id] : []))
  return Object.keys(monitors).filter((id) => monitors[id].status === 'running')
}

/** One wake on each candidate. The stream doesn't say which of several monitors fired, so each
 *  counts it and marks it shared. */
export function countWake(monitors: Record<string, MonitorRecord>, ids: string[], usage?: TurnUsage): Record<string, MonitorRecord> {
  const shared = ids.length > 1 ? 1 : 0
  const cost = usage?.costUSD ?? 0
  const estimated = !!usage && isListPriced(usage)
  const next = { ...monitors }
  for (const id of ids) {
    const r = next[id]
    if (!r) continue
    next[id] = { ...r, wakes: r.wakes + 1, sharedWakes: r.sharedWakes + shared, costUsd: r.costUsd + cost, estimated: r.estimated || estimated }
  }
  return next
}

const monitorOfTask = (monitors: Record<string, MonitorRecord>, taskId: string): string | undefined =>
  Object.keys(monitors).find((id) => monitors[id].taskId === taskId)

/** Find or create the current (last) assistant message to append streamed content. A new one
 *  carries `wokenBy` when a background task's end started its turn. */
function currentAssistant(messages: ChatMessage[], wokenBy?: WokenTask[]): ChatMessage {
  const last = messages[messages.length - 1]
  if (last && last.role === 'assistant' && !last.compaction && !last.hookNotes && !last.turnEnd) return last
  const msg: ChatMessage = {
    id: `a-${Date.now()}-${messages.length}`,
    role: 'assistant',
    text: '',
    thinking: '',
    tools: [],
    blocks: [],
    ...(wokenBy?.length ? { wokenBy } : {})
  }
  messages.push(msg)
  return msg
}

const sameNote = (a: HookNote, b: HookNote): boolean =>
  a.event === b.event && a.matcher === b.matcher && a.plugin === b.plugin && a.text === b.text

function withNote(notes: HookNote[], note: HookNote): HookNote[] {
  const i = notes.findIndex((n) => sameNote(n, note))
  return i < 0 ? [...notes, note] : notes.map((n, j) => (j === i ? { ...n, count: n.count + 1 } : n))
}

/** Outside a turn a note stands alone (joining a notes-only item if that's last); before Claude
 *  replies it goes under the prompt; mid-reply it goes inline, in stream order. */
function placeNote(messages: ChatMessage[], note: HookNote, standalone: boolean): void {
  const last = messages[messages.length - 1]
  if (standalone) {
    if (last?.role === 'assistant' && last.hookNotes) messages[messages.length - 1] = { ...last, hookNotes: withNote(last.hookNotes, note) }
    else messages.push({ id: `k-${Date.now()}-${messages.length}`, role: 'assistant', text: '', thinking: '', tools: [], blocks: [], hookNotes: [note] })
  } else if (last?.role === 'user') {
    messages[messages.length - 1] = { ...last, hookNotes: withNote(last.hookNotes ?? [], note) }
  } else {
    const m = currentAssistant(messages)
    const blocks = m.blocks.slice()
    const hit = blocks.findIndex((b) => b.kind === 'hook' && sameNote(b, note))
    const prev = blocks[hit]
    if (prev?.kind === 'hook') blocks[hit] = { ...prev, count: prev.count + 1 }
    else blocks.push({ kind: 'hook', ...note })
    messages[messages.length - 1] = { ...m, blocks }
  }
}

const MOD_TOAST_CAP = 3
let modToastSeq = 0

/** Narrow a loose CLI task status to the tray's union: only 'killed'/'failed' are kept
 *  distinct; every other terminal string collapses to 'completed' (the tray only cares
 *  running-vs-not). One place so the bg-task-updated and -notification arms can't diverge. */
function narrowTaskStatus(status: string | undefined): Exclude<BackgroundTask['status'], 'running'> {
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
const NO_RETRY = { apiRetry: null, apiRetryDismissed: false, apiRetryAnnounce: '' } as const

/** Anything the turn streams means the API answered, so a retry notice is stale. A result
 *  clears it too, but only the foreground turn's. */
const ENDS_RETRY = new Set<DomainEvent['type']>([
  'message-start',
  'text-delta',
  'thinking-delta',
  'thinking-tokens',
  'tool-use-start',
  'tool-use-input-delta',
  'tool-use-stop',
  'turn-complete',
  'context-usage',
  'process-exit'
])

function touchesMessages(type: DomainEvent['type']): boolean {
  return (
    type === 'text-delta' ||
    type === 'thinking-delta' ||
    type === 'tool-use-start' ||
    type === 'tool-use-stop' ||
    type === 'tool-result' ||
    type === 'peer-pending' ||
    type === 'peer-message' ||
    type === 'peer-lifecycle-end' ||
    type === 'cli-message' ||
    type === 'mod-log' ||
    type === 'compact-boundary' ||
    type === 'result'
  )
}

export const useSession = create<SessionStore>((set, get) => ({
  sessions: {},
  activeHandleId: null,
  notice: null,
  browserAnnounce: '',
  systemPermissionMode: undefined,
  refreshSystemPermissionMode: async () => {
    const mode = await window.clui.getSystemPermissionMode().catch(() => null)
    set(() => ({ systemPermissionMode: mode }))
    return mode
  },
  modToasts: [],
  modToastAnnounce: { text: '', at: 0 },
  evictedTabs: [],
  evictedAnnounce: { text: '', at: 0 },
  effortCaps: {},
  viewingSubagent: null,
  subagentTrail: [],
  paneFull: false,
  stageWide: false,
  setStageWide: (wide) => set({ stageWide: wide }),
  paneOpenedQuietly: false,
  primaryScrolled: false,
  primaryScrolledFor: null,
  secondaryScrolled: false,
  findOpen: false,
  findActiveId: null,
  globalSearchOpen: false,
  settingsSection: null,
  settingsSub: {},
  scrollTarget: null,
  currentTurn: null,
  sessionGroups: [],
  sessionsLoading: true,
  chatDir: null,

  refreshSessions: async (quiet = false) => {
    // TODO: CommandPalette still fetches listSessions() independently; fold it onto this
    // store copy so its list can't drift from the sidebar's.
    const gen = ++refreshGen
    if (!quiet) set(() => ({ sessionsLoading: true }))
    try {
      const groups = await window.clui.listSessions()
      // A newer refresh started while this scan ran → it owns the result; dropping this
      // stale one stops an older scan from overwriting fresher rename/delete state.
      if (gen !== refreshGen) return
      set(() => ({ sessionGroups: groups, ...(quiet ? {} : { sessionsLoading: false }) }))
    } catch {
      if (gen !== refreshGen) return
      set(() => ({
        ...(quiet ? {} : { sessionsLoading: false }),
        notice: { message: 'Could not refresh the session list.', tone: 'error' }
      }))
    }
  },

  loadEffortCaps: async () => {
    try {
      const caps = await window.clui.getEffortCaps()
      set(() => ({ effortCaps: caps }))
    } catch {
      // best-effort: absent caps just means the picker shows every level (today's behavior)
    }
  },

  loadChatDir: async () => {
    if (get().chatDir) return
    try {
      const dir = await window.clui.getChatDir()
      set(() => ({ chatDir: dir }))
    } catch {
      // best-effort: without it a directoryless session just renders as a normal project group
    }
  },

  startSession: async (cwd, mode, opts) => {
    await beginSession(get, set, { cwd, permissionMode: mode, ...opts })
  },

  resumeSession: async (cwd, resumeSessionId, mode, hardTitle) => {
    const slices = Object.values(get().sessions)
    // Only a CONFIRMED-LIVE (non-exited) slice can be re-viewed without respawning; an
    // exited slice's process is gone, so activating it would strand sends on a dead
    // handle.
    const live = slices.find((s) => !s.exited && s.sessionId === resumeSessionId)
    if (live) {
      get().activateSession(live.handleId)
      return
    }
    // Two concurrent resumes of the same durable id would both miss the (not-yet-inserted)
    // slice and spawn two writers for one conversation, so reserve the id.
    if (resumingIds.has(resumeSessionId)) return
    resumingIds.add(resumeSessionId)
    // Drop a retired slice for this id so the fresh session replaces it instead of leaving
    // a dead handle the sidebar could still offer.
    const dead = slices.find((s) => s.exited && s.sessionId === resumeSessionId)
    if (dead) {
      retireHandle(dead.handleId)
      set((s) => {
        const next = { ...s.sessions }
        delete next[dead.handleId]
        return { sessions: next }
      })
    }
    try {
      // Only a hard title becomes `-n`; a derived (first-message) session passes nothing so
      // resume doesn't pin a paraphrase as the discovery name.
      await beginSession(get, set, { cwd, resumeSessionId, permissionMode: mode, name: hardTitle })
    } finally {
      resumingIds.delete(resumeSessionId)
    }
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
      // Reserve room for the prefix AND the numeric suffix, then truncate only the
      // source-title portion, then append the suffix after. Truncating the whole
      // `Branch-<title> <i>` candidate drops the suffix for a long title, so every
      // iteration produces the same taken name and the loop spins forever.
      const LIMIT = 80
      const PREFIX = 'Branch-'
      const build = (i: number): string => {
        const suffix = i > 1 ? ` ${i}` : ''
        const room = LIMIT - PREFIX.length - suffix.length
        const base = shown.length > room ? shown.slice(0, room - 1) + '…' : shown
        return `${PREFIX}${base}${suffix}`
      }
      name = build(1)
      for (let i = 2; taken.has(name) && i < 10000; i++) name = build(i)
    }
    await beginSession(get, set, { cwd, resumeSessionId: sourceSessionId, fork: true, permissionMode: mode, name })
  },

  activateSession: (handleId) => {
    if (!get().sessions[handleId]) return
    set((s) => {
      const { sessions = s.sessions } = patchSlice(s, handleId, { lastActivityMs: Date.now() })
      return {
        sessions,
        ...arriveWithPane(sessions, handleId, s.stageWide, surfacePaneShown(s)),
        activeHandleId: handleId,
        // Switching sessions closes any open transcript view (its ids are scoped to
        // the previously-active session's Agent tool_use ids).
        viewingSubagent: null,
        subagentTrail: [],
        currentTurn: null
      }
    })
  },

  renameLiveSession: (handleId, name) => {
    const slice = get().sessions[handleId]
    if (!slice || slice.exited) return
    // Optimistic: footer and sidebar prefer a live slice's explicit title, so the rename shows
    // before the CLI mirrors it to customTitle. Inject now if idle, else defer to turn-end so the
    // /rename suppression window can't swallow an in-flight result.
    set((s) => patchSlice(s, handleId, { title: name }))
    if (slice.busy) pendingLiveRename.set(handleId, name)
    else void window.clui.injectRename(handleId, name)
  },

  closeSession: async (handleId) => {
    flushSurfaces(handleId)
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
      retireHandle(handleId)
      return {
        sessions: next,
        activeHandleId: active,
        // If the active session changed, its detail view (scoped to the closed session's
        // tool ids) must reset.
        ...(active !== s.activeHandleId ? { viewingSubagent: null, subagentTrail: [], ...arriveWithPane(next, active, s.stageWide, surfacePaneShown(s)) } : {})
      }
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
    // we update the reported mode ourselves. Main resolves 'inherit' from settings.json,
    // so the mode stays unknown until its reply names it.
    const prev = {
      modeChoice: active.modeChoice,
      modelMode: active.modelMode,
      permissionMode: active.permissionMode
    }
    set((s) =>
      patchSlice(s, active.handleId, {
        modeChoice: mode,
        // A manual pick wins: drop any model-driven override so the chip shows their choice.
        modelMode: null,
        permissionMode: mode === 'inherit' ? null : mode
      })
    )
    // Revert the optimistic chip if the CLI rejected the change: the UI must
    // not claim a mode the session isn't actually in.
    const { ok, errorCode, mode: resolved } = await window.clui.setPermissionMode(active.handleId, mode)
    // A reply that lands after a newer pick belongs to a superseded change and must not overwrite it.
    if (get().sessions[active.handleId]?.modeChoice !== mode) return
    if (ok) {
      if (resolved) set((s) => patchSlice(s, active.handleId, { permissionMode: resolved }))
    } else {
      const label = PERMISSION_MODE_LABELS[mode]
      const current = PERMISSION_MODE_LABELS[effectiveMode(prev).mode]
      set((s) => ({
        ...patchSlice(s, active.handleId, prev),
        notice:
          errorCode === 'auto_mode_model'
            ? { message: `${label} isn't available on ${deriveModelInfo(active.modelChoice).label}. Permissions stay on ${current}.`, tone: 'warn' }
            : { message: `Couldn't switch permissions to ${label}. The session is still on ${current}.`, tone: 'error' }
      }))
    }
  },

  setModel: async (model) => {
    const active = activeSlice(get())
    if (!active) return
    // If the new model doesn't support the current effort, clamp it down.
    const nextEffort = clampEffort(model, active.effortChoice)
    const prevEffort = active.effortChoice
    // Switching to a model that can't run Ultra (e.g. Haiku) turns it off: the switch is live
    // with no respawn, so nothing else would clear a lit star. An effort cap never turns it
    // off, since Ultra runs at whatever effort is allowed.
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
    const prev = {
      modelChoice: active.modelChoice,
      effortChoice: active.effortChoice,
      ultracode: active.ultracode,
      contextWindow: active.contextWindow,
      contextPercent: active.contextPercent
    }
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
    // If the CLI rejected the model change, revert the picker + remembered prefs rather
    // than leave the UI (and a future resume) claiming a model that never applied.
    const res = await window.clui.setModel(active.handleId, model)
    // A reply that lands after a newer pick belongs to a superseded switch and must not overwrite it.
    if (get().sessions[active.handleId]?.modelChoice !== model) return
    if (!res.ok) {
      let target = deriveModelInfo(model).label
      let current = deriveModelInfo(prev.modelChoice).label
      if (target === current) {
        target += ` (${contextSizeLabel(model)})`
        current += ` (${contextSizeLabel(prev.modelChoice)})`
      }
      const reason = res.errorCode === 'check_rejected' ? modelCheckReason(res.reason) : null
      set((s) => ({
        ...patchSlice(s, active.handleId, prev),
        notice: res.timedOut
          ? {
              message: `The switch to ${target} timed out, so the picker is back on ${current}. If the CLI applies it late, the picker updates on your next message.`,
              tone: 'warn'
            }
          : { message: `Couldn't switch to ${target}.${reason ? ` ${reason}` : ''} The session is still on ${current}.`, tone: 'error' }
      }))
      if (active.sessionId)
        rememberModelPrefs(active.sessionId, {
          model: prev.modelChoice,
          effort: prev.effortChoice,
          ultracode: prev.ultracode
        })
      return
    }
    // A session spawned in auto on a model that can't run it fell back to default; the new model
    // may run it, so offer the pick again. A refusal leaves the chip on the mode in effect.
    const now = get().sessions[active.handleId]
    if (now?.modeChoice === 'auto' && !now.modelMode && now.permissionMode !== 'auto') {
      const { ok: restored } = await window.clui.setPermissionMode(active.handleId, 'auto')
      if (restored) set((s) => patchSlice(s, active.handleId, { permissionMode: 'auto' }))
    }
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
    if (on && !supportsUltracodeToggle(active.modelChoice)) return
    // Effort is independent of Ultra: the CLI runs ultracode at the stored effortLevel, so
    // this sends only the ultracode flag and never touches effortChoice.
    const prevUltra = active.ultracode
    set((s) => patchSlice(s, active.handleId, { ultracode: on }))
    if (active.sessionId) rememberModelPrefs(active.sessionId, { ultracode: on })
    const ok = await window.clui.setUltracode(active.handleId, on)
    if (!ok) {
      set((s) => ({
        ...patchSlice(s, active.handleId, { ultracode: prevUltra }),
        notice: { message: 'Could not toggle ultracode.', tone: 'error' }
      }))
      if (active.sessionId) rememberModelPrefs(active.sessionId, { ultracode: prevUltra })
    }
  },

  sendMessage: async (text, attachments, opts) => {
    const active = activeSlice(get())
    // A turn is valid with text OR at least one attachment (an attachments-only turn is fine).
    const refs = opts?.refs ?? EMPTY_REFS
    if (!active || (!text.trim() && !attachments?.length && !refs.length)) return
    // The process is gone; a send would silently no-op in main while the UI spun busy.
    // Tell the user to resume instead.
    if (active.exited) {
      set(() => ({
        notice: { message: 'This session has stopped. Resume it from the sidebar to continue.', tone: 'warn' }
      }))
      return
    }
    // A new prompt hands a stopped browser back to Claude. It runs before the queue check because the
    // prompt after a Stop usually queues behind the interrupted turn.
    if (anyTabIn(active.browser, 'stopped')) void window.clui.browserDrive(active.handleId, 'reset')
    if (active.paneAutoOpenSuppressed) set((s) => patchSlice(s, active.handleId, { paneAutoOpenSuppressed: false }))
    if (opts?.now && active.busy && !active.interrupting) {
      await sendNowTurn(set, active.handleId, text, attachments, refs)
      return
    }
    // Composed while a turn is running (or interrupting, or with messages already queued) →
    // HOLD it renderer-side (editable/cancelable, rendered at the tail) instead of dispatching
    // now. It's sent FIFO at the next turn boundary (see the `result` handler). Queuing while
    // `interrupting` or with a non-empty queue keeps strict FIFO: a post-Stop prompt must not
    // jump ahead of the interrupted turn's boundary or of earlier queued prompts.
    if (active.busy || active.interrupting || active.queuedMessages.length > 0) {
      const qm: QueuedMessage = { id: `q-${crypto.randomUUID()}`, text, refs, attachments }
      set((s) =>
        patchSlice(s, active.handleId, {
          queuedMessages: [...(s.sessions[active.handleId]?.queuedMessages ?? []), qm]
        })
      )
      afterRefsChange(active.handleId)
      return
    }
    await dispatchTurn(set, active.handleId, text, attachments, refs)
  },
  sendQueuedNow: (id) => {
    const active = activeSlice(get())
    const q = active?.queuedMessages.find((m) => m.id === id)
    if (!active || !q || q.needsReview?.length || !active.busy || active.interrupting) return
    // Out of the queue before anything awaits, so a result landing now can't release it a second time.
    set((s) => patchSlice(s, active.handleId, { queuedMessages: active.queuedMessages.filter((m) => m.id !== id) }))
    afterRefsChange(active.handleId)
    void sendNowTurn(set, active.handleId, q.text, q.attachments, q.refs)
  },
  editQueuedMessage: (id, text) =>
    set((s) => {
      const active = activeSlice(s)
      if (!active) return {}
      return patchSlice(s, active.handleId, {
        queuedMessages: active.queuedMessages.map((q) => (q.id === id ? { ...q, text } : q))
      })
    }),
  cancelQueuedMessage: (id) => {
    const active = activeSlice(get())
    if (!active) return
    set((s) =>
      patchSlice(s, active.handleId, {
        queuedMessages: active.queuedMessages.filter((q) => q.id !== id),
        ...(active.referenceEditTarget === id ? { referenceEditTarget: null } : {})
      })
    )
    afterRefsChange(active.handleId)
  },
  setDraftText: (handleId, text) => set((s) => patchSlice(s, handleId, { draftText: text })),
  addDraftAttachments: (handleId, atts) =>
    set((s) => {
      const cur = s.sessions[handleId]
      if (!cur || atts.length === 0) return {}
      return patchSlice(s, handleId, { draftAttachments: [...cur.draftAttachments, ...atts] })
    }),
  removeDraftAttachment: (handleId, id) =>
    set((s) => {
      const cur = s.sessions[handleId]
      if (!cur) return {}
      return patchSlice(s, handleId, {
        draftAttachments: cur.draftAttachments.filter((a) => a.id !== id)
      })
    }),
  clearDraft: (handleId) =>
    set((s) => {
      const cur = s.sessions[handleId]
      if (!cur) return {}
      return patchSlice(s, handleId, { draftText: '', draftAttachments: EMPTY_ATTACHMENTS })
    }),

  interrupt: async () => {
    const active = activeSlice(get())
    if (!active) return
    // Stop raced the turn's end (result already cleared busy): nothing outstanding to abandon,
    // just forward the interrupt (harmless no-op in main) so we never mark a phantom boundary.
    if (!active.busy) {
      await window.clui.interrupt(active.handleId)
      return
    }
    // A turn still buffered pre-init emits NO result (main drops pendingSends on interrupt),
    // so waiting for one would strand the composer. Clear locally and release the oldest queued
    // message (the FIFO boundary passed) so the session isn't bricked.
    if (active.model === null) {
      const [head, ...rest] = active.queuedMessages
      const next = head && !head.needsReview?.length ? head : undefined
      set((s) =>
        patchSlice(s, active.handleId, {
          busy: false,
          interrupting: false,
          turnStartMs: null,
          thinkingTokens: null,
          compacting: false,
          ...NO_RETRY,
          ...(next ? { queuedMessages: rest } : {})
        })
      )
      await window.clui.interrupt(active.handleId)
      if (next) {
        afterRefsChange(active.handleId)
        void dispatchTurn(set, active.handleId, next.text, next.attachments, next.refs)
      }
      return
    }
    // A running turn will emit a terminal `result`. Mark `interrupting` (distinct from idle)
    // so a new prompt queues instead of dispatching a second concurrent turn; the late result
    // is recognized as THIS turn's boundary and swallowed, not the new turn's.
    set((s) =>
      patchSlice(s, active.handleId, {
        busy: false,
        interrupting: true,
        turnStartMs: null,
        thinkingTokens: null,
        compacting: false,
        ...NO_RETRY
      })
    )
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
      set((s) => patchSlice(s, handleId, { busy: true, turnStartMs: Date.now() }))
      await window.clui.sendMessage(handleId, {
        text: `Stop the background task with id ${taskId} now using the TaskStop tool. Do not do anything else.`,
        refs: [],
        attachments: [],
        now: false
      })
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
      // NEVER dispose the record a detail view is currently showing, or the open view falls
      // back to an empty generic pane. A subagent is viewed by its toolUseId (the
      // PTU), a workflow by its taskId, so both are matched against `viewingSubagent`.
      const viewing = s.viewingSubagent
      const patch: Partial<PerSessionState> = {}
      // Drop lingering terminal SUBAGENTS (keep running ones, any bash, and the viewed one).
      if (kind !== 'workflow') {
        const nextTasks: Record<string, BackgroundTask> = {}
        for (const [id, t] of Object.entries(active.backgroundTasks)) {
          const lingeringSubagent =
            t.taskType === 'local_agent' && t.status !== 'running' && t.toolUseId !== viewing
          if (!lingeringSubagent) nextTasks[id] = t
        }
        patch.backgroundTasks = nextTasks
      }
      // Drop ENDED workflows (keep running ones, endedStatus === null, and the viewed one).
      if (kind !== 'subagent') {
        const nextWf: Record<string, WorkflowState> = {}
        for (const [id, w] of Object.entries(active.workflows)) {
          if (w.endedStatus === null || id === viewing) nextWf[id] = w
        }
        patch.workflows = nextWf
      }
      return patchSlice(s, active.handleId, patch)
    }),

  refreshChanges: async (handleId) => {
    const changes = await window.clui.getChanges(handleId)
    // Null once main let go of the session; the slice keeps the last summaries it had.
    if (changes) set((s) => patchSlice(s, handleId, { changes }))
  },

  gitStatus: {},
  refreshGitStatus: async (handleId) => {
    const gen = (gitGen.get(handleId) ?? 0) + 1
    gitGen.set(handleId, gen)
    const reply = await window.clui.getChangeGitStatus(handleId)
    if (gitGen.get(handleId) !== gen) return
    if (!reply || !get().sessions[handleId]) {
      gitGen.delete(handleId)
      return
    }
    // The tray polls every 2s; an unchanged reply leaves state alone so rows don't re-render.
    set((s) => (Object.entries(reply).every(([p, g]) => sameGit(s.gitStatus[p], g)) ? s : { gitStatus: { ...s.gitStatus, ...reply } }))
  },

  respondPermission: async (verdict) => {
    const active = activeSlice(get())
    if (!active) return
    // Browser Gates are raised by Clui's own MCP server, not the CLI, so their answer goes to main.
    const req = active.pendingPermissions.find((p) => p.requestId === verdict.requestId)
    if (req?.toolName === 'BrowserSite' || req?.toolName === 'BrowserLogin') {
      set((s) =>
        patchSlice(s, active.handleId, {
          pendingPermissions: active.pendingPermissions.filter((p) => p.requestId !== verdict.requestId)
        })
      )
      if (req.toolName === 'BrowserSite')
        await window.clui.browserSiteVerdict(active.handleId, verdict.requestId, verdict.behavior === 'allow')
      else await window.clui.browserLoginVerdict(active.handleId, verdict.requestId, { action: 'decline' })
      return
    }
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
    const flush: {
      prefs: { sessionId: string; model: ModelChoice; effort: EffortChoice; ultracode: boolean } | null
      window: { sessionId: string; contextWindow: number } | null
    } = { prefs: null, window: null }
    // A title change on disk (a `/rename`, or a resume mirroring customTitle) emits no
    // stream event to map, so nothing else refreshes the sidebar. Detected at the turn
    // boundary below and quiet-rescanned post-commit. Holder like `release`.
    const rescanSessions = { needed: false }
    // A usage-limit event to (re)arm the reset timer for, after the commit. Holder like `release`.
    const rateLimitSchedule: { next: RateLimit | null } = { next: null }
    set((state) => {
      const slice = state.sessions[handleId]
      // Slice not created yet: buffer until insertSlice flushes it (race guard). But a
      // RETIRED handle's slice will never be (re)inserted, so discard its late events
      // instead of buffering them forever; a pending start's buffer is capped.
      if (!slice) {
        if (retiredHandles.has(handleId)) return {}
        const buf = earlyBuffer.get(handleId) ?? []
        if (buf.length < EARLY_BUFFER_CAP) {
          buf.push(e)
          earlyBuffer.set(handleId, buf)
        }
        return {}
      }

      // Only copy the message list for events that mutate it (keeps unrelated
      // events like context-usage and result from re-rendering the transcript).
      const messages = touchesMessages(e.type) ? slice.messages.slice() : slice.messages
      const patch: Partial<PerSessionState> = {}
      // Top-level (store-wide) notice to set, if any; survives a slice drop.
      let topLevelNotice: Notice | null = null
      const top: Partial<SessionStore> = {}
      // Set true to CLEAR the app-level notice (e.g. a fresh session-init resolves the
      // transient "Reconnecting…" notice from an effort/ultracode respawn).
      let clearNotice = false
      if (slice.apiRetry && (ENDS_RETRY.has(e.type) || (e.type === 'result' && endsUserTurn(e)))) {
        Object.assign(patch, NO_RETRY)
      }
      // A turn that starts while the user's isn't running was woken by the tasks that ended before it.
      const assistant = (): ChatMessage => {
        const before = messages.length
        const peer = messages[before - 1]?.role === 'peer'
        const woken = slice.busy ? undefined : slice.endedTasks.length ? slice.endedTasks : peer ? undefined : runningMonitorWakes(slice.monitors)
        const m = currentAssistant(messages, woken)
        if (messages.length > before && slice.endedTasks.length && m.wokenBy) patch.endedTasks = EMPTY_WOKEN
        return m
      }

      switch (e.type) {
        case 'api-retry': {
          const retry = { attempt: e.attempt, maxRetries: e.maxRetries, delayMs: e.delayMs, status: e.status }
          patch.apiRetry = retry
          if (!slice.apiRetry || retry.attempt === retry.maxRetries) patch.apiRetryAnnounce = apiRetryCopy(retry)
          break
        }
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
          patch.changeRead = e.tools.includes(CHANGE_READ_TOOL)
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
          if (slice.thinkingTokens !== null) patch.thinkingTokens = null
          const m = assistant()
          m.text += e.text
          // Extend the trailing text block, or start a new one (after a tool block)
          // so text that streams AFTER tools renders below them, in true order.
          const tail = m.blocks[m.blocks.length - 1]
          if (tail && tail.kind === 'text') tail.text += e.text
          else m.blocks.push({ kind: 'text', text: e.text })
          break
        }
        case 'thinking-tokens':
          patch.thinkingTokens = e.estimated
          break
        case 'compact-status':
          patch.compacting = e.state === 'running'
          patch.statusAnnounce = e.state === 'running' ? 'Compacting context' : 'Context compacted'
          if (e.state === 'failed') {
            const lastUser = messages.findLast((m) => m.role === 'user')
            patch.lastError = lastUser?.text.trim().startsWith('/compact')
              ? "Couldn't compact the context. Your conversation is unchanged. Run /compact to try again."
              : `Auto-compact failed.${slice.contextPercent !== null ? ` Context is ${slice.contextPercent}% full.` : ''} Run /compact or start a new session.`
            patch.statusAnnounce = patch.lastError
          }
          break
        case 'compact-boundary':
          messages.push({
            id: `c-${Date.now()}-${messages.length}`,
            role: 'assistant',
            text: '',
            thinking: '',
            tools: [],
            blocks: [],
            compaction: { trigger: e.trigger, preTokens: e.preTokens, postTokens: e.postTokens }
          })
          break
        case 'cli-message': {
          if (e.blocked) {
            const i = messages.findLastIndex((m) => m.role === 'user')
            if (i >= 0) messages[i] = { ...messages[i], blocked: { reason: e.text, command: e.command } }
            patch.statusAnnounce = toggled(`Prompt blocked by a hook. ${e.text}`)
            break
          }
          const src = e.source ?? ''
          const cut = src.indexOf(':')
          const note: HookNote = {
            event: (cut < 0 ? src : src.slice(0, cut)) || undefined,
            matcher: cut < 0 ? undefined : src.slice(cut + 1),
            text: e.text,
            count: 1
          }
          // SessionStart isn't about the prompt it happens to arrive with, so it stands alone.
          placeNote(messages, note, !slice.busy || note.event === 'SessionStart')
          break
        }
        case 'mod-log':
          placeNote(messages, { plugin: e.plugin, text: e.text, count: 1 }, !slice.busy)
          break
        case 'mod-toast': {
          // Over Settings a card would cover its controls, so it becomes a transcript line there too.
          if (handleId !== state.activeHandleId || state.settingsSection) {
            const msgs = slice.messages.slice()
            placeNote(msgs, { plugin: e.plugin, text: e.text, count: 1 }, !slice.busy)
            patch.messages = msgs
            break
          }
          const hit = state.modToasts.find((t) => t.plugin === e.plugin && t.text === e.text)
          const now = Date.now()
          top.modToasts = hit
            ? state.modToasts.map((t) => (t === hit ? { ...t, count: t.count + 1 } : t))
            : [
                {
                  id: `mt-${++modToastSeq}`,
                  plugin: e.plugin,
                  text: e.text,
                  durationMs: Math.min(20_000, Math.max(3000, e.timeoutMs)),
                  count: 1,
                  at: now
                },
                ...state.modToasts
              ].slice(0, MOD_TOAST_CAP)
          top.modToastAnnounce = { text: toggled(`${e.plugin} plugin: ${e.text.slice(0, 200)}`), at: now }
          break
        }
        case 'mod-status': {
          const { plugin, text } = e
          const i = slice.modStatus.findIndex((l) => l.plugin === plugin)
          if (text === null) {
            if (i >= 0) patch.modStatus = slice.modStatus.filter((_, j) => j !== i)
          } else if (i < 0) patch.modStatus = [...slice.modStatus, { plugin, text }]
          else if (slice.modStatus[i].text !== text) patch.modStatus = slice.modStatus.map((l, j) => (j === i ? { plugin, text } : l))
          break
        }
        case 'mod-status-reset':
          if (slice.modStatus.length) patch.modStatus = EMPTY_MOD_STATUS
          break
        case 'thinking-delta': {
          const m = assistant()
          m.thinking += e.text
          break
        }
        case 'tool-use-start': {
          if (slice.thinkingTokens !== null) patch.thinkingTokens = null
          const m = assistant()
          m.tools.push({ id: e.id, name: e.name, input: {}, startMs: Date.now() })
          m.blocks.push({ kind: 'tool', id: e.id })
          break
        }
        case 'tool-use-stop': {
          // Not necessarily the last message: a message sent mid-turn can land between a tool's start and stop.
          const t = messages.findLast((m) => m.tools.some((t) => t.id === e.id))?.tools.find((t) => t.id === e.id)
          if (t) t.input = e.input
          break
        }
        case 'tool-result': {
          for (let i = messages.length - 1; i >= 0; i--) {
            const t = messages[i].tools.find((t) => t.id === e.toolUseId)
            if (t) {
              t.result = e.content
              t.isError = e.isError
              if (e.notRun) t.notRun = true
              if (e.stopped) t.stopped = true
              break
            }
          }
          if (slice.checkingTools[e.toolUseId]) patch.checkingTools = withoutKey(slice.checkingTools, e.toolUseId)
          break
        }
        case 'permission-check':
          if (e.checking) patch.checkingTools = { ...slice.checkingTools, [e.toolUseId]: true }
          else if (slice.checkingTools[e.toolUseId]) patch.checkingTools = withoutKey(slice.checkingTools, e.toolUseId)
          break
        case 'rate-limit': {
          const r = e.info
          rateLimitSchedule.next = r
          if (r.status === 'allowed') {
            if (slice.rateLimit) Object.assign(patch, { rateLimit: null, rateLimitDismissed: false, rateLimitAnnounce: '' })
            break
          }
          patch.rateLimit = r
          if (slice.rateLimit?.status !== r.status) {
            patch.rateLimitDismissed = false
            patch.rateLimitAnnounce = rateLimitCopy(r)
          }
          break
        }
        case 'permission-request':
          // The classifier passed the call to the user, so its check is over.
          if (e.toolUseId && slice.checkingTools[e.toolUseId]) patch.checkingTools = withoutKey(slice.checkingTools, e.toolUseId)
          patch.pendingPermissions = [
            ...slice.pendingPermissions,
            {
              requestId: e.requestId,
              toolName: e.toolName,
              input: e.input,
              displayName: e.displayName,
              description: e.description,
              permissionSuggestions: e.permissionSuggestions,
              decisionReason: e.decisionReason,
              decisionReasonType: e.decisionReasonType,
              blockedPath: e.blockedPath,
              suppressAlwaysAllow: e.suppressAlwaysAllow,
              agentToolUseId: e.agentToolUseId,
              agentDescription: e.agentDescription
            }
          ]
          patch.lastActivityMs = Date.now()
          break
        case 'elicitation-request':
          patch.pendingPermissions = [
            ...slice.pendingPermissions,
            { requestId: e.requestId, toolName: 'McpElicitation', displayName: e.request.serverName, input: e.request }
          ]
          patch.lastActivityMs = Date.now()
          break
        case 'permission-cancel':
          // The CLI withdrew this pending prompt, so drop it and the dialog closes.
          patch.pendingPermissions = slice.pendingPermissions.filter(
            (p) => p.requestId !== e.requestId
          )
          break
        case 'context-usage': {
          // Before a result measures it, the mapper's window is a guess from the model id, which a
          // suffix-free 1M default on Bedrock makes wrong, so a remembered measured window wins.
          const window = e.measured ? e.contextWindow : (slice.contextWindow ?? e.contextWindow)
          patch.contextPercent = Math.min(100, Math.round((e.usedTokens / window) * 100))
          patch.contextTokens = e.usedTokens
          patch.contextWindow = window
          if (e.measured && slice.sessionId && modelPrefsBySessionId.get(slice.sessionId)?.contextWindow !== window)
            flush.window = { sessionId: slice.sessionId, contextWindow: window }
          // Reset the compact-suggestion dismissal when context drops back below the
          // trigger (a fresh fill-cycle after a manual/auto compact) so the row can
          // offer again. Uses the same window-class threshold as the suggestion.
          if (
            slice.compactDismissedAtRunway != null &&
            patch.contextPercent < suggestCompactPercent(window)
          ) {
            patch.compactDismissedAtRunway = null
          }
          break
        }
        case 'reconnected':
          clearNotice = true
          break
        case 'model-efforts':
          setLiveEfforts(e.efforts)
          patch.effortChoice = clampEffort(slice.modelChoice, slice.effortChoice)
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
        case 'bg-task-started': {
          // The running turn's own launch counts toward its footer; a subagent's is nested under that agent.
          const last = messages[messages.length - 1]
          const turnOpen = slice.busy || (last?.role === 'assistant' && !last.turnEnd)
          if (turnOpen && !subagentOwnerOfTask(e.toolUseId, slice.subagentMessages, slice.subagentChildren)) {
            patch.turnTasks = [...slice.turnTasks, e.taskId]
          }
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
          const call = e.toolUseId ? messages.findLast((m) => m.tools.some((t) => t.id === e.toolUseId))?.tools.find((t) => t.id === e.toolUseId) : undefined
          if (call?.name === 'Monitor') {
            const desc = (call.input as { description?: unknown } | null)?.description
            patch.monitors = {
              ...slice.monitors,
              [call.id]: {
                taskId: e.taskId,
                description: typeof desc === 'string' && desc ? desc : e.description,
                status: 'running',
                startMs: Date.now(),
                wakes: 0,
                sharedWakes: 0,
                costUsd: 0,
                estimated: false
              }
            }
          }
          break
        }
        case 'bg-task-updated': {
          // A terminal status → mark the task terminal (so the tray, which shows only
          // status==='running', stops listing it) but KEEP the entry so the imminent
          // bg-task-notification can still read its description for the toast. It's
          // removed on that notification (or by bg-tasks-changed dropping it from the
          // running snapshot). Keeping it makes the completion toast fire regardless of
          // whether task_updated(terminal) or task_notification arrives first.
          const prev = slice.backgroundTasks[e.taskId]
          if (prev && e.status && e.status !== 'running') {
            patch.backgroundTasks = {
              ...slice.backgroundTasks,
              [e.taskId]: { ...prev, status: narrowTaskStatus(e.status) }
            }
          }
          const mon = monitorOfTask(slice.monitors, e.taskId)
          if (mon && e.status && e.status !== 'running') {
            patch.monitors = { ...slice.monitors, [mon]: { ...slice.monitors[mon], status: narrowTaskStatus(e.status) } }
          }
          break
        }
        case 'bg-task-notification': {
          // Terminal notification → toast + drop the task, but ONLY for a task we were
          // actually tracking. Two layers guard against a phantom "Background task finished:
          // Background task" toast: the mapper only emits this for genuine local_bash
          // tasks, AND here we refuse to announce a task that was never in the tray
          // (no `prev` → nothing to report). Since bg-task-updated MARKS terminal
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
            const mon = monitorOfTask(slice.monitors, e.taskId)
            const rec = mon ? slice.monitors[mon] : undefined
            if (mon && rec) patch.monitors = { ...slice.monitors, [mon]: { ...rec, status } }
            const description = rec?.description ?? prev.description
            patch.endedTasks = [
              ...slice.endedTasks,
              mon
                ? { kind: 'monitor', id: mon, description, status }
                : { kind: prev.taskType === 'local_agent' ? 'agent' : 'command', description, status }
            ]
            const kind = mon ? 'Monitor' : prev.taskType === 'local_agent' ? 'Background subagent' : 'Background task'
            // Tone tracks the terminal outcome so a killed or failed task isn't announced as success.
            const verb = status === 'killed' ? 'stopped' : status === 'failed' ? 'failed' : mon ? 'ended' : 'finished'
            topLevelNotice = {
              message: `${kind} ${verb}: ${description}`,
              tone: status === 'killed' ? 'warn' : status === 'failed' ? 'error' : 'success'
            }
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
          // A monitor whose task left the snapshot without a notification has still ended.
          const gone = Object.keys(slice.monitors).filter((id) => slice.monitors[id].status === 'running' && !running.has(slice.monitors[id].taskId))
          if (gone.length) {
            patch.monitors = { ...slice.monitors }
            for (const id of gone) patch.monitors[id] = { ...slice.monitors[id], status: 'completed' }
          }
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
        case 'result': {
          // A bg-subagent completion (`fromTaskNotification`) or a peer-woken turn (`fromPeer`)
          // arrives as its own result: cost is real (accrued below) but it's not the user's
          // turn ending, so it must not clear `busy`, release the queue, or trigger the
          // /rename rescan. Only a genuine user turn-end does those, or one of those turns
          // that took the user's message in (the CLI folds a message into a turn mid-way).
          const userEnd = endsUserTurn(e)
          if (userEnd) {
            // While `interrupting`, this is the interrupted turn's terminal result: it's the
            // only foreground turn outstanding (new prompts queue), so it can't be another
            // turn's. Swallow it (cost still accrues below) but treat it as the FIFO boundary.
            const wasInterrupting = slice.interrupting
            patch.interrupting = false
            patch.thinkingTokens = null
            patch.compacting = false
            patch.lastActivityMs = Date.now()
            if (e.sendNowPending) {
              // This is the turn a Send now cut; the sent message's own turn is still to come, so the
              // queue waits for that turn's end.
              patch.busy = true
              if (wasInterrupting || slice.turnStartMs === null) patch.turnStartMs = Date.now()
            } else {
              patch.busy = false
              patch.turnStartMs = null
              // A real turn boundary: if the user queued message(s) during this turn, release
              // the OLDEST now (FIFO). Dequeue it here and dispatch it after this set commits
              // (dispatch is async + re-sets busy; can't run inside the reducer). Remaining
              // queued messages wait for their own boundary.
              // A paused head waits for its review, and everything behind it waits too.
              if (slice.queuedMessages.length > 0 && !slice.queuedMessages[0].needsReview?.length) {
                const [next, ...rest] = slice.queuedMessages
                patch.queuedMessages = rest
                release.queued = { handleId, msg: next }
              }
            }
            // Matched at the command boundary (leading token only), so a mid-sentence
            // "/rename" or another command never triggers the re-scan. Skip when the turn was
            // interrupted: a stopped `/rename` didn't complete, so there's nothing to re-scan.
            if (!wasInterrupting) {
              const lastUser = slice.messages.findLast((m) => m.role === 'user')
              if (lastUser && /^\/rename(\s|$)/.test(lastUser.text.trim())) rescanSessions.needed = true
              // A resume mirrors customTitle within the first turn or two but emits no stream
              // event, so quiet-rescan the list while the title is still settling; later
              // changes ride the switch/liveIds refresh.
              if (slice.messages.filter((m) => m.role === 'user').length <= 3) rescanSessions.needed = true
            }
          }
          // `total_cost_usd` is the session's cumulative total (it runs up within an
          // invocation and, since CLI 2.1.277, carries across a --resume), so take it as
          // authoritative; accumulating double-counts every turn after the first. max()
          // guards a transient lower report (pre-seed / effort-respawn) and undefined
          // results (e.g. interrupted). The CLI persists it in the transcript (cost-state),
          // so a resume re-seeds from the scan. Re-verify across-resume on a CLI bump.
          if (typeof e.totalCostUsd === 'number') {
            patch.costUsd = Math.max(slice.costUsd ?? 0, e.totalCostUsd)
          }
          // Result arrives after the assistant text, so the turn's record goes on its last assistant
          // message. A turn that never reached Claude (a hook-blocked prompt) has no reply of its own,
          // and the previous turn's record must not be overwritten. Before a sent-now message's
          // turn its bubble is last, and this result belongs to the reply above it.
          const idx = e.sendNowPending
            ? messages.findLastIndex((m) => m.role === 'assistant' && !m.hookNotes)
            : messages.findLastIndex((m) => m.role === 'user' || (m.role === 'assistant' && !m.hookNotes))
          const host = messages[idx]
          const fresh = host?.role === 'assistant' && !host.turnEnd
          if (e.fromTaskNotification && !e.answersUser) {
            const ids = wakeCandidates(fresh ? host.wokenBy : undefined, slice.endedTasks, slice.monitors)
            if (ids.length) patch.monitors = countWake(slice.monitors, ids, e.usage)
          }
          if (fresh) {
            const started = userEnd ? slice.turnStartMs : null
            const turnEnd: TurnRecord = {
              reason: e.endReason,
              durationMs: e.durationMs ?? (started !== null && !e.localCommand ? Date.now() - started : undefined),
              ...(slice.turnTasks.length ? { bgTaskIds: slice.turnTasks } : {})
            }
            // A monitor guess made at the first block was wrong when the CLI says the turn came from elsewhere.
            const { wokenBy, ...rest } = host
            const guessed = !e.fromTaskNotification && !!wokenBy?.every((t) => t.kind === 'monitor' && t.status === 'running')
            messages[idx] = {
              ...(guessed ? rest : host),
              ...(e.usage ? { usage: e.usage } : {}),
              ...(e.denials?.length ? { denials: e.denials } : {}),
              turnEnd
            }
            // A call the turn left without a result ended with it: stopped only when the user ended
            // the turn, failed otherwise.
            const byUser = e.endReason?.kind === 'stopped' || e.endReason?.kind === 'cut'
            for (let i = idx; i >= 0 && messages[i].role === 'assistant'; i--) {
              const m = messages[i]
              if (m.tools.some((t) => t.result === undefined)) {
                const ended = byUser ? { stopped: true } : { isError: true }
                messages[i] = { ...m, tools: m.tools.map((t) => (t.result === undefined ? { ...t, result: '', ...ended } : t)) }
              }
            }
            const waiting = slice.turnTasks.filter((id) => slice.backgroundTasks[id]?.status === 'running').length
            // A Send now that landed after the turn's last step cut nothing, so that turn gets its own line.
            const line = e.endReason?.kind === 'cut' ? null : turnEndLine(turnEnd.reason, turnEnd.durationMs, waiting)
            if (e.endReason?.kind === 'cut') patch.statusAnnounce = toggled(CUT_FOR_MESSAGE)
            else if (line) patch.statusAnnounce = toggled(line.text.replace(/ · (.)/g, (_, c: string) => `, ${c.toLowerCase()}`))
            // Tasks that ended during this turn were this turn's news. A result with no reply of its own
            // (the CLI can open and drop a turn when two tasks end together) leaves them for the next.
            patch.endedTasks = EMPTY_WOKEN
          }
          patch.turnTasks = EMPTY_STRINGS
          if (Object.keys(slice.checkingTools).length) patch.checkingTools = EMPTY_CHECKING
          break
        }
        case 'error':
          // 'info' severity = transient status (e.g. "Reconnecting to exit ultracode…"
          // during an effort respawn) → top notice/toast, NOT the red in-chat error
          // box. It auto-clears on the next session-init after the respawn completes.
          if (e.severity === 'info') {
            topLevelNotice = { message: e.message, tone: 'warn' }
            break
          }
          // A launch that fails before the CLI ever initialized (model===null),
          // e.g. a missing workspace folder or a bad CLI path, will have its slice
          // dropped on the imminent process-exit, taking a per-slice lastError with
          // it. So surface it ONLY as the app-level notice (top banner, survives the
          // drop), NOT also as the in-chat error box, which would (a) duplicate the
          // message and (b) vanish with the slice anyway. A mid-session error (model
          // already set) shows in-chat as before.
          if (slice.model === null) topLevelNotice = { message: e.message, tone: 'error' }
          else patch.lastError = e.message
          break
        case 'process-exit':
          // A real exit (effort respawns are swallowed in the main process and
          // never reach here). Mark the session no-longer-live but keep its slice.
          patch.busy = false
          patch.interrupting = false
          patch.turnStartMs = null
          patch.thinkingTokens = null
          patch.compacting = false
          patch.exited = true
          patch.modStatus = EMPTY_MOD_STATUS
          // A monitor dies with its process, so its row stops claiming to watch.
          if (Object.values(slice.monitors).some((m) => m.status === 'running'))
            patch.monitors = Object.fromEntries(
              Object.entries(slice.monitors).map(([id, m]) => [id, m.status === 'running' ? { ...m, status: 'completed' } : m])
            )
          break
      }

      // A session that exits WITHOUT the CLI ever initializing THIS run is a
      // failed launch: ENOENT (bad CLI path) or a missing workspace folder. The
      // process never came up (model stays null until session-init), so there's no
      // live session to keep; drop the slice entirely instead of leaving a zombie
      // "exited" session that lingers in the store, mis-counts as live, and gets
      // picked as the fallback when another session closes, resurfacing its stale
      // error. The transcript (if any) is untouched on disk,
      // so it stays resumable from the sidebar once the folder is back.
      if (e.type === 'process-exit' && slice.model === null) {
        const next = { ...state.sessions }
        delete next[handleId]
        retireHandle(handleId)
        const active =
          state.activeHandleId === handleId
            ? (Object.values(next)
                .filter((s) => !s.exited)
                .sort((a, b) => b.lastActivityMs - a.lastActivityMs)[0]?.handleId ?? null)
            : state.activeHandleId
        // Preserve any notice the preceding error event set (don't clear it just
        // because the slice is being dropped, since that notice IS the explanation).
        return {
          sessions: next,
          activeHandleId: active,
          ...(active !== state.activeHandleId ? { viewingSubagent: null, subagentTrail: [], ...arriveWithPane(next, active, state.stageWide, surfacePaneShown(state)) } : {})
        }
      }

      if (touchesMessages(e.type)) patch.messages = messages
      return {
        ...top,
        sessions: { ...state.sessions, [handleId]: { ...slice, ...patch } },
        ...(topLevelNotice !== null ? { notice: topLevelNotice } : clearNotice ? { notice: null } : {})
      }
    })
    // A turn boundary released a queued message: dispatch it now (async; re-sets busy +
    // appends its bubble via dispatchTurn). Runs AFTER the reducer committed the dequeue,
    // so the queue and the new turn never race. Fire-and-forget (matches sendMessage).
    if (release.queued) {
      const { handleId: h, msg } = release.queued
      afterRefsChange(h)
      void dispatchTurn(set, h, msg.text, msg.attachments, msg.refs)
    }
    if (rescanSessions.needed) void get().refreshSessions(true)
    const limit = rateLimitSchedule.next
    if (limit) {
      clearTimeout(rateLimitTimers.get(handleId))
      rateLimitTimers.delete(handleId)
      // A limit can't outlast its reset, so a stale "can't respond" never sits there afterwards.
      if (limit.status !== 'allowed' && limit.resetsAt !== undefined) {
        const clear = (): void => {
          rateLimitTimers.delete(handleId)
          set((s) => (s.sessions[handleId]?.rateLimit === limit ? patchSlice(s, handleId, { rateLimit: null, rateLimitDismissed: false }) : {}))
        }
        const ms = limit.resetsAt * 1000 - Date.now()
        if (ms <= 0) clear()
        else rateLimitTimers.set(handleId, setTimeout(clear, Math.min(ms, 2 ** 31 - 1)))
      }
    }
    // A rename that arrived while this session was busy fires now that the turn is idle.
    const pendingName = pendingLiveRename.get(handleId)
    if (pendingName && !get().sessions[handleId]?.busy) {
      pendingLiveRename.delete(handleId)
      void window.clui.injectRename(handleId, pendingName)
    }
    // Side-effect, so it runs after the reducer commits, not inside the updater.
    if (flush.window) rememberModelPrefs(flush.window.sessionId, { contextWindow: flush.window.contextWindow })
    if (flush.prefs) {
      rememberModelPrefs(flush.prefs.sessionId, {
        model: flush.prefs.model,
        effort: flush.prefs.effort,
        ultracode: flush.prefs.ultracode
      })
    }
  },

  setNotice: (message, tone = 'warn') => set(() => ({ notice: { message, tone } })),
  dismissNotice: () => set(() => ({ notice: null })),
  dismissModToast: (id) => set((s) => ({ modToasts: s.modToasts.filter((t) => t.id !== id) })),
  dismissApiRetry: () =>
    set((s) => (s.activeHandleId ? patchSlice(s, s.activeHandleId, { apiRetryDismissed: true }) : {})),
  dismissRateLimit: () =>
    set((s) => (s.activeHandleId ? patchSlice(s, s.activeHandleId, { rateLimitDismissed: true }) : {})),
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
  closeSubagentView: () => set(() => ({ viewingSubagent: null, subagentTrail: [], currentTurn: null })),
  setPaneFull: (full) => {
    if (get().paneFull === full) return
    set({ paneFull: full })
    void window.clui.updateSettings({ subagentPaneFull: full })
  },
  setPrimaryScrolled: (scrolled) =>
    set((s) =>
      s.primaryScrolled === scrolled && s.primaryScrolledFor === s.activeHandleId
        ? s
        : { primaryScrolled: scrolled, primaryScrolledFor: s.activeHandleId }
    ),
  setSecondaryScrolled: (scrolled) =>
    set((s) => (s.secondaryScrolled === scrolled ? s : { secondaryScrolled: scrolled })),

  // Search UI. Find-in-conversation only makes sense over the live Virtuoso
  // transcript, so opening it is a no-op while viewing a subagent transcript.
  setFindOpen: (open) =>
    set((s) => (open && s.viewingSubagent ? {} : open ? { findOpen: true } : { findOpen: false, findActiveId: null })),
  setFindActiveId: (id) => set(() => ({ findActiveId: id })),
  setGlobalSearchOpen: (open) => set(() => ({ globalSearchOpen: open })),
  openSettings: (section: SettingsSection = 'general', sub?: SettingsSubs[keyof SettingsSubs]) =>
    set((s) => ({ settingsSection: section, settingsSub: { ...(s.settingsSection && s.settingsSub), ...(sub && { [section]: sub }) } })),
  closeSettings: () => set(() => ({ settingsSection: null })),
  requestScrollTo: (messageId, opts) =>
    set((s) => ({ scrollTarget: { messageId, nonce: (s.scrollTarget?.nonce ?? 0) + 1, align: opts?.align, flash: opts?.flash } })),
  setCurrentTurn: (v) => set({ currentTurn: v }),

  applyBrowserEvent: (handleId, e) => {
    switch (e.type) {
      case 'tab-state':
        set((s) => {
          const b = s.sessions[handleId]?.browser
          const cur = b?.tabs.find((t) => t.id === e.tab)
          if (!b || !cur) return {}
          const tabs = b.tabs.map((t) => (t === cur ? { ...t, ...e.patch } : t))
          const next = patchSlice(s, handleId, { browser: { ...b, tabs } })
          if (e.tab !== b.viewed) return next
          // The strip takes no focus when it appears, so it's said instead.
          const ask = e.patch.netAsk
          if (ask && ask !== cur.netAsk) return { ...next, browserAnnounce: toggled(`${ask} asks to use your local network. Allow or Block above the page.`) }
          const err = e.patch.loadError
          if (err && err !== cur.loadError) {
            const f = loadFailureOf(err)
            return { ...next, browserAnnounce: toggled(`${f.pre}${f.host ?? ''}${f.post}`) }
          }
          // The wall hides the page mid-drive, so it has to be said as well as shown.
          if (e.patch.loginWall !== 'hardware' || cur.loginWall === 'hardware') return next
          const text = 'This sign-in needs a hardware key or passkey. Open it in your regular browser.'
          return { ...next, browserAnnounce: toggled(text) }
        })
        break
      case 'tab-opened':
        set((s) => {
          const b = s.sessions[handleId]?.browser
          if (!b) return {}
          // A tab the renderer already has only moves the view.
          if (b.tabs.some((t) => t.id === e.tab.id)) return patchSlice(s, handleId, { browser: { ...b, viewed: e.viewed } })
          const tabs = [...b.tabs, e.tab]
          const agent = e.by === 'agent'
          const site = siteKeyOf(e.url ?? e.tab.url)
          const set0 = s.sessions[handleId].surfaces
          const id = placement(e.tab.id)
          // Claude's tab goes behind the active one, unseen; the user's own is the one they asked to see.
          const surfaces = agent
            ? { ...set0, browserUnseen: { ...set0.browserUnseen, [id]: true as const } }
            : { ...set0, order: [...set0.order, id], active: id }
          return patchSlice(s, handleId, {
            surfaces,
            browser: {
              ...b,
              tabs,
              viewed: e.viewed,
              multi: b.multi || tabs.length > 1,
              enter: agent ? [...b.enter, e.tab.id] : b.enter,
              announce: agent
                ? toggled(site ? `Claude opened tab ${e.tab.id}: ${site}` : `Claude opened tab ${e.tab.id}, a new page`)
                : b.announce
            }
          })
        })
        break
      case 'tab-closed':
        set((s) => {
          const b = s.sessions[handleId]?.browser
          if (!b) return {}
          const gone = b.tabs.find((t) => t.id === e.tab)
          const tabs = gone ? b.tabs.filter((t) => t !== gone) : b.tabs
          const browser = { ...b, tabs, viewed: e.viewed }
          if (!gone || e.by !== 'agent') return patchSlice(s, handleId, { browser })
          const cur = s.sessions[handleId]
          const after = placeBrowser({ ...cur, browser }).surfaces
          // The strip's live region goes with the pane, so the status region says this one.
          if (!after.order.length) return patchSlice(s, handleId, { browser, paneOpen: false, ...(cur.paneOpen ? said('Claude closed the last tab. Pane hidden.') : {}) })
          const say = (text: string): Partial<SessionStore> => patchSlice(s, handleId, { browser: { ...browser, announce: toggled(text) } })
          if (cur.surfaces.active !== placement(e.tab)) return say(`Claude closed tab ${e.tab}: ${siteKeyOf(gone.url) ?? 'New page'}`)
          const n = browserTabOf(after.active)
          const shown = n !== null ? tabs.find((t) => t.id === n) : undefined
          const tab = after.active ? after.tabs[after.active] : undefined
          const showing = shown ? `Showing tab ${shown.id}: ${siteKeyOf(shown.url) ?? 'New page'}` : tab ? `Showing ${surfaceLabel(tab)}` : ''
          return say(showing ? `Claude closed tab ${e.tab}. ${showing}` : `Claude closed tab ${e.tab}`)
        })
        break
      case 'tool-tab':
        set((s) => {
          const cur = s.sessions[handleId]
          const b = cur?.browser
          if (!b) return {}
          const id = placement(e.tab)
          const set0 = cur.surfaces
          const unseen = set0.active === id || set0.browserUnseen[id] ? set0 : { ...set0, browserUnseen: { ...set0.browserUnseen, [id]: true as const } }
          return patchSlice(s, handleId, { surfaces: unseen, browser: { ...b, toolTabs: { ...b.toolTabs, [e.toolUseId]: e.tab } } })
        })
        break
      case 'site-request':
        set((s) => {
          const cur = s.sessions[handleId]
          if (!cur) return {}
          return patchSlice(s, handleId, {
            pendingPermissions: [
              ...cur.pendingPermissions,
              {
                requestId: e.requestId,
                toolName: 'BrowserSite',
                displayName: e.site,
                description:
                  e.cause === 'page' ? 'This page wants to open this site in the browser pane.' : 'Claude wants to open this site in the browser pane.',
                input: { site: e.site, cause: e.cause, from: e.from }
              }
            ]
          })
        })
        break
      case 'login-request':
        set((s) => {
          const cur = s.sessions[handleId]
          if (!cur) return {}
          return patchSlice(s, handleId, {
            pendingPermissions: [
              ...cur.pendingPermissions,
              { requestId: e.requestId, toolName: 'BrowserLogin', displayName: e.request.site, input: e.request }
            ]
          })
        })
        break
      case 'filled':
        set(() => ({ browserAnnounce: toggled(`Clui filled your saved login for ${e.site}.`) }))
        break
    }
  },

  respondBrowserLogin: async (requestId, verdict) => {
    const active = activeSlice(get())
    if (!active) return
    set((s) =>
      patchSlice(s, active.handleId, {
        pendingPermissions: active.pendingPermissions.filter((p) => p.requestId !== requestId)
      })
    )
    await window.clui.browserLoginVerdict(active.handleId, requestId, verdict)
  },

  decideLocalNet: async (site, allow) => {
    try {
      await window.clui.browserLocalNetDecide(site, allow)
    } catch {
      set(() => ({ browserAnnounce: toggled(`Couldn't save your choice for ${site}. Try again.`) }))
      return false
    }
    const text = allow
      ? `Allowed ${site} to use your local network. Reloading.`
      : `Blocked ${site} from your local network. Change this in Settings → Pane → Browser.`
    set(() => ({ browserAnnounce: toggled(text) }))
    return true
  },
  announceBrowser: (text) => set({ browserAnnounce: toggled(text) }),

  respondElicitation: async (requestId, response) => {
    const active = activeSlice(get())
    if (!active) return
    set((s) =>
      patchSlice(s, active.handleId, {
        pendingPermissions: active.pendingPermissions.filter((p) => p.requestId !== requestId)
      })
    )
    await window.clui.respondElicitation(active.handleId, requestId, response)
  },

  setPane: (next) => {
    const s = get()
    const active = activeSlice(s)
    if (!active || (next !== 'collapsed' && !active.cwd)) return
    const open = next !== 'collapsed'
    // The subagent pane outranks the Surfaces pane in the Stage, so opening it closes the subagent view.
    const closeSubagent = open && !!s.viewingSubagent
    set({
      ...patchSlice(s, active.handleId, { paneOpen: open, ...(open ? { surfacePaneFull: next === 'full' } : {}) }),
      ...(closeSubagent ? { viewingSubagent: null, subagentTrail: [], currentTurn: null } : {})
    })
  },

  togglePane: (apply) => {
    const st = get()
    const active = activeSlice(st)
    if (!active) return
    const show = apply ?? st.setPane
    if (!st.viewingSubagent && active.paneOpen) {
      set((s) => patchSlice(s, active.handleId, { paneAutoOpenSuppressed: true, paneAutoOpen: false }))
      return show('collapsed')
    }
    const target = paneTarget(active)
    if (target) st.activateSurface(active.handleId, target)
    // A narrow Stage renders half as full, and keeps the user's choice for when it grows back.
    show(active.surfacePaneFull ? 'full' : 'half')
  },

  toggleBrowser: (apply) => {
    const st = get()
    const active = activeSlice(st)
    if (!active?.browser) return
    const onBrowser = !st.viewingSubagent && active.paneOpen && browserTabOf(active.surfaces.active) !== null
    if (!onBrowser) return void st.revealBrowser(null, apply)
    set((s) => patchSlice(s, active.handleId, { paneAutoOpenSuppressed: true, paneAutoOpen: false }))
    ;(apply ?? st.setPane)('collapsed')
  },

  revealBrowser: async (tab, apply) => {
    const active = activeSlice(get())
    if (!active?.browser) return
    const handleId = active.handleId
    const asked = tab !== null && active.browser.tabs.some((t) => t.id === tab) ? placement(tab) : null
    const id = asked ?? browserTargetOf(active)
    // Main's tab-opened event for the user's own tab places it and makes it active.
    if (id) get().activateSurface(handleId, id)
    else await window.clui.browserNewTab(handleId)
    const st = get()
    const now = st.sessions[handleId]
    if (!now || handleId !== st.activeHandleId || (now.paneOpen && !st.viewingSubagent)) return
    ;(apply ?? st.setPane)(now.surfacePaneFull ? 'full' : 'half')
  },

  autoOpenPane: (handleId, id) => {
    const s = get()
    const slice = s.sessions[handleId]
    if (!slice || slice.paneOpen || slice.paneAutoOpenSuppressed || !slice.surfaces.order.includes(id)) return false
    const tab = browserTabOf(id)
    const view = (): void => {
      if (tab !== null && slice.browser?.viewed !== tab) void window.clui.browserViewTab(handleId, tab)
    }
    // A background session waits for its next visit, which judges the Stage as it is then.
    if (handleId !== s.activeHandleId) {
      set(patchSlice(s, handleId, { paneAutoOpen: true, ...activation(slice, id, Date.now()) }))
      view()
      return false
    }
    if (s.viewingSubagent || !s.stageWide) return false
    const shown = activation(slice, id, Date.now())
    set({ ...patchSlice(s, handleId, { ...shown, paneAutoOpen: false, ...said(shownCopy({ ...slice, ...shown }, id, true)) }), paneOpenedQuietly: true })
    view()
    return true
  },

  openSurface: (handleId, spec, intent, actor, openedBy) => {
    const browserTab = spec.kind === 'browser' ? spec.tab : null
    // One resource gets one tab, so a page Claude made opens as its artifact tab, never a second file tab.
    const made = spec.kind === 'file' ? Object.values(get().sessions[handleId]?.surfaces.tabs ?? {}).find((t) => t.kind === 'artifact' && t.key === spec.key) : undefined
    const id = spec.kind === 'browser' ? placement(spec.tab) : (made?.id ?? surfaceIdOf(spec))
    // Chosen before the open, so neither the tab being opened nor the one Claude is about to show can go.
    if (spec.kind !== 'browser' && !get().sessions[handleId]?.surfaces.tabs[id]) evictFor(get, set, handleId, id)
    const s = get()
    const cur = s.sessions[handleId]
    // A browser placement exists only for a tab main has.
    if (!cur || (browserTab !== null && !cur.surfaces.order.includes(id))) return id
    const now = Date.now()
    const set0 = cur.surfaces
    const viewed = handleId === s.activeHandleId
    const showing = viewed && cur.paneOpen && !s.viewingSubagent
    let eff = intent
    if (actor === 'claude' && intent === 'focus') {
      const onBrowser = browserTabOf(set0.active) !== null
      const held =
        (viewed && (!!s.viewingSubagent || s.settingsSection !== null)) ||
        cur.pendingPermissions.length > 0 ||
        cur.annotate.tab !== null ||
        (showing && focusInPane(onBrowser))
      const recent = showing && set0.active !== id && now - paneInputAt < PANE_RECENT_MS
      if (held || recent) eff = 'prepare'
    }
    let placed = cur
    let fresh = false
    let located = false
    if (spec.kind === 'browser') {
      if (eff === 'prepare') {
        if (set0.active !== id) set(patchSlice(s, handleId, { surfaces: { ...set0, browserUnseen: { ...set0.browserUnseen, [id]: true } } }))
        return id
      }
    } else {
      const existing = set0.tabs[id]
      const base: SurfaceTab = existing
        ? { ...existing, title: spec.title }
        : { id, kind: spec.kind, key: spec.key, title: spec.title, openedBy, openedAt: now, lastViewedAt: now, ...(spec.mode ? { mode: spec.mode } : {}), ...(spec.provenance ? { provenance: spec.provenance } : {}) }
      const dest = { ...(spec.location ? { location: spec.location } : {}), ...(spec.highlight ? { highlight: spec.highlight } : {}) }
      const order = existing ? set0.order : [...set0.order, id]
      if (eff === 'prepare') {
        // The active tab keeps its view until the user asks for the new destination.
        const tab: SurfaceTab =
          set0.active === id
            ? { ...base, ...(Object.keys(dest).length ? { pendingShow: dest } : {}) }
            : { ...base, ...dest, unseen: true }
        set(patchSlice(s, handleId, { surfaces: { ...set0, order, tabs: { ...set0.tabs, [id]: tab } } }))
        return id
      }
      placed = { ...cur, surfaces: { ...set0, order, tabs: { ...set0.tabs, [id]: { ...base, ...dest } } } }
      fresh = !existing
      located = !!spec.location
    }
    const activeNow = activation(placed, id, now, located)
    if (browserTab !== null && cur.browser?.viewed !== browserTab) void window.clui.browserViewTab(handleId, browserTab)
    if (showing || (!viewed && cur.paneOpen)) {
      const moved = showing && actor === 'claude' && (set0.active !== id || located)
      set(patchSlice(s, handleId, { ...activeNow, ...(moved ? said(shownCopy({ ...placed, ...activeNow }, id, fresh)) : {}) }))
    } else if (actor === 'user') {
      // An explicit user open outranks the subagent takeover.
      set({ ...patchSlice(s, handleId, { ...activeNow, paneOpen: true }), ...(viewed ? { viewingSubagent: null, subagentTrail: [], currentTurn: null } : {}) })
    } else if (cur.paneAutoOpenSuppressed || (viewed && (!!s.viewingSubagent || !s.stageWide))) {
      set(patchSlice(s, handleId, activeNow))
    } else if (!viewed) {
      set(patchSlice(s, handleId, { ...activeNow, paneAutoOpen: true }))
    } else {
      set({ ...patchSlice(s, handleId, { ...activeNow, paneOpen: true, ...said(shownCopy({ ...placed, ...activeNow }, id, true)) }), paneOpenedQuietly: true })
    }
    return id
  },

  closeSurface: (handleId, id) => {
    const s = get()
    const cur = s.sessions[handleId]
    if (!cur?.surfaces.order.includes(id)) return
    const set0 = cur.surfaces
    const order = set0.order.filter((x) => x !== id)
    const next = set0.active === id ? neighbourOf(set0.order, id, order) : set0.active
    // Auto-open isn't suppressed: the user closed a tab, not the pane, so Claude opening one later still shows it.
    const emptied = order.length ? {} : { paneOpen: false, ...(cur.paneOpen ? said('Closed the last tab. Pane hidden.') : {}) }
    const tab = browserTabOf(id)
    const b = cur.browser
    if (tab !== null && b) {
      // Main views the neighbouring browser tab the same way, right first, so this agrees with its event.
      const i = b.tabs.findIndex((t) => t.id === tab)
      const after = b.tabs[i + 1] ?? b.tabs[i - 1]
      const browser = { ...b, tabs: b.tabs.filter((t) => t.id !== tab), viewed: b.viewed === tab ? (after?.id ?? b.viewed) : b.viewed }
      set(patchSlice(s, handleId, { browser, surfaces: { ...set0, active: next }, ...emptied }))
      void window.clui.browserCloseTab(handleId, tab)
    } else {
      const { [id]: _gone, ...tabs } = set0.tabs
      set(patchSlice(s, handleId, { surfaces: { ...set0, order, active: next, tabs }, ...emptied }))
    }
    const st = get()
    const now = st.sessions[handleId]
    if (next && now?.surfaces.active === next && next !== set0.active) st.activateSurface(handleId, next)
  },

  activateSurface: (handleId, id) => {
    const s = get()
    const cur = s.sessions[handleId]
    if (!cur?.surfaces.order.includes(id)) return
    set(patchSlice(s, handleId, activation(cur, id, Date.now())))
    const tab = browserTabOf(id)
    if (tab !== null && cur.browser?.viewed !== tab) void window.clui.browserViewTab(handleId, tab)
  },

  reopenEvicted: (id) => {
    const card = get().evictedTabs.find((c) => c.id === id)
    if (!card) return
    set((s) => ({ evictedTabs: s.evictedTabs.filter((c) => c.id !== id) }))
    const { handleId, index } = card
    // Its view state comes back; a destination it was sent to before doesn't run again.
    const { location: _l, highlight: _h, pendingShow: _p, unseen: _u, ...tab } = card.tab
    if (!get().sessions[handleId]) return
    if (!get().sessions[handleId].surfaces.tabs[tab.id]) {
      evictFor(get, set, handleId, tab.id)
      set((s) => {
        const set0 = s.sessions[handleId].surfaces
        const order = set0.order.toSpliced(Math.min(index, set0.order.length), 0, tab.id)
        return patchSlice(s, handleId, { surfaces: { ...set0, order, tabs: { ...set0.tabs, [tab.id]: tab } } })
      })
    }
    get().openSurface(handleId, { kind: tab.kind, key: tab.key, title: tab.title, provenance: tab.provenance }, 'focus', 'user', 'user')
  },

  setSurfaceView: (handleId, id, patch) => {
    const s = get()
    const set0 = s.sessions[handleId]?.surfaces
    const tab = set0?.tabs[id]
    if (!set0 || !tab || (patch.viewState && patch.viewState.kind !== tab.kind)) return
    set(patchSlice(s, handleId, { surfaces: { ...set0, tabs: { ...set0.tabs, [id]: { ...tab, ...patch } } } }))
  },

  browserDrive: async (action) => {
    const active = activeSlice(get())
    if (!active?.browser) return
    const all = action === 'stop' || action === 'reset'
    await window.clui.browserDrive(active.handleId, action, all ? undefined : active.browser.viewed)
    // Halt the turn too, or Claude reads the stop text and tries another route.
    if (action === 'stop') await get().interrupt()
  },

  applyAnnotateEvent: (handleId, e) => {
    const a = get().sessions[handleId]?.annotate
    if (!a) return
    const put = (next: Partial<AnnotateDraft>, say: string): void =>
      set((s) => {
        const cur = s.sessions[handleId]?.annotate
        return cur ? { ...patchSlice(s, handleId, { annotate: { ...cur, ...next } }), browserAnnounce: toggled(say) } : {}
      })
    switch (e.type) {
      case 'on':
        return put({ tab: e.tab, note: null }, 'Pointing on.')
      case 'off': {
        const n = get().sessions[handleId]?.contextRefs.filter((d) => d.ref.kind === 'browser').length ?? 0
        const say =
          e.why === 'driving' ? 'Pointing off, Claude is using this tab.' : n ? `Pointing off. ${n} element${n === 1 ? '' : 's'} in the message.` : 'Pointing off.'
        return put({ tab: null, note: null }, say)
      }
      case 'pinned': {
        const r = get().addRef(handleId, { kind: 'browser', pin: e.pin }, { visual: e.crop ?? undefined, pinId: e.pinId })
        if (r.status === 'added') {
          const slice = get().sessions[handleId]
          const n = (slice && refsOf(slice, slice.referenceEditTarget)?.findIndex((d) => d.ref.id === r.id)) ?? -1
          const { kind, name } = pinWords(e.pin.target)
          return put({ note: null }, `Pinned ${n + 1}: ${kind}${name ? ` ${clipName(name)}` : ''}.`)
        }
        // Main drew the outline before asking; the forced sync takes it down again.
        afterRefsChange(handleId, true)
        if (r.status === 'cap') return put({ note: CAP_NOTE }, CAP_NOTE)
        if (r.status === 'duplicate') return put({ note: null }, 'Already attached.')
        return put({ note: REFUSED.failed }, REFUSED.failed)
      }
      case 'refused':
        put({ note: REFUSED[e.why] }, REFUSED[e.why])
        break
      case 'gone': {
        const slice = get().sessions[handleId]
        if (!slice) return
        const all = [slice.contextRefs, ...slice.queuedMessages.map((q) => q.refs)].flat()
        const ids = new Set(all.flatMap((d) => (d.ref.kind === 'browser' && d.ref.pin.source.tabId === e.tab ? [resourceOf(d.ref)] : [])))
        for (const id of ids) get().invalidateSource(handleId, id, { reason: e.reason })
        return
      }
    }
    // A refusal note gives way to the hint after a few seconds (the next pin clears it sooner): Chromium's
    // inspect mode reports no hover, so moving on can't be seen. The cap note stays until there's room.
    if (e.type === 'refused' && e.why !== 'cap') {
      const note = REFUSED[e.why]
      setTimeout(() => {
        const a = get().sessions[handleId]?.annotate
        if (a?.note === note) set((s) => patchSlice(s, handleId, { annotate: { ...a, note: null } }))
      }, 3000)
    }
  },

  toggleAnnotate: () => {
    const active = activeSlice(get())
    const tab = viewedTabOf(active?.browser)
    if (!active || !tab) return
    if (tab.drive === 'driving') {
      // A shortcut that does nothing reads as broken, so say why, and leave the note on the strip briefly.
      const handleId = active.handleId
      set((s) => ({
        ...patchSlice(s, handleId, { annotate: { ...active.annotate, note: DRIVING_NOTE } }),
        browserAnnounce: toggled(`Claude is using this tab. ${DRIVING_NOTE}`)
      }))
      setTimeout(() => {
        const a = get().sessions[handleId]?.annotate
        if (a?.note === DRIVING_NOTE) set((s) => patchSlice(s, handleId, { annotate: { ...a, note: null } }))
      }, 3000)
      return
    }
    void window.clui.browserAnnotate(active.handleId, tab.id, active.annotate.tab !== tab.id)
  },

  addRef: (handleId, input, opts) => {
    const slice = get().sessions[handleId]
    if (!slice || !isRefInput(input)) return { status: 'invalid' }
    const target = opts?.target === undefined ? slice.referenceEditTarget : opts.target
    const refs = refsOf(slice, target)
    if (!refs) return { status: 'invalid' }
    const key = refKey(input as ContextReference)
    const dup = refs.find((d) => refKey(d.ref) === key)
    if (dup) return { status: 'duplicate', id: dup.ref.id, key }
    if (refs.length >= MAX_REFS) return { status: 'cap' }
    const bytes = input.kind === 'change' ? opts?.bytes : undefined
    if (input.kind === 'change') {
      if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > CHANGE_BYTES_MAX) return { status: 'invalid' }
      if (refs.reduce((n, d) => n + (d.bytes ?? 0), bytes) > CHANGE_TEXT_BUDGET) return { status: 'budget' }
    }
    const id = `r${++refSeq}`
    // Reselection clears the notice. A page's next document has a new docId, so a pick in the same tab counts.
    const resource = resourceOf(input as ContextReference)
    const same = (k: string): boolean => k === resource || (input.kind === 'browser' && k.startsWith(`browser:${input.pin.source.tabId}:`))
    const hit = target === null ? Object.keys(slice.referenceNotices).filter(same) : []
    // Reselecting after a change brings back the note the removed reference carried.
    const note = input.note ?? hit.flatMap((k) => slice.referenceNotices[k].removed).find((r) => r.note)?.note
    const ref = { ...input, id, ...(note === undefined ? {} : { note }) } as ContextReference
    const d: DraftReference = {
      ref,
      ...(opts?.visual ? { visual: opts.visual } : {}),
      ...(opts?.pinId === undefined ? {} : { pinId: opts.pinId }),
      ...(bytes === undefined ? {} : { bytes })
    }
    const notices = hit.length ? Object.fromEntries(Object.entries(slice.referenceNotices).filter(([k]) => !same(k))) : null
    set((s) => patchSlice(s, handleId, { ...withRefs(slice, target, [...refs, d]), ...(notices ? { referenceNotices: notices } : {}) }))
    afterRefsChange(handleId)
    return { status: 'added', id }
  },

  removeRef: (handleId, id, target) => {
    const slice = get().sessions[handleId]
    if (!slice) return
    const t = target === undefined ? slice.referenceEditTarget : target
    const refs = refsOf(slice, t)
    if (!refs?.some((d) => d.ref.id === id)) return
    set((s) => patchSlice(s, handleId, withRefs(slice, t, refs.filter((d) => d.ref.id !== id))))
    afterRefsChange(handleId)
  },

  setRefNote: (handleId, id, note, target) => {
    const slice = get().sessions[handleId]
    const refs = slice && refsOf(slice, target)
    if (!refs?.some((d) => d.ref.id === id)) return
    const next = refs.map((d) => {
      if (d.ref.id !== id) return d
      const ref = { ...d.ref }
      if (note) ref.note = note.slice(0, REF_NOTE_MAX)
      else delete ref.note
      return { ...d, ref }
    })
    set((s) => patchSlice(s, handleId, withRefs(slice, target, next)))
  },

  moveRef: (handleId, id, delta, target) => {
    const slice = get().sessions[handleId]
    if (!slice) return
    const t = target === undefined ? slice.referenceEditTarget : target
    const refs = refsOf(slice, t)
    const i = refs?.findIndex((d) => d.ref.id === id) ?? -1
    const j = i + delta
    if (!refs || i < 0 || j < 0 || j >= refs.length) return
    const next = [...refs]
    ;[next[i], next[j]] = [next[j], next[i]]
    set((s) => patchSlice(s, handleId, withRefs(slice, t, next)))
    afterRefsChange(handleId)
  },

  clearRefs: (handleId, ids) => {
    const slice = get().sessions[handleId]
    if (!slice || !ids.length) return
    const gone = new Set(ids)
    const next = slice.contextRefs.filter((d) => !gone.has(d.ref.id))
    if (next.length === slice.contextRefs.length) return
    set((s) => patchSlice(s, handleId, { contextRefs: next.length ? next : EMPTY_REFS }))
    afterRefsChange(handleId)
  },

  dismissReferenceNotice: (handleId, resourceId) => {
    const slice = get().sessions[handleId]
    if (!slice?.referenceNotices[resourceId]) return
    const notices = Object.fromEntries(Object.entries(slice.referenceNotices).filter(([k]) => k !== resourceId))
    set((s) => patchSlice(s, handleId, { referenceNotices: notices }))
  },

  invalidateSource: (handleId, resourceId, cause) => {
    const slice = get().sessions[handleId]
    if (!slice) return 0
    const stale = (r: ContextReference): boolean => {
      if (r.kind === 'change') return resourceId === CHANGE_REFS && (cause.reason === 'denied' || cause.reason === 'session')
      if (resourceOf(r) !== resourceId) return false
      if (r.kind === 'browser') return true
      if (r.kind === 'file' && r.lines) return cause.reason !== 'changed' || r.sourceVersion !== cause.version
      // Whole files and folders point at current content, so only losing access removes them.
      return cause.reason === 'denied' || cause.reason === 'session'
    }
    const lostDraft = slice.contextRefs.filter((d) => stale(d.ref))
    let removed = lostDraft.length
    const said: string[] = []
    const queue = slice.queuedMessages.map((q) => {
      const lost = q.refs.filter((d) => stale(d.ref))
      if (!lost.length) return q
      removed += lost.length
      const recs = invalidations(lost.map((d) => ({ ref: d.ref, reason: cause.reason })))
      said.push(`Paused. ${recs.map(pausedText).join(' ')}`)
      return { ...q, refs: q.refs.filter((d) => !stale(d.ref)), needsReview: [...(q.needsReview ?? []), ...recs] }
    })
    if (!removed) return 0
    const patch: Partial<PerSessionState> = { queuedMessages: queue }
    if (lostDraft.length) {
      const [rec] = invalidations(lostDraft.map((d) => ({ ref: d.ref, reason: cause.reason })))
      const had = slice.referenceNotices[rec.resourceId]
      patch.contextRefs = slice.contextRefs.filter((d) => !stale(d.ref))
      patch.referenceNotices = { ...slice.referenceNotices, [rec.resourceId]: had ? { ...rec, removed: [...had.removed, ...rec.removed] } : rec }
      said.unshift(removalSpoken(lostDraft.map((d) => d.ref), cause.reason))
    }
    // A selection that went into a message clears on any change; the File tab shows none.
    const gone = new Set(
      [lostDraft, ...slice.queuedMessages.map((q) => q.refs.filter((d) => stale(d.ref)))]
        .flat()
        .flatMap((d) => (d.ref.kind === 'file' && d.ref.lines ? [`${d.ref.path}\0${d.ref.lines.start}-${d.ref.lines.end}`] : []))
    )
    const tabs = slice.surfaces.tabs
    const sel = (t: SurfaceTab): string | null => (t.kind === 'file' && t.selection?.lines ? `${t.key}\0${t.selection.lines.start}-${t.selection.lines.end}` : null)
    const cleared = Object.values(tabs).filter((t) => gone.has(sel(t) ?? ''))
    if (cleared.length) patch.surfaces = { ...slice.surfaces, tabs: { ...tabs, ...Object.fromEntries(cleared.map((t) => [t.id, { ...t, selection: undefined }])) } }
    patch.refAnnounce = toggled(said.join(' '))
    set((s) => patchSlice(s, handleId, patch))
    afterRefsChange(handleId)
    return removed
  },

  setReferenceEditTarget: (handleId, target) => {
    const slice = get().sessions[handleId]
    if (!slice || slice.referenceEditTarget === target || (target !== null && !refsOf(slice, target))) return
    set((s) => patchSlice(s, handleId, { referenceEditTarget: target }))
    afterRefsChange(handleId)
  },

  acceptReview: async (handleId, queueId) => {
    const q = get().sessions[handleId]?.queuedMessages.find((m) => m.id === queueId)
    if (!q) return false
    let invalid: RefInvalid[]
    try {
      invalid = await window.clui.validateRefs(handleId, q.refs.map((d) => ({ ref: d.ref })))
    } catch {
      return false
    }
    const slice = get().sessions[handleId]
    const item = slice?.queuedMessages.find((m) => m.id === queueId)
    if (!slice || !item) return false
    const bad = new Map(invalid.map((x) => [x.id, x.reason]))
    const lost = item.refs.flatMap((d) => (bad.has(d.ref.id) ? [{ ref: d.ref, reason: bad.get(d.ref.id)! }] : []))
    if (lost.length) {
      const recs = invalidations(lost)
      const next = { ...item, refs: item.refs.filter((d) => !bad.has(d.ref.id)), needsReview: [...(item.needsReview ?? []), ...recs] }
      set((s) => patchSlice(s, handleId, { queuedMessages: slice.queuedMessages.map((m) => (m.id === queueId ? next : m)), refAnnounce: toggled(`Paused. ${recs.map(pausedText).join(' ')}`) }))
      afterRefsChange(handleId)
      return false
    }
    const { needsReview: _, ...ready } = item
    const head = slice.queuedMessages[0]?.id === queueId
    const release = head && !slice.busy && !slice.interrupting
    set((s) =>
      patchSlice(s, handleId, {
        queuedMessages: release ? slice.queuedMessages.slice(1) : slice.queuedMessages.map((m) => (m.id === queueId ? ready : m)),
        ...(slice.referenceEditTarget === queueId ? { referenceEditTarget: null } : {})
      })
    )
    afterRefsChange(handleId)
    if (release) void dispatchTurn(set, handleId, ready.text, ready.attachments, ready.refs)
    return true
  },

  carryRefs: async (handleId, refs) => {
    if (!refs.length) return
    // A page pin belongs to the old session's browser and a change ref to its grants; both stayed with it.
    const moves = (d: DraftReference): boolean => d.ref.kind !== 'browser' && d.ref.kind !== 'change'
    const paths = refs.filter(moves)
    let invalid: RefInvalid[] = []
    try {
      if (paths.length) invalid = await window.clui.validateRefs(handleId, paths.map((d) => ({ ref: d.ref })))
    } catch {
      invalid = paths.map((d) => ({ id: d.ref.id, reason: 'denied' }))
    }
    const bad = new Map(invalid.map((x) => [x.id, x.reason]))
    const lost = refs.flatMap((d): { ref: ContextReference; reason: RefFailure | 'session' }[] =>
      !moves(d) ? [{ ref: d.ref, reason: 'session' }] : bad.has(d.ref.id) ? [{ ref: d.ref, reason: bad.get(d.ref.id)! }] : []
    )
    const kept = refs.filter((d) => moves(d) && !bad.has(d.ref.id)).map(({ ref }) => ({ ref }))
    const slice = get().sessions[handleId]
    if (!slice) return
    const notices = { ...slice.referenceNotices, ...Object.fromEntries(invalidations(lost).map((n) => [n.resourceId, n])) }
    set((s) => patchSlice(s, handleId, { contextRefs: [...slice.contextRefs, ...kept].slice(0, MAX_REFS), ...(lost.length ? { referenceNotices: notices } : {}) }))
    afterRefsChange(handleId)
  },

  announceRefs: (handleId, text) => set((s) => patchSlice(s, handleId, { refAnnounce: toggled(text) })),
  announceStatus: (handleId, text) => set((s) => patchSlice(s, handleId, said(text))),

  viewBrowserTab: (tab) => {
    const s = get()
    if (s.activeHandleId) s.activateSurface(s.activeHandleId, placement(tab))
  },

  newBrowserTab: async () => {
    const active = activeSlice(get())
    if (!active?.browser) return
    await window.clui.browserNewTab(active.handleId)
  }
}))
