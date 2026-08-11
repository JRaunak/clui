/**
 * Typed domain event model for Clui.
 *
 * The `claude` CLI (2.1.206) emits newline-delimited JSON on stdout when run with
 * `--output-format stream-json --include-partial-messages --verbose`. Those raw
 * envelopes are internal and version-dependent. The main process's event mapper
 * (`src/main/cli/event-mapper.ts`) translates them into the small, stable set of
 * `DomainEvent`s below, which are the ONLY shape the renderer ever sees.
 *
 * Keep this list minimal and defensive; never hard-depend on the raw jsonl shape.
 */

/**
 * One entry from the CLI's live task list (Task tool family), read from disk at
 * `~/.claude/tasks/<sessionId>/N.json`. Only the fields the checklist renders are
 * kept; `blockedBy` holds the ids of tasks that gate this one (resolved to their
 * subjects in the UI). The dir exists only while the session is LIVE.
 */
export interface SessionTask {
  id: string
  subject: string
  status: 'created' | 'pending' | 'in_progress' | 'completed'
  /** Present-tense label the CLI shows while a task runs (e.g. "Wiring the store"). */
  activeForm?: string
  /** Ids of tasks that must finish first; non-empty = this task is blocked. */
  blockedBy?: string[]
}

/** One slash command from the CLI's `initialize` response (dynamic discovery). */
export interface SlashCommandInfo {
  /** Command name WITHOUT the leading slash (e.g. "compact"). */
  name: string
  description: string
  /** Hint for arguments (e.g. "<model>"), may be empty. */
  argumentHint?: string
  aliases?: string[]
}

export type DomainEvent =
  /** Session started; carries the CLI-assigned session id + metadata. */
  | {
      type: 'session-init'
      sessionId: string
      model: string
      cwd: string
      permissionMode: string
      tools: string[]
    }
  /** The live slash-command list from the `initialize` control_response. Lets the
   *  composer's `/` menu track the CLI's real commands instead of a hardcoded list.
   *  Includes TUI-only commands the renderer filters out (the CLI carries no
   *  headless-safe flag, so see `isHeadlessSafeCommand`). */
  | { type: 'slash-commands'; commands: SlashCommandInfo[] }
  | { type: 'message-start' }
  /** A streamed chunk of assistant-visible text. */
  | { type: 'text-delta'; text: string }
  /** A streamed chunk of thinking/reasoning text. */
  | { type: 'thinking-delta'; text: string }
  | { type: 'tool-use-start'; id: string; name: string }
  | { type: 'tool-use-input-delta'; id: string; partialJson: string }
  | { type: 'tool-use-stop'; id: string; input: unknown }
  | {
      type: 'tool-result'
      toolUseId: string
      content: string
      isError: boolean
    }
  /** The current turn finished (one assistant message). */
  | { type: 'turn-complete'; stopReason: string | null }
  /**
   * A dynamic WORKFLOW (ultracode `Workflow` tool) started. task_type
   * 'local_workflow', distinct from local_bash (bg shell) / local_agent
   * (subagent). Drives the workflow tray chip + card. The live phase/agent tree
   * arrives via `workflow-progress` (keyed by the same taskId).
   */
  | {
      type: 'workflow-started'
      taskId: string
      toolUseId?: string
      name: string
      description: string
    }
  /**
   * Live snapshot of a workflow's phase→agent tree (from `system/task_progress`'s
   * `workflow_progress[]`). Emitted ~continuously; the store replaces the workflow's
   * tree with each snapshot. `phases` + `agents` are flat; agents group under a phase
   * by `phaseIndex`. `state` is the raw CLI agent state (start/running/done/failed…).
   */
  | {
      type: 'workflow-progress'
      taskId: string
      phases: { index: number; title: string }[]
      agents: {
        index: number
        label: string
        phaseIndex: number
        state: string
        promptPreview?: string
        agentId?: string
      }[]
      totalTokens?: number
    }
  /** A workflow reached a terminal state (from its task_notification). */
  | { type: 'workflow-ended'; taskId: string; status?: string }
  /**
   * Forwarded internal output of a RUNNING subagent, unlocked by
   * `initialize {forwardSubagentText:true}`. The CLI streams the subagent's own
   * assistant/user text as envelopes carrying `parent_tool_use_id` (the id of the
   * Agent tool_use that launched it), so these are correlated to a subagent card,
   * NOT the main thread. `role` distinguishes the subagent's own output
   * ('assistant') from its turn inputs ('user'). `kind` marks assistant reasoning
   * ('thinking') vs visible text ('text').
   */
  | {
      type: 'subagent-message'
      parentToolUseId: string
      role: 'assistant' | 'user'
      kind: 'text' | 'thinking'
      text: string
    }
  /**
   * A NON-Agent tool call (Bash, Read, Edit, …) made by a running subagent, from a
   * `tool_use` block in its forwarded message. Rendered as the same collapsed tool
   * card the main transcript uses, in stream order with the subagent's text, so a
   * subagent that shells a long command isn't silent until its summary lands.
   * Agent/Task tool_use blocks are NOT this; they map to `subagent-nested`.
   */
  | {
      type: 'subagent-tool'
      parentToolUseId: string
      toolUseId: string
      name: string
      input: unknown
    }
  /** The result of a subagent's tool call (forwarded `tool_result` block). Matched back
   *  to its `subagent-tool` by `toolUseId`; becomes the card's expandable output. */
  | {
      type: 'subagent-tool-result'
      parentToolUseId: string
      toolUseId: string
      content: string
      isError: boolean
    }
  /**
   * Nesting: a subagent spawned ANOTHER subagent, i.e. a forwarded subagent
   * message (tagged `parentToolUseId`) contained an Agent/Task `tool_use` block. The
   * child's own transcript streams separately under `childToolUseId` (its own PTU), so
   * this event lets the UI render a nested "Agent →" card inside the parent's transcript
   * that drills into the child. Nesting works fg + bg; the disk layout is flat
   * (`subagents/agent-<id>.jsonl`) with a `parentAgentId` sidecar.
   */
  | {
      type: 'subagent-nested'
      parentToolUseId: string
      childToolUseId: string
      name: string
      description?: string
      subagentType?: string
    }
  /** The whole request finished (final result envelope). */
  | {
      type: 'result'
      sessionId: string
      isError: boolean
      result: string | null
      totalCostUsd?: number
      /** True when this result is a backgrounded subagent's COMPLETION turn
       *  (CLI `origin.kind:'task-notification'`), not the user's own turn ending. Its
       *  cost is real (still accrued) but it must NOT clear the composer's `busy`. */
      fromTaskNotification?: boolean
    }
  /** The CLI wants approval for a tool call. */
  | {
      type: 'permission-request'
      requestId: string
      toolName: string
      input: unknown
      toolUseId?: string
      title?: string
      displayName?: string
      description?: string
    }
  /**
   * The CLI withdrew a still-pending permission request (e.g. the turn was
   * interrupted). Correlated by the same `requestId` as the original request; the
   * renderer dismisses that dialog so it doesn't hang.
   */
  | { type: 'permission-cancel'; requestId: string }
  /**
   * Context-window usage update (for the composer's context ring). Computed from
   * the stream's `usage` + the model's `contextWindow`, mirroring how the CLI's
   * statusline derives `context_window.used_percentage`.
   */
  | {
      type: 'context-usage'
      usedTokens: number
      contextWindow: number
      usedPercent: number
    }
  /**
   * A background task (e.g. a Bash `run_in_background` shell, or a backgrounded
   * subagent) started. Backgrounded work is unique in that the turn's `result`
   * fires while it keeps running, so these are tracked separately from the
   * turn-level `busy` flag. `taskId` is stable across its lifecycle events.
   */
  | {
      type: 'bg-task-started'
      taskId: string
      toolUseId?: string
      description: string
      taskType?: string
    }
  /** A background task changed state (status: running | completed | killed | …). */
  | {
      type: 'bg-task-updated'
      taskId: string
      status?: string
      summary?: string
    }
  /**
   * A background task emitted a completion/terminal notification (fired when the
   * task finishes or is stopped), the trigger for the completion toast.
   */
  | {
      type: 'bg-task-notification'
      taskId: string
      status?: string
      summary?: string
    }
  /** Authoritative snapshot of all currently-running background tasks (ids only). */
  | { type: 'bg-tasks-changed'; taskIds: string[] }
  /**
   * Snapshot of the session's live task list (Task tool family), read from
   * `~/.claude/tasks/<sessionId>/*.json` in the main process. Last-write-wins: the
   * store replaces the whole list each time. Empty array = no tasks (dir absent or
   * cleared), which hides the task puck. Sourced from DISK, not the stream, because
   * the stream only confirms individual changes; disk is the authoritative set.
   */
  | { type: 'task-list'; tasks: SessionTask[] }
  /** Non-fatal error surfaced by the CLI or the wrapper. */
  | {
      type: 'error'
      message: string
      /** 'info' = transient status (e.g. "Reconnecting…") → top notice/toast, not the
       *  red in-chat error box. Defaults to error severity when omitted. */
      severity?: 'error' | 'info'
    }
  /** The underlying CLI process exited. */
  | { type: 'process-exit'; code: number | null }
