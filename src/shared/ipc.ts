/**
 * The typed contract exposed by the preload bridge (`window.clui`).
 *
 * Renderer → main calls are Promise-returning methods. Main → renderer streaming
 * happens via `onSessionEvent`, which delivers `DomainEvent`s tagged with the
 * session id they belong to.
 */
import type { DomainEvent } from './events'
import type {
  ProjectGroup,
  TranscriptResult,
  SearchResults,
  SearchOptions,
  WorkspaceOption
} from './sessions'
import type { ConfigBundle } from './config'
import type {
  CluiSettings,
  EffortChoice,
  ModelChoice,
  ResolvedSettings,
  SettingsKey
} from './settings'

/** Options for starting a new Claude session. */
export interface StartSessionOptions {
  /** Absolute path to the workspace folder the session runs in. */
  cwd: string
  /** Resume an existing session id instead of starting fresh. */
  resumeSessionId?: string
  /**
   * Fork from `resumeSessionId` instead of resuming it — passes `--fork-session`
   * so the CLI branches to a NEW session id carrying the full context, leaving the
   * original jsonl untouched. Only meaningful with `resumeSessionId`. Fork-from-HEAD
   * (whole-session duplicate) — never a mid-conversation truncation (that would desync
   * from files on disk). Verified live 2.1.216.
   */
  fork?: boolean
  /**
   * Per-session permission mode override. If omitted, the global Settings default
   * is used. 'inherit' means pass no --permission-mode (honor ~/.claude/settings.json).
   */
  permissionMode?: PermissionModeChoice
  /** Per-session model choice. If omitted, the global Settings default is used. */
  model?: ModelChoice
  /** Per-session effort choice. If omitted, the global Settings default is used. */
  effort?: EffortChoice
  /** Ultracode on for this session (xhigh + workflow orchestration). Default false. */
  ultracode?: boolean
}

/** Permission-mode choices selectable per session. Aliased to the settings union so the
 *  two can't drift — one canonical list, kept honest by the `PERMISSION_MODE_*` Record
 *  maps in settings.ts (which compile-error on a missing arm). */
export type PermissionModeChoice = CluiSettings['permissionMode']

/** Result of starting a session: our local handle for it. */
export interface StartSessionResult {
  /** App-local id used to route events/sends before the CLI session id is known. */
  handleId: string
}

/**
 * The minimal attachment payload that crosses the wire to the CLI:
 * only the media type + raw base64 bytes (NO `data:...;base64,` prefix) or inlined text
 * cross IPC — renderer-only display metadata (thumbnail, size, dims) never does, keeping
 * the (already large) base64 from being duplicated across the bridge. Covers the three
 * content-block kinds the CLI's duplex stream-json user turn accepts (all three VERIFIED
 * live on 2.1.209):
 *  - `image`    → `{type:'image',    source:{type:'base64', media_type, data}}`
 *  - `document` → `{type:'document', source:{type:'base64', media_type:'application/pdf', data}}`
 *  - `text`     → an inlined text block (a dropped text file's decoded contents,
 *                 wrapped so the model knows the filename — mechanically identical to
 *                 a paste, so it works regardless of the workspace-cwd Read boundary).
 */
export type WireAttachment =
  | { kind: 'image'; mediaType: string; data: string }
  | { kind: 'document'; mediaType: string; data: string }
  | { kind: 'text'; name: string; text: string }

/** A user's answer to a permission request. */
export type PermissionVerdict =
  | { requestId: string; behavior: 'allow'; updatedInput: unknown }
  | { requestId: string; behavior: 'deny'; message: string }

/** A domain event tagged with the session handle it belongs to. */
export interface TaggedEvent {
  handleId: string
  event: DomainEvent
}

/** Detected CLI binary info shown in Settings. */
export interface CliInfo {
  path: string | null
  version: string | null
  source: 'settings' | 'login-shell' | 'common-path' | 'not-found'
}

export interface CluiApi {
  /** Pick a workspace folder via the native dialog. Returns null if cancelled. */
  pickWorkspace: () => Promise<string | null>
  /** Detect / report the claude CLI binary. */
  getCliInfo: () => Promise<CliInfo>
  /** Start a session; returns a local handle. */
  startSession: (opts: StartSessionOptions) => Promise<StartSessionResult>
  /**
   * Send a user message into a running session. `attachments` inlines
   * image/document/text content blocks alongside the text; omit for a plain
   * text turn.
   */
  sendMessage: (handleId: string, text: string, attachments?: WireAttachment[]) => Promise<void>
  /** Interrupt the current turn. */
  interrupt: (handleId: string) => Promise<void>
  /** Change a running session's permission mode mid-session (per-session only). */
  setPermissionMode: (handleId: string, mode: PermissionModeChoice) => Promise<void>
  /** Change a running session's model live (per-session only). */
  setModel: (handleId: string, model: ModelChoice) => Promise<void>
  /** Change a running session's effort (respawns via --resume; per-session only). */
  setEffort: (handleId: string, effort: EffortChoice) => Promise<void>
  /** Toggle ultracode (xhigh + workflow orchestration) live for a session. */
  setUltracode: (handleId: string, on: boolean) => Promise<void>
  /** Stop and clean up a session's process. */
  stopSession: (handleId: string) => Promise<void>
  /** Answer a pending interactive permission request. */
  respondPermission: (handleId: string, verdict: PermissionVerdict) => Promise<void>
  /** List past sessions grouped by project. */
  listSessions: () => Promise<ProjectGroup[]>
  /** Delete a past session's transcript. */
  deleteSession: (projectSlug: string, id: string) => Promise<void>
  /** Rename a past session via the sidecar map. Empty name clears it. */
  renameSession: (id: string, name: string) => Promise<void>
  /** Read a session's transcript for rendering resumed history (display-only). */
  readTranscript: (sessionId: string) => Promise<TranscriptResult>
  /** Global content search across all on-disk sessions. `queryId` is a monotonic
   *  token for latest-wins cancellation (renderer drops results whose id is stale).
   *  `opts` carries the scope (workspace slug) + role (userOnly) facets. */
  searchSessions: (query: string, queryId: number, opts?: SearchOptions) => Promise<SearchResults>
  /** The workspaces (with session counts) for the search scope dropdown. */
  listWorkspaces: () => Promise<WorkspaceOption[]>
  /** Export a session to Markdown via a native Save dialog. Returns the saved
   *  file path, or null if the user cancelled. Reads the jsonl directly (no resume). */
  exportSession: (sessionId: string) => Promise<string | null>
  /** Pre-populate the search content cache (called when the search overlay opens,
   *  so the first query is warm). No matching — just parse-into-cache. Fire-and-forget. */
  warmSearchCache: () => Promise<void>
  /** Read a workflow/subagent agent transcript by agentId (from disk; the live
   *  stream doesn't carry it). Empty if not found (still streaming / layout drift). */
  readAgentTranscript: (agentId: string) => Promise<TranscriptResult>
  /** Nesting: read a subagent transcript by its Agent tool_use_id (via the
   *  .meta.json sidecar) — for NESTED children whose taskId the UI never learns and
   *  whose text `forwardSubagentText` doesn't stream (it forwards only one level deep). */
  readAgentTranscriptByToolUseId: (toolUseId: string) => Promise<TranscriptResult>
  /** Load the persisted per-session cost map (sessionId → cumulative USD). */
  getSessionCosts: () => Promise<Record<string, number>>
  /** Persist one session's cumulative cost to the sidecar. */
  setSessionCost: (sessionId: string, usd: number) => Promise<void>
  /** Remove one session's persisted cost (on permanent delete). */
  deleteSessionCost: (sessionId: string) => Promise<void>
  /** Load the per-session model+effort map (sessionId → {model,effort}). Passed as
   *  --model/--effort on resume so a mid-session switch survives (the CLI otherwise
   *  reverts to the settings.json default on --resume). */
  getSessionModels: () => Promise<Record<string, { model?: string; effort?: string; ultracode?: boolean }>>
  /** Persist one session's model/effort (merges provided fields). */
  setSessionModel: (sessionId: string, prefs: { model?: string; effort?: string; ultracode?: boolean }) => Promise<void>
  /** Remove one session's persisted model/effort (on permanent delete). */
  deleteSessionModel: (sessionId: string) => Promise<void>
  /** Read the Customizations bundle (agents/skills/hooks/mcp) for a workspace. */
  readConfig: (cwd: string | null) => Promise<ConfigBundle>
  /** Open a file in the configured editor. */
  openInEditor: (filePath: string) => Promise<void>
  /** Open an http(s) URL in the user's default browser (markdown links). */
  openExternal: (url: string) => Promise<void>
  /** Given a list of paths, return only those that still exist on disk — used to
   *  prune the changed-files list when a file is deleted (even by the agent). */
  filterExistingFiles: (paths: string[]) => Promise<string[]>
  /** List files under a workspace (git-aware; relative paths, capped) for the
   *  composer's @-file picker. Returns [] on error. */
  listWorkspaceFiles: (cwd: string) => Promise<{ files: string[]; truncated: boolean }>
  /** Open a two-file diff in the configured editor. */
  openDiff: (left: string, right: string) => Promise<void>
  /**
   * Read app settings: resolved values plus per-key provenance. A key with source
   * 'override' is in Clui's own settings.json; 'cli' is inherited from
   * ~/.claude/settings.json (model/effort only); 'default' is the bundled constant.
   */
  getSettings: () => Promise<ResolvedSettings>
  /**
   * Persist a patch and/or CLEAR keys back to inherited, returning the new resolved
   * state. Only values that differ from what the key would inherit are written, so
   * saving the Settings modal never freezes a default into the file.
   *
   * Clearing needs its own argument: passing `{key: undefined}` in the patch would
   * drop the key from disk yet leave `undefined` in a non-optional field in main's
   * cache, so consumers would read undefined until the next restart.
   */
  updateSettings: (
    patch: Partial<CluiSettings>,
    clear?: SettingsKey[]
  ) => Promise<ResolvedSettings>
  /** Validate a CLI path (or auto-detect if empty): returns detected info. */
  detectCliAt: (path: string) => Promise<CliInfo>
  /**
   * Read the `permissions.defaultMode` from ~/.claude/settings.json — i.e. what
   * the "System Default" (inherit) mode resolves to. Returns 'default' if unset.
   */
  getSystemPermissionMode: () => Promise<string>
  /** List available model ids (live from Bedrock, cached; bundled fallback). */
  listModels: (refresh?: boolean) => Promise<string[]>
  /** Resolve a dropped/picked File's absolute path (Electron 33 `webUtils`). Synchronous;
   *  returns '' when the File has no backing path (e.g. a pasted screenshot Blob). */
  getPathForFile: (file: File) => string
  /** Subscribe to streamed events. Returns an unsubscribe fn. */
  onSessionEvent: (cb: (evt: TaggedEvent) => void) => () => void
  /**
   * Subscribe to application-menu actions (⌘N/⌘W/⌘, are driven by a native menu
   * in main so they compose with the OS shortcut layer, then pushed here).
   * Returns an unsubscribe fn.
   */
  onMenuAction: (cb: (action: MenuAction) => void) => () => void
}

/** Actions emitted by the native application menu. */
export type MenuAction =
  | 'new-session'
  | 'close-session'
  | 'open-settings'
  | 'open-palette'
  | 'find-in-conversation'
  | 'find-next'
  | 'find-prev'
  | 'search-global'

/** IPC channel names (single source of truth). */
export const IpcChannels = {
  pickWorkspace: 'clui:pickWorkspace',
  getCliInfo: 'clui:getCliInfo',
  startSession: 'clui:startSession',
  sendMessage: 'clui:sendMessage',
  interrupt: 'clui:interrupt',
  setPermissionMode: 'clui:setPermissionMode',
  setModel: 'clui:setModel',
  setEffort: 'clui:setEffort',
  setUltracode: 'clui:setUltracode',
  stopSession: 'clui:stopSession',
  respondPermission: 'clui:respondPermission',
  listSessions: 'clui:listSessions',
  deleteSession: 'clui:deleteSession',
  renameSession: 'clui:renameSession',
  readTranscript: 'clui:readTranscript',
  searchSessions: 'clui:searchSessions',
  warmSearchCache: 'clui:warmSearchCache',
  listWorkspaces: 'clui:listWorkspaces',
  exportSession: 'clui:exportSession',
  readAgentTranscript: 'clui:readAgentTranscript',
  readAgentTranscriptByToolUseId: 'clui:readAgentTranscriptByToolUseId',
  getSessionCosts: 'clui:getSessionCosts',
  setSessionCost: 'clui:setSessionCost',
  deleteSessionCost: 'clui:deleteSessionCost',
  getSessionModels: 'clui:getSessionModels',
  setSessionModel: 'clui:setSessionModel',
  deleteSessionModel: 'clui:deleteSessionModel',
  readConfig: 'clui:readConfig',
  openInEditor: 'clui:openInEditor',
  openExternal: 'clui:openExternal',
  filterExistingFiles: 'clui:filterExistingFiles',
  listWorkspaceFiles: 'clui:listWorkspaceFiles',
  openDiff: 'clui:openDiff',
  getSettings: 'clui:getSettings',
  updateSettings: 'clui:updateSettings',
  detectCliAt: 'clui:detectCliAt',
  getSystemPermissionMode: 'clui:getSystemPermissionMode',
  listModels: 'clui:listModels',
  /**
   * SYNCHRONOUS channel (ipcRenderer.sendSync) used by the preload to resolve the
   * concrete theme ('dark'|'light') before first paint — 'system' is resolved via
   * the OS in main. Sync so the preload can set <html data-theme> with zero flash
   * (an inline <head> script would violate our strict `default-src 'self'` CSP).
   */
  getResolvedThemeSync: 'clui:getResolvedThemeSync',
  /** main → renderer push channel */
  sessionEvent: 'clui:sessionEvent',
  /** main → renderer push channel for native application-menu actions */
  menuAction: 'clui:menuAction'
} as const
