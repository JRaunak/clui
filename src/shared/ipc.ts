/**
 * The typed contract exposed by the preload bridge (`window.clui`).
 *
 * Renderer → main calls are Promise-returning methods. Main → renderer streaming
 * happens via `onSessionEvent`, which delivers `DomainEvent`s tagged with the
 * session id they belong to.
 */
import type { DomainEvent, ElicitationResponse } from './events'
import type {
  ProjectGroup,
  TranscriptResult,
  SearchResults,
  SearchOptions,
  WorkspaceOption
} from './sessions'
import type { ConfigBundle } from './config'
import type { ApprovedSite, BrowserEvent, BrowsingDataInfo, ClearBrowsingData, LocalNetSite, PaneBounds, SavedLoginInfo } from './browser'
import type { AnnotateEvent } from './annotate'
import type { ChangeSide, DraftReference, LineRange, RefInput, RefInvalid, SourceVersion } from './context'
import type { ChangeGitStatus, ChangeMarks, ChangesEvent, DiffRequest, FileChangeSummary, FileDiff, HunkRows } from './changes'
import type { ContextMenuItem, FileChangedEvent, FileStat, Refusal, TextRead, TreeListing } from './files'
import type { SurfaceKind, SurfacesRestore, SurfacesSave } from './surfaces'
import type { SurfaceCommand, SurfaceReply } from './surface-tools'
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
   * Fork from `resumeSessionId` instead of resuming it. Passes `--fork-session`
   * so the CLI branches to a NEW session id carrying the full context, leaving the
   * original jsonl untouched. Only meaningful with `resumeSessionId`. Fork-from-HEAD
   * (a whole-session duplicate), never a mid-conversation truncation (that would desync
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
  /** Ultracode on for this session (workflow orchestration at the stored effort). Default false. */
  ultracode?: boolean
  /** Session title passed as `claude -n "<name>"` at spawn, writing the on-disk
   *  custom-title from turn zero (a post-spawn rename lands too late for a skill that
   *  greps the title on its first turn). Empty/whitespace is dropped in buildArgs, so
   *  every caller inherits that one guard. Not persisted: the CLI owns the resulting title. */
  name?: string
  /** Quick chat: spawn with `--no-session-persistence` so no transcript hits disk. */
  ephemeral?: boolean
}

/** Permission-mode choices selectable per session. Aliased to the settings union so the
 *  two can't drift: one canonical list, kept honest by the `PERMISSION_MODE_*` Record
 *  maps in settings.ts (which compile-error on a missing arm). */
export type PermissionModeChoice = CluiSettings['permissionMode']

/** A live permission-mode change. `errorCode` is the CLI's reason when it refuses, e.g.
 *  'auto_mode_model' when the session's model can't run auto. `mode` is the concrete mode
 *  main sent, which for 'inherit' is what settings.json resolved to. */
export interface ModeChangeResult {
  ok: boolean
  errorCode?: string
  mode?: string
}

/** Result of starting a session: our local handle for it. */
export interface StartSessionResult {
  /** App-local id used to route events/sends before the CLI session id is known. */
  handleId: string
  /** The process started with the browser tools, which it keeps until it exits. */
  browser: boolean
  /** A resume's or fork's saved pane. With the browser tools, its browser tabs are the ones main
   *  restored; without them they're null here and stay saved for a later resume. */
  surfaces: SurfacesRestore
}

/**
 * The minimal attachment payload that crosses the wire to the CLI:
 * only the media type + raw base64 bytes (NO `data:...;base64,` prefix) or inlined text
 * cross IPC. Renderer-only display metadata (thumbnail, size, dims) never does, keeping
 * the (already large) base64 from being duplicated across the bridge. Covers the three
 * content-block kinds the CLI's duplex stream-json user turn accepts (all three VERIFIED
 * live on 2.1.209):
 *  - `image`    → `{type:'image',    source:{type:'base64', media_type, data}}`
 *  - `document` → `{type:'document', source:{type:'base64', media_type:'application/pdf', data}}`
 *  - `text`     → an inlined text block (a dropped text file's decoded contents,
 *                 wrapped so the model knows the filename, mechanically identical to
 *                 a paste, so it works regardless of the workspace-cwd Read boundary).
 */
export type WireAttachment =
  | { kind: 'image'; mediaType: string; data: string }
  | { kind: 'document'; mediaType: string; data: string }
  | { kind: 'text'; name: string; text: string }

export interface OutgoingPacket { text: string; refs: DraftReference[]; attachments: WireAttachment[]; now: boolean }

export type DispatchResult =
  | { ok: true; packetId: string; text: string; joined: boolean }
  | { ok: false; reason: 'stale'; invalid: RefInvalid[] }
  /** Malformed; nothing sent. */
  | { ok: false; reason: 'invalid' }
  /** A Stop arrived before it was written. */
  | { ok: false; reason: 'cancelled' }

export interface ChangeRefRequest { path: string; segmentId: string; revision: string; hunkId: string; side: ChangeSide; rows?: HunkRows }
/**
 * `changed`: the segment, revision or hunk isn't in the ledger now. `denied`: this session's CLI lacks the
 * change_read tool. `unavailable`: no live session for the handle. `bytes` on success is what change_read returns,
 * for the per-message cap.
 */
export type ChangeRefResult =
  | { ok: true; ref: Extract<RefInput, { kind: 'change' }>; bytes: number }
  | { ok: false; reason: 'changed' | 'empty' | 'too-large' | 'denied' | 'unavailable'; lines?: number; bytes?: number }

export type ChangeRefPeek = { ok: true; text: string; side: ChangeSide; old?: LineRange; new?: LineRange; bytes: number } | { ok: false }

export interface AnnotationOrder { keep: number[]; shown: [pinId: number, n: number][]; room: number }
export interface RefWatchEntry { path: string; version: SourceVersion }
export interface RefSourceChanged { handleId: string; path: string; reason: 'changed' | 'missing' | 'denied'; version?: SourceVersion }

/** A user's answer to a permission request. */
export type PermissionVerdict =
  | { requestId: string; behavior: 'allow'; updatedInput: unknown }
  | { requestId: string; behavior: 'deny'; message: string }

/** A domain event tagged with the session handle it belongs to. */
export interface TaggedEvent {
  handleId: string
  event: DomainEvent
}

/** Result of a model-list query: the ids plus whether they actually came from Bedrock. */
export interface ModelListResult {
  ids: string[]
  /** True only when this call's ids came LIVE from Bedrock (or from a cached live
   *  result). False means `ids` is Clui's bundled fallback. */
  live: boolean
  /** Coarse cause when `live` is false, so the UI can name the fix. */
  reason?: 'no-cli' | 'expired-creds' | 'other'
}

/**
 * Effort ceilings read from ~/.claude/settings.json. The CLI silently caps reasoning at
 * these levels, so Clui reads them to keep the picker/chip honest (display + runtime only,
 * never written). `modelSettings[id]` takes precedence over the top-level `maxEffortLevel`.
 * Both values are pre-validated against EFFORT_CHOICES by the reader.
 */
export interface EffortCaps {
  maxEffortLevel?: EffortChoice
  modelSettings?: Record<string, { maxEffortLevel?: EffortChoice }>
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
  /** Resolve + create the "no directory" session cwd (~/.clui or the configured default). */
  getChatDir: () => Promise<string>
  /** Detect / report the claude CLI binary. */
  getCliInfo: () => Promise<CliInfo>
  /** True in macOS fullscreen, where the OS hides the traffic lights. */
  getFullscreen: () => Promise<boolean>
  /** The window carries the native sidebar material only on macOS. */
  isMac: boolean
  /** Start a session; returns a local handle. */
  startSession: (opts: StartSessionOptions) => Promise<StartSessionResult>
  /** Validate, serialize and write one user message. Main re-checks every reference first; a stale one sends
   *  nothing. `now` sends into the running turn. */
  sendMessage: (handleId: string, packet: OutgoingPacket) => Promise<DispatchResult>
  /** The dispatch checks alone, for a queued message's review. */
  validateRefs: (handleId: string, refs: DraftReference[]) => Promise<RefInvalid[]>
  /** Which pins main keeps and which it outlines, numbered by their chip position. */
  syncAnnotationOrder: (handleId: string, order: AnnotationOrder) => Promise<void>
  /** The selection references' files to watch, declaratively. */
  syncRefWatches: (handleId: string, entries: RefWatchEntry[]) => Promise<void>
  onRefSourceChanged: (cb: (e: RefSourceChanged) => void) => () => void
  /** Claude's surface_state and surface_open, applied here. Each command is answered once with surfaceReply. */
  onSurfaceCommand: (cb: (cmd: SurfaceCommand) => void) => () => void
  surfaceReply: (reqId: string, reply: SurfaceReply) => Promise<void>
  /** Interrupt the current turn. */
  interrupt: (handleId: string) => Promise<void>
  /** Kill a background task directly (control protocol); false means the caller should
   *  fall back to the tool-mediated stop. */
  stopTask: (handleId: string, taskId: string) => Promise<boolean>
  /** Move a running foreground tool to the background (keeps running in the tray). */
  backgroundTask: (handleId: string, toolUseId: string) => Promise<boolean>
  /** Change a running session's permission mode mid-session. Resolves false if the CLI
   *  rejected the change, so the renderer can revert its optimistic UI. */
  setPermissionMode: (handleId: string, mode: PermissionModeChoice) => Promise<ModeChangeResult>
  /** Change a running session's model live. False = rejected (renderer reverts). */
  setModel: (handleId: string, model: ModelChoice) => Promise<boolean>
  /** Change a running session's effort (respawns via --resume; per-session only). */
  setEffort: (handleId: string, effort: EffortChoice) => Promise<void>
  /** Push a discovery-name change onto a running session via `/rename` (no-op if not live). */
  injectRename: (handleId: string, name: string) => Promise<void>
  /** Toggle ultracode (workflow orchestration) live. False = rejected (renderer reverts). */
  setUltracode: (handleId: string, on: boolean) => Promise<boolean>
  /** Stop and clean up a session's process. */
  stopSession: (handleId: string) => Promise<void>
  /** Answer a pending interactive permission request. */
  respondPermission: (handleId: string, verdict: PermissionVerdict) => Promise<void>
  /** Answer an MCP server's elicitation (the card's Done/Decline/Cancel or form submit). */
  respondElicitation: (handleId: string, requestId: string, response: ElicitationResponse) => Promise<void>
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
   *  so the first query is warm). No matching, just parse-into-cache. Fire-and-forget. */
  warmSearchCache: () => Promise<void>
  /** Read a workflow/subagent agent transcript by agentId (from disk; the live
   *  stream doesn't carry it). Empty if not found (still streaming / layout drift). */
  readAgentTranscript: (agentId: string) => Promise<TranscriptResult>
  /** Nesting: read a subagent transcript by its Agent tool_use_id (via the .meta.json
   *  sidecar), for NESTED children whose taskId the UI never learns. Used when no live
   *  forwarded stream is left to replay, i.e. a resumed session's finished agents. */
  readAgentTranscriptByToolUseId: (toolUseId: string) => Promise<TranscriptResult>
  /** Load the per-session model+effort map (sessionId → {model,effort}). Passed as
   *  --model/--effort on resume so a mid-session switch survives (the CLI otherwise
   *  reverts to the settings.json default on --resume). */
  getSessionModels: () => Promise<Record<string, { model?: string; effort?: string; ultracode?: boolean; contextWindow?: number }>>
  /** Persist one session's model/effort (merges provided fields). */
  setSessionModel: (sessionId: string, prefs: { model?: string; effort?: string; ultracode?: boolean; contextWindow?: number }) => Promise<void>
  /** Remove one session's persisted model/effort (on permanent delete). */
  deleteSessionModel: (sessionId: string) => Promise<void>
  /** Save a session's pane by handle. Main holds it until the CLI names the session, and drops a Quick session's. */
  saveSurfaces: (handleId: string, save: SurfacesSave) => Promise<void>
  /** The same, blocking until main has it, for the window's unload. */
  saveSurfacesSync: (handleId: string, save: SurfacesSave) => void
  /** The native open dialog at `defaultPath`. Main grants this session exactly the file chosen and returns its
   *  canonical path; null when cancelled. */
  chooseSurfaceFile: (handleId: string, defaultPath: string) => Promise<string | null>
  /** Read the Customizations bundle (agents/skills/hooks/mcp) for a workspace. */
  readConfig: (cwd: string | null) => Promise<ConfigBundle>
  /** Open a file in the configured editor: one the session may see, or with a null handle, a
   *  Configuration source that readConfig returned. Rejects with a readable message otherwise. `line`
   *  reaches only editors that take one (editorLineStyle). */
  openInEditor: (handleId: string | null, filePath: string, line?: number) => Promise<void>
  /** Open an http(s) URL in the user's default browser (markdown links). */
  openExternal: (url: string) => Promise<void>
  /** The session's Claude changes, with each file's on-disk presence re-checked. Null once the session is gone. */
  getChanges: (handleId: string) => Promise<FileChangeSummary[] | null>
  /** The first line Claude's edit `editId` changed in `path`, as the file stood after it; null when the ledger has no hunk for it. */
  editLine: (handleId: string, path: string, editId: string) => Promise<number | null>
  /** Git decoration for the session's changed files, read in main from its ledger paths. Null once the session is gone. */
  getChangeGitStatus: (handleId: string) => Promise<ChangeGitStatus | null>
  /** List files under the session's workspace (git-aware; relative paths, capped) for the
   *  composer's @-file picker. Empty on error. */
  listWorkspaceFiles: (handleId: string) => Promise<{ files: string[]; truncated: boolean }>
  /** Per absolute path, the reference kind a sent message would be allowed to point at, or null. */
  classifyRefPaths: (handleId: string, paths: string[]) => Promise<('file' | 'folder' | null)[]>
  /** Snapshots one hunk slice of Claude's change history as a draft change reference. It grants nothing until a
   *  message carrying it is written. */
  createChangeRef: (handleId: string, req: ChangeRefRequest) => Promise<ChangeRefResult>
  /** Per sent change ref (at most 20), whether Claude can still read it in this session. */
  changeRefStatus: (handleId: string, refs: string[]) => Promise<boolean[]>
  /** The snapshot a draft or sent change ref holds, for the chip's preview. Never the ledger's current hunk. */
  changeRefPeek: (handleId: string, ref: string) => Promise<ChangeRefPeek>
  /** Open a diff of two files the session may see, in the configured editor. */
  openDiff: (handleId: string, left: string, right: string) => Promise<void>
  /** One changed file's Claude changes as hunks, from the session's ledger. Null when the session or path isn't held. */
  getDiff: (handleId: string, req: DiffRequest) => Promise<FileDiff | null>
  /** Opens a segment of Claude's changes, the file's latest by default, as a diff of frozen snapshots in the editor. */
  openChangeDiff: (handleId: string, req: DiffRequest) => Promise<{ ok: true } | { ok: false; message: string }>
  /** Where Claude's changes survive in the file's current text. Null when the path isn't Claude's or can't be read. */
  getChangeMarks: (handleId: string, path: string) => Promise<ChangeMarks | null>
  /** A file the session may see, as text (5 MiB head at most). */
  readText: (handleId: string, path: string) => Promise<TextRead | Refusal>
  statFile: (handleId: string, path: string) => Promise<FileStat | Refusal>
  /** Watch a file while a surface shows it; changes arrive through onFileChanged with the returned id. */
  watchFile: (handleId: string, path: string) => Promise<{ ok: true; id: string } | Refusal>
  unwatchFile: (handleId: string, id: string) => Promise<void>
  onFileChanged: (cb: (evt: FileChangedEvent) => void) => () => void
  /** Open a file the session may see in its default app. */
  openPath: (handleId: string, path: string) => Promise<{ ok: true } | { ok: false; message: string }>
  /** One folder of the session's cwd by its cwd-relative path ('' for the cwd), with Git-ignored entries flagged. */
  listDir: (handleId: string, rel: string) => Promise<TreeListing | Refusal>
  /** Watch a listed folder (shallow); changes arrive through onFileChanged, and unwatchFile ends it. */
  watchDir: (handleId: string, rel: string) => Promise<{ ok: true; id: string } | Refusal>
  /** Show a file or folder the session may see in Finder. */
  revealPath: (handleId: string, path: string) => Promise<{ ok: true } | { ok: false; message: string }>
  /** A native context menu at the pointer, or at `at` in window coordinates; resolves with the chosen id or null. */
  showContextMenu: (items: ContextMenuItem[], at?: { x: number; y: number }) => Promise<string | null>
  /** The user's home directory, for printing paths with `~`. */
  homeDir: string
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
  /** Main's snapshot after every successful update, in commit order. Returns an unsubscribe fn. */
  onSettingsChanged: (cb: (settings: ResolvedSettings) => void) => () => void
  /** Validate a CLI path (or auto-detect if empty): returns detected info. */
  detectCliAt: (path: string) => Promise<CliInfo>
  /**
   * Read the `permissions.defaultMode` from ~/.claude/settings.json, i.e. what
   * the "System Default" (inherit) mode resolves to. Returns null if unset.
   */
  getSystemPermissionMode: () => Promise<string | null>
  /**
   * Read the effort ceilings from ~/.claude/settings.json (top-level + per-model). Used
   * to keep the effort picker/chip honest about what will actually run. Read-only.
   */
  getEffortCaps: () => Promise<EffortCaps>
  /**
   * List available model ids. `live` is true when these ids came from Bedrock (a
   * successful query, or the cache of one) and false when they're Clui's bundled
   * fallback, with `reason` naming the cause. Only success is cached, so `live` is a
   * PER-CALL fact: a later call can go live again; never latch it as app state.
   */
  listModels: (refresh?: boolean) => Promise<ModelListResult>
  /** Resolve a dropped/picked File's absolute path (Electron 33 `webUtils`). Synchronous;
   *  returns '' when the File has no backing path (e.g. a pasted screenshot Blob). */
  getPathForFile: (file: File) => string
  /** Subscribe to streamed events. Returns an unsubscribe fn. */
  onSessionEvent: (cb: (evt: TaggedEvent) => void) => () => void
  /** Subscribe to the ledger's summary updates. Returns an unsubscribe fn. */
  onChangesEvent: (cb: (evt: ChangesEvent) => void) => () => void
  /**
   * Subscribe to application-menu actions (⌘N/⌘W/⌘, are driven by a native menu
   * in main so they compose with the OS shortcut layer, then pushed here). `page` is whether
   * a native page (the browser pane's view) had focus when the item fired; only main can tell.
   * Returns an unsubscribe fn.
   */
  onMenuAction: (cb: (action: MenuAction, page: boolean) => void) => () => void
  /** Subscribe to fullscreen enter/leave. Returns an unsubscribe fn. */
  onFullscreenChanged: (cb: (isFullscreen: boolean) => void) => () => void
  /** macOS "Reduce transparency", read from nativeTheme so the solid fallback doesn't rely on Chromium's media query. */
  getReducedTransparency: () => Promise<boolean>
  /** The OS appearance itself. The renderer's prefers-color-scheme follows Clui's own theme instead. */
  getOsTheme: () => Promise<'dark' | 'light'>
  onReducedTransparencyChanged: (cb: (on: boolean) => void) => () => void
  /** Fire-and-forget: sent at most once per animation frame. */
  browserSetBounds: (handleId: string, b: PaneBounds | null) => void
  /** Shows or hides the session's viewed tab. Resolves to a fresh still captured just before hiding, or null. */
  browserSetVisible: (handleId: string, visible: boolean) => Promise<string | null>
  /** Makes `tab` the viewed tab. A suspended tab reloads. */
  browserViewTab: (handleId: string, tab: number) => Promise<void>
  /** Opens an empty tab at the end and views it. Resolves to its id. */
  browserNewTab: (handleId: string) => Promise<number>
  /** Closing the last tab opens a fresh empty one in its place. */
  browserCloseTab: (handleId: string, tab: number) => Promise<void>
  /** Resolves to an error text when the URL is refused (non-http(s)), else null. */
  browserNavigate: (handleId: string, tab: number, url: string) => Promise<string | null>
  browserNav: (handleId: string, tab: number, action: 'back' | 'forward' | 'reload' | 'stop') => Promise<void>
  /** stop and reset apply to every tab; handback and takeover to `tab`, which they require. */
  browserDrive: (handleId: string, action: 'stop' | 'handback' | 'takeover' | 'reset', tab?: number) => Promise<void>
  /** Starts or ends annotate in `tab`; main answers with annotate events. */
  browserAnnotate: (handleId: string, tab: number, on: boolean) => Promise<void>
  onAnnotateEvent: (cb: (handleId: string, e: AnnotateEvent) => void) => () => void
  browserSiteVerdict: (handleId: string, requestId: string, allow: boolean) => Promise<void>
  /** choose: `loginId`; save: the user's fields (the password crosses IPC only here); decline: neither. */
  browserLoginVerdict: (
    handleId: string,
    requestId: string,
    verdict:
      | { action: 'fill'; loginId: string }
      | { action: 'save'; username: string; password: string; totpSeed?: string }
      | { action: 'decline' }
      | { action: 'self' }
  ) => Promise<void>
  browserListSites: () => Promise<ApprovedSite[]>
  browserRemoveSite: (site: string) => Promise<void>
  /** Answers a tab's local network ask for `site`; ignored when no tab is asking. Allow reloads the site's pages. */
  browserLocalNetDecide: (site: string, allow: boolean) => Promise<void>
  browserListLocalNet: () => Promise<LocalNetSite[]>
  /** The site's next top-frame check asks again. */
  browserForgetLocalNet: (site: string) => Promise<void>
  browserListLogins: () => Promise<SavedLoginInfo[]>
  browserSaveLogin: (input: { id?: string; site: string; username: string; password?: string; totpSeed?: string }) => Promise<SavedLoginInfo>
  browserRemoveLogin: (id: string) => Promise<void>
  browserVaultAvailable: () => Promise<boolean>
  browserDataInfo: () => Promise<BrowsingDataInfo>
  /** Rejects while Claude drives any page; approved sites and saved logins are never touched. */
  browserClearData: (what: ClearBrowsingData) => Promise<void>
  /** What the native menu's pane and browser items act on, pushed whenever it changes. */
  menuState: (state: MenuState) => void
  onBrowserEvent: (cb: (handleId: string, e: BrowserEvent) => void) => () => void
}

/** Actions emitted by the native application menu. */
export type MenuAction =
  | 'new-session'
  | 'new-quick-session'
  | 'new-named-session'
  | 'close-session'
  | 'open-settings'
  | 'open-palette'
  | 'open-command-palette'
  | 'open-file'
  | 'find-in-conversation'
  | 'find-next'
  | 'find-prev'
  | 'search-global'
  | 'toggle-pane-size'
  | 'pane-toggle'
  | 'browser-stop'
  | 'browser-annotate'
  | 'browser-toggle'
  | 'pane-external'

/** IPC channel names (single source of truth). */
export const IpcChannels = {
  pickWorkspace: 'clui:pickWorkspace',
  getChatDir: 'clui:getChatDir',
  getCliInfo: 'clui:getCliInfo',
  getFullscreen: 'clui:getFullscreen',
  startSession: 'clui:startSession',
  sendMessage: 'clui:sendMessage',
  validateRefs: 'clui:validateRefs',
  syncAnnotationOrder: 'clui:syncAnnotationOrder',
  syncRefWatches: 'clui:syncRefWatches',
  refSourceChanged: 'clui:refSourceChanged',
  surfaceCommand: 'clui:surfaceCommand',
  surfaceReply: 'clui:surfaceReply',
  interrupt: 'clui:interrupt',
  stopTask: 'clui:stopTask',
  backgroundTask: 'clui:backgroundTask',
  setPermissionMode: 'clui:setPermissionMode',
  setModel: 'clui:setModel',
  setEffort: 'clui:setEffort',
  injectRename: 'clui:injectRename',
  setUltracode: 'clui:setUltracode',
  stopSession: 'clui:stopSession',
  respondPermission: 'clui:respondPermission',
  respondElicitation: 'clui:respondElicitation',
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
  getSessionModels: 'clui:getSessionModels',
  setSessionModel: 'clui:setSessionModel',
  deleteSessionModel: 'clui:deleteSessionModel',
  saveSurfaces: 'clui:saveSurfaces',
  /** SYNCHRONOUS (ipcRenderer.sendSync), from beforeunload. */
  saveSurfacesSync: 'clui:saveSurfacesSync',
  chooseSurfaceFile: 'clui:chooseSurfaceFile',
  readConfig: 'clui:readConfig',
  openInEditor: 'clui:openInEditor',
  openExternal: 'clui:openExternal',
  getChanges: 'clui:getChanges',
  editLine: 'clui:editLine',
  getChangeGitStatus: 'clui:getChangeGitStatus',
  listWorkspaceFiles: 'clui:listWorkspaceFiles',
  classifyRefPaths: 'clui:classifyRefPaths',
  createChangeRef: 'clui:createChangeRef',
  changeRefStatus: 'clui:changeRefStatus',
  changeRefPeek: 'clui:changeRefPeek',
  openDiff: 'clui:openDiff',
  getDiff: 'clui:getDiff',
  openChangeDiff: 'clui:openChangeDiff',
  getChangeMarks: 'clui:getChangeMarks',
  readText: 'clui:readText',
  statFile: 'clui:statFile',
  watchFile: 'clui:watchFile',
  unwatchFile: 'clui:unwatchFile',
  /** main → renderer push channel for watched-file changes */
  fileChanged: 'clui:fileChanged',
  openPath: 'clui:openPath',
  listDir: 'clui:listDir',
  watchDir: 'clui:watchDir',
  revealPath: 'clui:revealPath',
  showContextMenu: 'clui:showContextMenu',
  getSettings: 'clui:getSettings',
  updateSettings: 'clui:updateSettings',
  settingsChanged: 'clui:settingsChanged',
  detectCliAt: 'clui:detectCliAt',
  getSystemPermissionMode: 'clui:getSystemPermissionMode',
  getEffortCaps: 'clui:getEffortCaps',
  listModels: 'clui:listModels',
  /**
   * SYNCHRONOUS channel (ipcRenderer.sendSync) used by the preload to resolve the
   * concrete theme ('dark'|'light') before first paint; 'system' is resolved via
   * the OS in main. Sync so the preload can set <html data-theme> with zero flash
   * (an inline <head> script would violate our strict `default-src 'self'` CSP).
   */
  getResolvedThemeSync: 'clui:getResolvedThemeSync',
  getHomeDirSync: 'clui:getHomeDirSync',
  /** main → renderer push channel */
  sessionEvent: 'clui:sessionEvent',
  /** main → renderer push channel for Claude change summaries */
  changesEvent: 'clui:changesEvent',
  /** main → renderer push channel for native application-menu actions */
  menuAction: 'clui:menuAction',
  getReducedTransparency: 'clui:getReducedTransparency',
  getOsTheme: 'clui:getOsTheme',
  reducedTransparencyChanged: 'clui:reducedTransparencyChanged',
  fullscreenChanged: 'clui:fullscreenChanged',
  browserEvent: 'clui:browserEvent',
  browserSetBounds: 'clui:browserSetBounds',
  browserSetVisible: 'clui:browserSetVisible',
  browserViewTab: 'clui:browserViewTab',
  browserNewTab: 'clui:browserNewTab',
  browserCloseTab: 'clui:browserCloseTab',
  browserNavigate: 'clui:browserNavigate',
  browserNav: 'clui:browserNav',
  browserDrive: 'clui:browserDrive',
  browserAnnotate: 'clui:browserAnnotate',
  annotateEvent: 'clui:annotateEvent',
  browserSiteVerdict: 'clui:browserSiteVerdict',
  browserLoginVerdict: 'clui:browserLoginVerdict',
  browserListSites: 'clui:browserListSites',
  browserRemoveSite: 'clui:browserRemoveSite',
  browserLocalNetDecide: 'clui:browserLocalNetDecide',
  browserListLocalNet: 'clui:browserListLocalNet',
  browserForgetLocalNet: 'clui:browserForgetLocalNet',
  browserListLogins: 'clui:browserListLogins',
  browserSaveLogin: 'clui:browserSaveLogin',
  browserRemoveLogin: 'clui:browserRemoveLogin',
  browserVaultAvailable: 'clui:browserVaultAvailable',
  browserDataInfo: 'clui:browserDataInfo',
  browserClearData: 'clui:browserClearData',
  menuState: 'clui:menuState'
} as const

export interface MenuState {
  browser: 'none' | 'shown' | 'hidden'
  pane: 'none' | 'split' | 'full'
  /** The pane's active kind while it shows, 'picker' with no tab active. */
  surface: SurfaceKind | 'picker' | 'none'
  /** The active session has a cwd, so it has files to open and a pane to show them in. */
  canPane: boolean
  /** What ⌘W closes, as far as the renderer's focus tells. Main overrides it while a native page has focus. */
  close: 'session' | 'tab' | 'none'
  /** The active surface's Open externally target, and whether it can open now. */
  external: { kind: 'file' | 'diff' | 'browser' | 'tree' | 'none'; enabled: boolean }
}
