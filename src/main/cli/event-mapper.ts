/**
 * Map raw CLI stream-json envelopes → typed `DomainEvent`s.
 *
 * The raw shapes were captured live from claude 2.1.206. This mapper is deliberately
 * defensive: an unknown envelope maps to nothing rather than throwing, so CLI version
 * drift skips the envelope instead of crashing the app.
 */
import type { DomainEvent } from '../../shared/events'

// Minimal structural typing of the raw envelopes we care about.
interface RawEnvelope {
  type?: string
  subtype?: string
  status?: string
  /** Present on envelopes forwarded from a RUNNING subagent (the id of the
   *  Agent tool_use that launched it). Routes the message to a subagent card. */
  parent_tool_use_id?: string
  session_id?: string
  model?: string
  cwd?: string
  permissionMode?: string
  tools?: string[]
  request_id?: string
  request?: {
    subtype?: string
    tool_name?: string
    input?: unknown
    tool_use_id?: string
    title?: string
    display_name?: string
    description?: string
  }
  event?: {
    type?: string
    index?: number
    content_block?: { type?: string; id?: string; name?: string }
    delta?: {
      type?: string
      text?: string
      partial_json?: string
      thinking?: string
      stop_reason?: string | null
    }
  }
  message?: {
    role?: string
    content?: Array<{
      type?: string
      text?: string
      thinking?: string
      tool_use_id?: string
      content?: unknown
      is_error?: boolean
      // tool_use block fields (nesting: a subagent's forwarded message can carry an
      // Agent/Task tool_use where it spawned a child).
      id?: string
      name?: string
      input?: unknown
    }>
    stop_reason?: string | null
    usage?: RawUsage
  }
  is_error?: boolean
  result?: string | null
  total_cost_usd?: number
  modelUsage?: Record<string, { contextWindow?: number }>
  /** On the SECOND `result` a backgrounded subagent emits when it finishes, the
   *  CLI tags it `origin.kind:'task-notification'` (the first, foreground turn's result
   *  has origin null). Used so the store doesn't let this completion-turn result clear
   *  the composer's `busy` (which belongs to the user's own turn). Verified live 2.1.216. */
  origin?: { kind?: string }
  // Background-task lifecycle (system/{task_started,task_updated,task_notification,
  // background_tasks_changed}). Verified live: task_id is stable; tasks[] is the
  // authoritative running snapshot; patch carries the status change.
  task_id?: string
  tool_use_id?: string
  description?: string
  task_type?: string
  summary?: string
  patch?: { status?: string; end_time?: number }
  tasks?: Array<{ task_id?: string; task_type?: string; description?: string }>
  // Dynamic-workflow fields (task_type 'local_workflow' + system/task_progress).
  workflow_name?: string
  usage?: RawUsage & { total_tokens?: number }
  workflow_progress?: Array<{
    type?: string
    index?: number
    title?: string
    label?: string
    phaseIndex?: number
    state?: string
    promptPreview?: string
    agentId?: string
  }>
}

/** Token usage fields we read to compute context-window utilization. */
interface RawUsage {
  input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  output_tokens?: number
}

/** Track in-flight tool_use blocks by their stream index → id, to attach input deltas. */
export class EventMapper {
  /** content-block index → tool_use id (for input-delta association). */
  private indexToToolId = new Map<number, string>()
  private toolInputJson = new Map<string, string>()
  /** Model's context window (tokens); learned from the model id / result. */
  private contextWindow = 200_000
  /** Last emitted percent, to avoid spamming identical context-usage events. */
  private lastPercent = -1
  /** Whether any text_delta streamed since the last message boundary. Slash
   *  commands (/usage, /cost, /context) emit a bare `assistant` snapshot with text
   *  but NO message_start/text_delta, so we detect that (snapshot text + nothing
   *  streamed) and surface the text so it renders instead of being dropped. */
  private streamedTextSinceStart = false
  /** task_ids that are TRUE background work (Bash run_in_background = 'local_bash').
   *  Only these belong in the bg tray. `task_started` is the only event that carries
   *  a reliable `task_type`, so we record the local_bash ids here and gate the later
   *  task_updated/notification/changed events on membership. Subagents ('local_agent')
   *  run in the foreground turn (shown as Agent cards) and must NEVER emit bg-task
   *  events (else a finished subagent fires a spurious "Background task finished" toast). */
  private bgTaskIds = new Set<string>()
  /** task_ids that are dynamic WORKFLOWS (task_type 'local_workflow'). Tracked so
   *  task_progress/task_notification for them route to the workflow events, not the
   *  bg-bash path. */
  private workflowIds = new Set<string>()
  /** task_ids of BACKGROUNDED subagents (task_type 'local_agent' AND launched
   *  with run_in_background:true). These DO get a persistent tray handle, unlike a
   *  FOREGROUND subagent (same task_type, run in the turn, already an Agent card), which
   *  must stay dropped (else a double-count + spurious completion toast). We can't tell
   *  the two apart from `task_started` alone (both are local_agent); the distinguisher
   *  is that a backgrounded one is announced in `background_tasks_changed`, which fires
   *  BEFORE its task_started (verified live 2.1.216), so its task_id lands in
   *  `bgAgentTaskIds` first, and the matching task_started then promotes it to a tray
   *  handle here. Gated like bgTaskIds on the later update/notification/changed events. */
  private bgSubagentIds = new Set<string>()
  /** task_ids seen in a `background_tasks_changed` snapshot as task_type
   *  'local_agent', the reliable "this subagent was backgrounded" signal (a foreground
   *  subagent never appears in that snapshot). Consumed by the task_started handler. */
  private bgAgentTaskIds = new Set<string>()

  /** Best-effort context window for a model id (fallback when result absent). */
  private contextWindowFor(model: string | undefined): number {
    if (model && /\[1m\]/i.test(model)) return 1_000_000
    return 200_000
  }

  /** Counts input + cache tokens (the resident context) to match the statusline's
   *  used_percentage. */
  private usageEvent(usage: RawUsage | undefined): DomainEvent[] {
    if (!usage) return []
    const used =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0)
    if (used <= 0) return []
    const percent = Math.min(100, Math.round((used / this.contextWindow) * 100))
    if (percent === this.lastPercent) return []
    this.lastPercent = percent
    return [
      { type: 'context-usage', usedTokens: used, contextWindow: this.contextWindow, usedPercent: percent }
    ]
  }

  map(raw: unknown): DomainEvent[] {
    if (!raw || typeof raw !== 'object') return []
    const env = raw as RawEnvelope
    // A forwarded subagent message (carries parent_tool_use_id) must be routed
    // to a subagent card, NOT the main thread, so intercept BEFORE the normal
    // assistant/user handlers (which would fold its text into the main chat, the
    // documented interleaving regression). Only assistant/user envelopes forward
    // this way; other types with the field (if any) fall through unchanged.
    if (env.parent_tool_use_id && (env.type === 'assistant' || env.type === 'user')) {
      return this.mapSubagentMessage(env)
    }
    switch (env.type) {
      case 'system':
        return this.mapSystem(env)
      case 'stream_event':
        return this.mapStreamEvent(env)
      case 'user':
        return this.mapUser(env)
      case 'control_request':
        return this.mapControlRequest(env)
      case 'control_cancel_request':
        // The CLI withdrew a pending permission prompt (e.g. turn interrupted).
        // Surface it so the renderer can dismiss the matching dialog.
        return env.request_id ? [{ type: 'permission-cancel', requestId: env.request_id }] : []
      case 'assistant': {
        const out: DomainEvent[] = []
        // Slash-command output (/usage, /cost, /context, …) arrives as a bare
        // snapshot with text but no message_start/text_delta. If we streamed no
        // text this turn, surface the snapshot's text so it renders (normal turns
        // already streamed their text, so we skip to avoid duplicating it).
        if (!this.streamedTextSinceStart) {
          const text = (env.message?.content ?? [])
            .filter((c) => c.type === 'text' && typeof c.text === 'string')
            .map((c) => c.text as string)
            .join('')
          if (text) {
            out.push({ type: 'message-start' }, { type: 'text-delta', text })
            // Mark as streamed so a repeated snapshot in the same turn doesn't double it.
            this.streamedTextSinceStart = true
          }
        }
        // Full assistant snapshots also carry a usage object; use it for the ring.
        out.push(...this.usageEvent(env.message?.usage))
        return out
      }
      case 'result': {
        // Turn boundary: reset the streamed-text flag so the NEXT turn (which may
        // be another non-streaming slash command with no message_start) is detected.
        this.streamedTextSinceStart = false
        // The result carries the authoritative contextWindow for the model.
        const cw = env.modelUsage ? Object.values(env.modelUsage)[0]?.contextWindow : undefined
        if (typeof cw === 'number' && cw > 0) this.contextWindow = cw
        return [
          {
            type: 'result',
            sessionId: env.session_id ?? '',
            isError: Boolean(env.is_error),
            result: env.result ?? null,
            totalCostUsd: env.total_cost_usd,
            // A backgrounded subagent's COMPLETION emits its own turn (init +
            // streamed text + this result) tagged origin.kind='task-notification'. Its
            // cost + text ARE real (accrue + render them), but it must NOT clear the
            // user's foreground `busy`, so flag it so the store can guard that.
            fromTaskNotification: env.origin?.kind === 'task-notification'
          }
        ]
      }
      default:
        return []
    }
  }

  private mapSystem(env: RawEnvelope): DomainEvent[] {
    if (env.subtype === 'init') {
      // Seed the context window from the model id (refined later by the result).
      this.contextWindow = this.contextWindowFor(env.model)
      return [
        {
          type: 'session-init',
          sessionId: env.session_id ?? '',
          model: env.model ?? '',
          cwd: env.cwd ?? '',
          permissionMode: env.permissionMode ?? '',
          tools: env.tools ?? []
        }
      ]
    }
    // Background-task lifecycle. A backgrounded task (Bash run_in_background, or a
    // backgrounded subagent) keeps running AFTER the turn's `result` fires, so we
    // surface these as their own events rather than folding into turn-level busy.
    switch (env.subtype) {
      case 'task_started':
        // Only TRUE background work (Bash run_in_background = task_type 'local_bash')
        // belongs in the background tray. Subagents (task_type 'local_agent') run in
        // the foreground turn and are ALREADY shown as Agent tool cards; tracking
        // them here too would double-count them AND fire a spurious completion toast
        // when the subagent finishes (the reported bug). Record the local_bash ids so
        // the later task events (which lack a reliable task_type) can be gated too.
        if (env.task_id && env.task_type === 'local_bash') {
          this.bgTaskIds.add(env.task_id)
          return [
            {
              type: 'bg-task-started',
              taskId: env.task_id,
              toolUseId: env.tool_use_id,
              description: env.description ?? 'Background task',
              taskType: env.task_type
            }
          ]
        }
        // A dynamic workflow (ultracode): its own task type + progress stream.
        if (env.task_id && env.task_type === 'local_workflow') {
          this.workflowIds.add(env.task_id)
          return [
            {
              type: 'workflow-started',
              taskId: env.task_id,
              toolUseId: env.tool_use_id,
              name: env.workflow_name ?? 'workflow',
              description: env.description ?? 'Dynamic workflow'
            }
          ]
        }
        // A BACKGROUNDED subagent (local_agent that was announced in a preceding
        // background_tasks_changed snapshot). It keeps running after the turn's result,
        // so it earns a tray handle. `toolUseId` is the Agent tool_use id = the PTU the
        // SubagentView/forwardSubagentText transcript is keyed by, so the tray row can
        // open its transcript. A foreground subagent (not in bgAgentTaskIds) still falls
        // through to `return []` below, unchanged, no double-count, no toast.
        if (env.task_id && env.task_type === 'local_agent' && this.bgAgentTaskIds.has(env.task_id)) {
          this.bgSubagentIds.add(env.task_id)
          // Consumed: the id has done its "was backgrounded" handoff into bgSubagentIds
          // (which gates all later events). Drop it so this Set, the only one without a
          // reclamation path, doesn't retain an id per backgrounded subagent for the
          // whole session. (A later background_tasks_changed can re-add a still-running
          // id; that's fine, it's re-consumed here, so growth stays bounded.)
          this.bgAgentTaskIds.delete(env.task_id)
          return [
            {
              type: 'bg-task-started',
              taskId: env.task_id,
              toolUseId: env.tool_use_id,
              description: env.description ?? 'Background subagent',
              taskType: env.task_type
            }
          ]
        }
        return []
      case 'task_progress': {
        // Live workflow phase/agent tree. workflow_progress[] mixes workflow_phase +
        // workflow_agent items; split them (agents group under phases by phaseIndex).
        if (!env.task_id || !this.workflowIds.has(env.task_id) || !Array.isArray(env.workflow_progress)) {
          return []
        }
        const phases: { index: number; title: string }[] = []
        const agents: {
          index: number
          label: string
          phaseIndex: number
          state: string
          promptPreview?: string
          agentId?: string
        }[] = []
        for (const it of env.workflow_progress) {
          if (it.type === 'workflow_phase' && typeof it.index === 'number') {
            phases.push({ index: it.index, title: it.title ?? `Phase ${it.index}` })
          } else if (it.type === 'workflow_agent' && typeof it.index === 'number') {
            agents.push({
              index: it.index,
              label: it.label ?? `agent ${it.index}`,
              phaseIndex: typeof it.phaseIndex === 'number' ? it.phaseIndex : 0,
              state: it.state ?? 'running',
              promptPreview: it.promptPreview,
              agentId: it.agentId
            })
          }
        }
        return [
          {
            type: 'workflow-progress',
            taskId: env.task_id,
            phases,
            agents,
            totalTokens: env.usage?.total_tokens
          }
        ]
      }
      case 'task_updated':
        // Tracked bg work only: local_bash tasks OR backgrounded subagents. A
        // FOREGROUND subagent's update is not tray work → dropped.
        return env.task_id && (this.bgTaskIds.has(env.task_id) || this.bgSubagentIds.has(env.task_id))
          ? [{ type: 'bg-task-updated', taskId: env.task_id, status: env.patch?.status }]
          : []
      case 'task_notification': {
        // A workflow's terminal notification → workflow-ended (its own path).
        if (env.task_id && this.workflowIds.has(env.task_id)) {
          if (env.status === 'killed' || env.status === 'completed' || env.status === 'failed') {
            this.workflowIds.delete(env.task_id)
          }
          return [{ type: 'workflow-ended', taskId: env.task_id, status: env.status }]
        }
        // Only tracked bg tasks (local_bash OR backgrounded subagent) get a completion
        // toast; a foreground subagent finishing must NOT. Drop the id from its set on a
        // terminal status so it can't linger.
        const tracked =
          Boolean(env.task_id) &&
          (this.bgTaskIds.has(env.task_id as string) || this.bgSubagentIds.has(env.task_id as string))
        if (!tracked) return []
        if (env.status === 'killed' || env.status === 'completed' || env.status === 'failed') {
          this.bgTaskIds.delete(env.task_id as string)
          this.bgSubagentIds.delete(env.task_id as string)
        }
        return [
          {
            type: 'bg-task-notification',
            taskId: env.task_id as string,
            status: env.status,
            summary: env.summary
          }
        ]
      }
      case 'background_tasks_changed': {
        // This snapshot is ALSO the reliable signal that a local_agent subagent was
        // backgrounded (foreground subagents never appear here). Record those task_ids so
        // the imminent task_started can promote them to a tray handle (the snapshot fires
        // BEFORE task_started, verified live). Note the snapshot's task objects carry
        // task_id + task_type but NOT tool_use_id (that comes on task_started).
        for (const t of env.tasks ?? []) {
          if (t.task_id && t.task_type === 'local_agent') this.bgAgentTaskIds.add(t.task_id)
        }
        // Snapshot the running list, keeping ids we track in the tray: local_bash bg
        // shells AND backgrounded subagents. The CLI's raw list can also include
        // foreground agent tasks we don't tray, and those are filtered out.
        return [
          {
            type: 'bg-tasks-changed',
            taskIds: (env.tasks ?? [])
              .map((t) => t.task_id)
              .filter(
                (x): x is string =>
                  Boolean(x) &&
                  (this.bgTaskIds.has(x as string) || this.bgSubagentIds.has(x as string))
              )
          }
        ]
      }
      default:
        return []
    }
  }

  private mapStreamEvent(env: RawEnvelope): DomainEvent[] {
    const ev = env.event
    if (!ev) return []
    switch (ev.type) {
      case 'message_start':
        this.streamedTextSinceStart = false
        return [{ type: 'message-start' }]
      case 'content_block_start': {
        const cb = ev.content_block
        if (cb?.type === 'tool_use' && cb.id) {
          if (typeof ev.index === 'number') this.indexToToolId.set(ev.index, cb.id)
          this.toolInputJson.set(cb.id, '')
          return [{ type: 'tool-use-start', id: cb.id, name: cb.name ?? '' }]
        }
        return []
      }
      case 'content_block_delta': {
        const d = ev.delta
        if (!d) return []
        if (d.type === 'text_delta' && d.text) {
          this.streamedTextSinceStart = true
          return [{ type: 'text-delta', text: d.text }]
        }
        if (d.type === 'thinking_delta' && d.thinking)
          return [{ type: 'thinking-delta', text: d.thinking }]
        if (d.type === 'input_json_delta' && typeof ev.index === 'number') {
          const id = this.indexToToolId.get(ev.index)
          if (id) {
            const partial = d.partial_json ?? ''
            this.toolInputJson.set(id, (this.toolInputJson.get(id) ?? '') + partial)
            return [{ type: 'tool-use-input-delta', id, partialJson: partial }]
          }
        }
        return []
      }
      case 'content_block_stop': {
        if (typeof ev.index !== 'number') return []
        const id = this.indexToToolId.get(ev.index)
        if (id) {
          const jsonStr = this.toolInputJson.get(id) ?? ''
          this.indexToToolId.delete(ev.index)
          this.toolInputJson.delete(id)
          let input: unknown = {}
          try {
            input = jsonStr ? JSON.parse(jsonStr) : {}
          } catch {
            input = { _raw: jsonStr }
          }
          return [{ type: 'tool-use-stop', id, input }]
        }
        return []
      }
      case 'message_delta':
        return [{ type: 'turn-complete', stopReason: ev.delta?.stop_reason ?? null }]
      default:
        return []
    }
  }

  /** Blocks are emitted in block order so the transcript renders text and tool cards
   *  in true stream order. Agent/Task tool_use maps to `subagent-nested` (a spawned
   *  child), any other tool_use to `subagent-tool`. */
  private mapSubagentMessage(env: RawEnvelope): DomainEvent[] {
    const parentToolUseId = env.parent_tool_use_id
    if (!parentToolUseId) return []
    const role = env.message?.role === 'user' ? 'user' : 'assistant'
    const content = env.message?.content
    if (!Array.isArray(content)) return []
    const out: DomainEvent[] = []
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text) {
        out.push({ type: 'subagent-message', parentToolUseId, role, kind: 'text', text: block.text })
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        out.push({ type: 'subagent-message', parentToolUseId, role, kind: 'thinking', text: block.thinking })
      } else if (
        block.type === 'tool_use' &&
        typeof block.id === 'string' &&
        (block.name === 'Agent' || block.name === 'Task')
      ) {
        // Nesting: this subagent spawned a CHILD subagent. Surface it as a nested
        // marker so the UI can render an "Agent →" card inside this transcript that opens
        // the child's own forwarded transcript (which streams under block.id = its PTU).
        // Its text/thinking flow via subagent-message above; dropping this block instead
        // makes nesting invisible in the UI.
        const input = (block.input ?? {}) as { description?: unknown; subagent_type?: unknown }
        out.push({
          type: 'subagent-nested',
          parentToolUseId,
          childToolUseId: block.id,
          name: block.name,
          description: typeof input.description === 'string' ? input.description : undefined,
          subagentType: typeof input.subagent_type === 'string' ? input.subagent_type : undefined
        })
      } else if (block.type === 'tool_use' && typeof block.id === 'string') {
        // A plain tool the subagent ran (Bash, Read, Edit, …). Surfaced so a subagent
        // that shells a slow command isn't silent until its summary lands.
        out.push({
          type: 'subagent-tool',
          parentToolUseId,
          toolUseId: block.id,
          name: block.name ?? '',
          input: block.input ?? {}
        })
      } else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        // The forwarded result arrives in a later `user`-role envelope; the renderer
        // matches it to the card by toolUseId (same id-matching as the main thread).
        out.push({
          type: 'subagent-tool-result',
          parentToolUseId,
          toolUseId: block.tool_use_id,
          content: stringifyResultContent(block.content),
          isError: Boolean(block.is_error)
        })
      }
    }
    return out
  }

  private mapUser(env: RawEnvelope): DomainEvent[] {
    const content = env.message?.content
    if (!Array.isArray(content)) return []
    const out: DomainEvent[] = []
    for (const block of content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        out.push({
          type: 'tool-result',
          toolUseId: block.tool_use_id,
          content: stringifyResultContent(block.content),
          isError: Boolean(block.is_error)
        })
      }
    }
    return out
  }

  private mapControlRequest(env: RawEnvelope): DomainEvent[] {
    const req = env.request
    if (req?.subtype === 'can_use_tool' && env.request_id) {
      return [
        {
          type: 'permission-request',
          requestId: env.request_id,
          toolName: req.tool_name ?? '',
          input: req.input,
          toolUseId: req.tool_use_id,
          title: req.title,
          displayName: req.display_name,
          description: req.description
        }
      ]
    }
    return []
  }
}

/** tool_result content can be a string or an array of blocks; normalize to text. */
function stringifyResultContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''
      )
      .join('')
  }
  if (content == null) return ''
  return JSON.stringify(content)
}
