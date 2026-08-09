/**
 * Shared types for session history.
 */

/** One past session, summarized from its on-disk `.jsonl`. */
export interface SessionSummary {
  /** CLI session id (the `.jsonl` filename stem). */
  id: string
  /** Display title: sidecar rename → customTitle → aiTitle → first user message → id. */
  title: string
  /** True if the title came from the app's sidecar rename map. */
  renamed: boolean
  /** Absolute workspace path (from the jsonl `cwd`), authoritative. */
  cwd: string
  /** Project slug (the parent directory name under ~/.claude/projects). */
  projectSlug: string
  /** ISO timestamp of the first event, if known. */
  firstTimestamp: string | null
  /** ISO timestamp of the last event, if known. */
  lastTimestamp: string | null
  /** File mtime (ms): last activity. */
  mtimeMs: number
  /**
   * Session creation time (ms): file birthtime, falling back to the first
   * event's timestamp, then mtime. Immutable, so ordering by it is stable across
   * resume (which bumps mtime) and deletes.
   */
  createdMs: number
  /** Count of user+assistant messages (approximate). */
  messageCount: number
}

/** Sessions grouped by their workspace/project for the sidebar. */
export interface ProjectGroup {
  /** Absolute workspace path (best-effort; falls back to the slug). */
  cwd: string
  /** Human label (basename of cwd). */
  label: string
  /**
   * Whether the workspace folder is still on disk. A transcript outlives its folder
   * (deleted, moved, or a /tmp dir the OS reaped), and the CLI can't spawn into a missing
   * cwd, so resume and branch are impossible while export and delete still work. One stat
   * per GROUP rather than per session, inside a scan that already reads every file.
   */
  exists: boolean
  sessions: SessionSummary[]
}

/**
 * A reconstructed transcript message for rendering resumed history. Mirrors the
 * renderer's ChatMessage/ToolCall so history and live-streamed turns render the
 * same way. Built defensively from the version-dependent `.jsonl`; display only.
 */
export interface HistoryToolCall {
  id: string
  name: string
  input: unknown
  result?: string
  isError?: boolean
}

/** An attachment recovered from a resumed USER turn (drop-file). Images
 *  come back as a displayable `data:` URL (bytes are inlined in the jsonl); document/
 *  text attachments come back as a metadata-only CHIP (name + size); we don't re-inline
 *  a PDF's base64 (memory) or re-dump a text file's contents (noise) into the bubble. */
export type HistoryAttachment =
  | { kind: 'image'; dataUrl: string }
  | { kind: 'document'; name: string; bytes: number }
  | { kind: 'text'; name: string; bytes: number; lines: number }

export interface HistoryMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  thinking: string
  tools: HistoryToolCall[]
  /** Attachments recovered from the transcript for a resumed USER turn. Absent when none. */
  attachments?: HistoryAttachment[]
}

/** Result of reading a session transcript (may be capped for huge sessions). */
export interface TranscriptResult {
  messages: HistoryMessage[]
  /** Total messages in the transcript before any cap. */
  total: number
  /** True if older messages were dropped to keep rendering fast. */
  capped: boolean
  /**
   * Resident context tokens from the transcript's LAST usage record (input +
   * cache_read + cache_creation), so the context ring shows the real fill % on
   * resume instead of 0% until the first new turn. Null if no usage was found.
   */
  contextTokens: number | null
}

// ── Conversation search ──────────────────────────────────────────────────────

/** One match inside a message, as an inclusive-start/exclusive-end char range into
 *  the SNIPPET string (fed to highlightRuns). */
export interface SnippetRange {
  start: number
  end: number
}

/** A single search hit, LIGHTWEIGHT (never carries the full message). Enough to
 *  render a result row and navigate: the `messageId` maps to a rendered message in
 *  the (now-uncapped, virtualized) transcript via findIndex → scrollToIndex. */
export interface SearchHit {
  sessionId: string
  cwd: string
  /** Session display title (from the sidecar/first message). */
  title: string
  /** Stable message id (`h-<seq>-<uuid>`); matches store.messages for jump-to-hit. */
  messageId: string
  role: 'user' | 'assistant'
  /** A readable window of text centered on the first match, term(s) highlighted via
   *  `ranges` (indices into THIS snippet, not the full message). */
  snippet: string
  ranges: SnippetRange[]
  /** How many total matches this message had (may exceed the snippet's visible ones). */
  matchCount: number
}

/** Facets for a global search. Both optional; omitting = broadest scope. */
export interface SearchOptions {
  /** Restrict to one workspace by its project slug (skips other project dirs at the
   *  parse step, a cold-start perf win). Undefined = all workspaces. */
  scopeSlug?: string
  /** Only match USER messages (find your own prompts). False/undefined = everyone. */
  userOnly?: boolean
}

/** A workspace option for the scope dropdown (derived from the session list). */
export interface WorkspaceOption {
  slug: string
  /** Display label (workspace basename). */
  label: string
  cwd: string
  /** Session count in this workspace. */
  count: number
}

/** Results of a global content search across all on-disk sessions. */
export interface SearchResults {
  /** Hits, grouped-and-ordered by session (session order = most-recent-first). */
  sessions: {
    sessionId: string
    cwd: string
    title: string
    /** Workspace basename for the group header. */
    label: string
    mtimeMs: number
    hits: SearchHit[]
    /** Total hits in this session (hits[] may be capped for display). */
    totalHits: number
  }[]
  /** True if the query was too short to run a content scan (< min length). */
  tooShort: boolean
}
