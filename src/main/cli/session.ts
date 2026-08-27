/**
 * One `ClaudeSession` owns one long-lived `claude` subprocess driven in duplex
 * stream-json mode: user messages are written to stdin as NDJSON, and stdout is
 * parsed into typed DomainEvents.
 *
 *   claude -p --input-format stream-json --output-format stream-json \
 *          --include-partial-messages --verbose [--permission-mode <mode>] \
 *          [--resume <id>]
 *
 * Interactive permission handling is layered on later; the mapper already
 * surfaces `permission-request` events when the CLI emits them.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import type { DomainEvent } from '../../shared/events'
import type { WireAttachment } from '../../shared/ipc'
import { NdjsonParser } from './ndjson'
import { EventMapper } from './event-mapper'

/** A queued/outgoing user turn: text plus any inlined attachment content blocks. */
interface UserTurn {
  text: string
  attachments?: WireAttachment[]
}

export interface ClaudeSessionOptions {
  cliPath: string
  cwd: string
  resumeSessionId?: string
  /**
   * Permission mode forwarded as `--permission-mode`. Leave undefined to pass NO
   * flag, and the CLI then honors the user's ~/.claude/settings.json defaultMode
   * (the "inherit" behavior). Any concrete value overrides just that field.
   */
  permissionMode?: string
  /**
   * Interactive permission gating. Always true in the app: the session
   * appends `--permission-prompt-tool stdio`, performs the `initialize` control
   * handshake, and defers user messages until the CLI ACKs it. This opens the
   * approve/deny channel so that WHENEVER the CLI decides to ask (which depends
   * on the resolved permission mode), the request surfaces as a
   * `permission-request` event answerable via `respondPermission`. It is inert
   * (no dialog) when the mode never asks (e.g. bypassPermissions).
   */
  gated?: boolean
  /** Value for `--model`. Undefined = pass no flag (CLI/settings default). */
  model?: string
  /** Value for `--effort`. Undefined = pass no flag. Live-changeable via apply_flag_settings. */
  effort?: string
  /** Ultracode on (forces xhigh + workflow orchestration). Passed at launch via
   *  `--settings {ultracode:true}` so it survives a resume; toggled live otherwise. */
  ultracode?: boolean
  /** With `resumeSessionId`, pass `--fork-session` → the CLI branches to a NEW
   *  session id carrying the resumed context, leaving the original jsonl untouched
   *  (verified live 2.1.220). Fork-from-HEAD only. Ignored without a resume id. */
  fork?: boolean
  /** Session title → `-n` (see buildArgs). */
  name?: string
  /** Extra env for the child (merged over process.env). */
  env?: Record<string, string>
}

export declare interface ClaudeSession {
  on(event: 'event', listener: (e: DomainEvent) => void): this
  on(event: 'exit', listener: (code: number | null) => void): this
}

export class ClaudeSession extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly parser = new NdjsonParser()
  private readonly mapper = new EventMapper()
  /** CLI-assigned session id, captured from the init event. */
  private sessionId: string | null = null
  private closed = false

  // --- Gated-mode handshake state ---
  /** request_id of our initialize control_request, if gated. */
  private initRequestId: string | null = null
  /** True once the CLI ACKs the initialize handshake. */
  private initAcked = false
  /** User messages queued until the handshake completes (gated mode only). */
  private pendingSends: UserTurn[] = []
  /** True while an effort-driven respawn is in progress (suppresses exit event). */
  private respawning = false
  /**
   * In-flight control_requests awaiting their control_response, keyed by request_id
   * (general control-protocol client). `resolve(true)` on a `success` response,
   * `resolve(false)` on `error` / no-response timeout, so callers can fall back.
   * The init handshake stays on its own `initRequestId`/`initAcked` path (it gates
   * message flushing and predates this map).
   */
  private pendingControl = new Map<string, { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>()

  // Mutable so live changes (set_model) and respawns (effort) can update them.
  private opts: ClaudeSessionOptions

  constructor(opts: ClaudeSessionOptions) {
    super()
    this.opts = opts
  }

  getSessionId(): string | null {
    return this.sessionId
  }

  private buildArgs(): string[] {
    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose'
    ]
    if (this.opts.gated) {
      // The `stdio` sentinel routes any tool the CLI decides to ask about through
      // the control protocol (can_use_tool) instead of auto-denying. Verified
      // inert when the resolved mode never asks (e.g. bypassPermissions).
      args.push('--permission-prompt-tool', 'stdio')
    }
    // Forward --permission-mode ONLY when a concrete mode is set. Omitting it lets
    // the CLI honor the user's ~/.claude/settings.json defaultMode ("inherit").
    if (this.opts.permissionMode) {
      args.push('--permission-mode', this.opts.permissionMode)
    }
    if (this.opts.name?.trim()) {
      // Whitespace-only name → no flag, so a blank name spawns an unnamed session.
      args.push('-n', this.opts.name.trim())
    }
    if (this.opts.model) {
      args.push('--model', this.opts.model)
    }
    if (this.opts.effort) {
      args.push('--effort', this.opts.effort)
    }
    if (this.opts.ultracode) {
      // Ultracode is a session setting (not --effort). Pass it at launch via --settings
      // inline JSON (verified) so a resume restores it. Clui's own arg, never ~/.claude.
      args.push('--settings', JSON.stringify({ ultracode: true }))
    }
    if (this.opts.resumeSessionId) {
      args.push('--resume', this.opts.resumeSessionId)
      // Fork branches the resumed session to a new id (original untouched). Only
      // meaningful alongside --resume; the CLI ignores it otherwise.
      if (this.opts.fork) args.push('--fork-session')
    }
    return args
  }

  start(): void {
    if (this.child) throw new Error('session already started')
    this.spawnChild()
  }

  private spawnChild(): void {
    // Reset per-spawn handshake state (a respawn re-runs the initialize dance).
    this.initRequestId = null
    this.initAcked = false

    // Guard: if the workspace folder no longer exists, spawn() throws a cryptic
    // ENOENT that names the *binary* path (misleading, since it looks like the CLI is
    // missing when really the cwd is gone; e.g. resuming a session whose folder
    // was deleted). Detect it up front and surface a clear, actionable error, then
    // tear the session down instead of spawning into a bad cwd.
    if (!existsSync(this.opts.cwd)) {
      this.emitEvent({
        type: 'error',
        message: `Can't resume: ${this.opts.cwd} no longer exists. The transcript is safe. You can still export or delete it from the row menu.`
      })
      if (!this.closed) {
        this.closed = true
        this.emitEvent({ type: 'process-exit', code: null })
        this.emit('exit', null)
      }
      return
    }

    const child = spawn(this.opts.cliPath, this.buildArgs(), {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child

    // Gated mode: the CLI emits NOTHING (not even the init event) until the
    // client sends the `initialize` control_request. Send it immediately on
    // spawn; user messages are queued until its success ACK arrives.
    if (this.opts.gated) {
      this.initRequestId = `init-${randomUUID()}`
      this.writeLine({
        type: 'control_request',
        request_id: this.initRequestId,
        // forwardSubagentText makes the CLI stream a running subagent's own
        // assistant/user text as envelopes tagged with parent_tool_use_id (verified
        // live). Without it, only tool_use/tool_result forward as agent_progress.
        request: { subtype: 'initialize', forwardSubagentText: true }
      })
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk))

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      // CLI writes benign diagnostics to stderr too (e.g. "Warning: Opus 4.8 not
      // available, using Opus 4.7 for this session"). These are NOT errors: the CLI
      // already handled the fallback, so styling them as a red error (and, at startup,
      // also as a top banner) would mislead and duplicate. Only surface a line as an
      // error if it doesn't self-identify as a warning/info note.
      const text = chunk.trim()
      if (!text) return
      if (/^(warning|warn|note|info)\b[:\s]/i.test(text)) return // benign diagnostic; drop
      // [claude-code:...] tags are machine diagnostics for SDK consumers, not user errors.
      if (/^\[claude-code:/i.test(text)) return
      // An untrusted workspace still runs, so these notices aren't failures. The context
      // guard keeps a genuine "certificate not trusted" error red.
      const untrusted =
        /^Ignoring \d+ permissions?\.(?:allow|deny|ask)\b/i.test(text) ||
        ((/\bnot (?:been )?trusted\b/i.test(text) || /\bno persisted trust\b/i.test(text)) &&
          /\b(?:workspace|folder|trust dialog|hasTrustDialogAccepted|frontmatter hooks|plugins?)\b/i.test(text))
      if (untrusted) {
        this.emitEvent({ type: 'error', severity: 'info', message: text })
        return
      }
      this.emitEvent({ type: 'error', message: text })
    })

    child.on('error', (err) => {
      this.emitEvent({ type: 'error', message: `spawn failed: ${err.message}` })
      // A spawn failure (e.g. ENOENT from a wrong CLI path) fires 'error' but NOT
      // 'close', so without this the session would never emit process-exit and
      // would linger forever as a phantom "live" session. Tear it down like an
      // exit so the manager drops it and the renderer stops counting it as live.
      // Guard against a later 'close' double-firing via `closed`.
      if (this.respawning || this.closed) return
      this.closed = true
      this.child = null
      this.emitEvent({ type: 'process-exit', code: null })
      this.emit('exit', null)
    })

    child.on('close', (code) => {
      // A real stop() ran (closed=true): never respawn, even mid-effort-respawn. This
      // guard MUST precede the respawning branch, else a stop()/stopAll() that lands in
      // the window between respawnForEffort's SIGTERM and this 'close' would take the
      // respawning branch and spawnChild() a NEW orphaned process after the handle was
      // already deleted from the manager. (Mirrors the 'error' handler, which already
      // guards on both flags.)
      if (this.closed) return
      // An effort change respawns the process; swallow this exit and relaunch.
      if (this.respawning) {
        this.respawning = false
        this.child = null
        this.spawnChild()
        return
      }
      this.closed = true
      // Flush any trailing buffered line.
      for (const raw of this.parser.flush()) {
        for (const ev of this.mapper.map(raw)) this.emitEvent(ev)
      }
      this.emitEvent({ type: 'process-exit', code })
      this.emit('exit', code)
    })
  }

  private onStdout(chunk: string): void {
    for (const raw of this.parser.push(chunk)) {
      // In gated mode, intercept control-protocol envelopes (the mapper ignores
      // control_response) to drive the handshake before mapping to domain events.
      if (this.opts.gated) this.handleControlEnvelope(raw)
      for (const ev of this.mapper.map(raw)) {
        if (ev.type === 'session-init' && ev.sessionId) this.sessionId = ev.sessionId
        this.emitEvent(ev)
      }
    }
  }

  /**
   * Gated-mode handshake driver. The `initialize` request is sent on spawn (see
   * `start`); here we watch for its `control_response` success ACK and, once it
   * arrives, flush any queued user messages.
   */
  private handleControlEnvelope(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return
    const env = raw as {
      type?: string
      response?: { subtype?: string; request_id?: string; response?: { commands?: unknown } }
    }
    if (env.type !== 'control_response') return
    const reqId = env.response?.request_id
    const ok = env.response?.subtype === 'success'

    // Init handshake ACK: flush queued user messages once.
    if (ok && reqId === this.initRequestId && !this.initAcked) {
      this.initAcked = true
      // The initialize response carries the CLI's live slash-command list. Surface
      // it so the composer's `/` menu tracks the real commands (drift-proof) instead of
      // a hardcoded list. Defensive: only emit well-formed {name,description} entries.
      const cmds = env.response?.response?.commands
      if (Array.isArray(cmds)) {
        const commands = cmds
          .filter((c): c is { name: string; description?: string; argumentHint?: string; aliases?: string[] } =>
            Boolean(c && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string')
          )
          .map((c) => ({
            name: c.name,
            description: typeof c.description === 'string' ? c.description : '',
            argumentHint: typeof c.argumentHint === 'string' ? c.argumentHint : undefined,
            aliases: Array.isArray(c.aliases) ? c.aliases.filter((a) => typeof a === 'string') : undefined
          }))
        if (commands.length) this.emitEvent({ type: 'slash-commands', commands })
      }
      const queued = this.pendingSends
      this.pendingSends = []
      for (const turn of queued) this.writeUserMessage(turn)
      return
    }

    // A general awaited control_request: resolve its promise with success/failure.
    if (reqId && this.pendingControl.has(reqId)) {
      const p = this.pendingControl.get(reqId)!
      this.pendingControl.delete(reqId)
      clearTimeout(p.timer)
      p.resolve(ok)
    }
  }

  /**
   * Send a control_request and await its control_response. Resolves true on a
   * `success` response, false on `error` or if no response arrives within `timeoutMs`
   * (so callers can fall back). Fire-and-forget callers can ignore the promise.
   * NOTE: only reliable for the CLI's directly-handled ("worker allowlist") subtypes.
   * Callback-gated getters (get_context_usage, etc.) never respond over the wire
   * and would always time out to false (verified).
   */
  private sendControl(subtype: string, extra: Record<string, unknown> = {}, timeoutMs = 5000): Promise<boolean> {
    const requestId = `ctl-${randomUUID()}`
    if (!this.child || this.child.stdin.destroyed) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(requestId)
        resolve(false)
      }, timeoutMs)
      this.pendingControl.set(requestId, { resolve, timer })
      this.writeLine({ type: 'control_request', request_id: requestId, request: { subtype, ...extra } })
    })
  }

  private emitEvent(e: DomainEvent): void {
    this.emit('event', e)
  }

  private writeLine(obj: unknown): void {
    if (!this.child || this.child.stdin.destroyed) return
    this.child.stdin.write(JSON.stringify(obj) + '\n')
  }

  /**
   * Send a user message into the session, optionally with inlined images. In gated
   * mode, messages sent before the initialize handshake completes are queued and
   * flushed on ACK.
   */
  send(text: string, attachments?: WireAttachment[]): void {
    const turn: UserTurn = { text, attachments }
    if (this.opts.gated && !this.initAcked) {
      this.pendingSends.push(turn)
      return
    }
    this.writeUserMessage(turn)
  }

  /**
   * Write a user turn to the CLI stdin as NDJSON. With no attachments, `content` stays
   * a plain string (the historical shape). With attachments, `content` becomes an
   * Anthropic content-block array (attachment blocks first, then the text block),
   * which the CLI accepts inline in duplex stream-json (all three kinds verified live
   * on 2.1.209). The text block is omitted when empty (an attachments-only turn is
   * valid). A dropped text FILE rides as a `text` block wrapped in a `<file name>`
   * delimiter so the model knows what it is (mechanically identical to a paste, no
   * Read tool, so it works regardless of the workspace-cwd boundary).
   */
  private writeUserMessage(turn: UserTurn): void {
    const { text, attachments } = turn
    if (!attachments || attachments.length === 0) {
      this.writeLine({ type: 'user', message: { role: 'user', content: text } })
      return
    }
    const content: unknown[] = attachments.map((a) => {
      switch (a.kind) {
        case 'image':
          return { type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } }
        case 'document':
          return { type: 'document', source: { type: 'base64', media_type: a.mediaType, data: a.data } }
        case 'text':
          return { type: 'text', text: `<file name="${a.name}">\n${a.text}\n</file>` }
      }
    })
    if (text) content.push({ type: 'text', text })
    this.writeLine({ type: 'user', message: { role: 'user', content } })
  }

  /**
   * Change the permission mode of THIS running session via the control protocol
   * (`set_permission_mode`). Takes effect for subsequent tool calls; verified to
   * work mid-session. Does not touch any settings file.
   *
   * Also persists the new mode into `opts.permissionMode` so a later effort-driven
   * respawn (which rebuilds argv from opts) keeps it, else the respawn would
   * silently revert to the launch-time mode. The renderer maps 'inherit' → 'default'
   * before calling this (there's no mid-session "unset"), so `mode` is concrete here.
   */
  setPermissionMode(mode: string): void {
    this.opts = { ...this.opts, permissionMode: mode }
    this.writeLine({
      type: 'control_request',
      request_id: `sm-${randomUUID()}`,
      request: { subtype: 'set_permission_mode', mode }
    })
  }

  /**
   * Change the model of THIS running session live via the control protocol
   * (`set_model`). Verified to work mid-session. Also updates opts so a later
   * effort-respawn keeps the new model.
   */
  setModel(model: string): void {
    this.opts = { ...this.opts, model }
    this.writeLine({
      type: 'control_request',
      request_id: `sm-${randomUUID()}`,
      request: { subtype: 'set_model', model }
    })
  }

  /**
   * Change the effort of THIS session LIVE via the control protocol
   * (`apply_flag_settings {settings:{effortLevel}}`), verified directly-handled by
   * the CLI worker, so no process restart is needed (same path model switching uses).
   * Persists into opts so any later respawn keeps it. Falls back to a respawn-with-
   * `--resume` if the live control_request errors or times out, since the protocol is
   * undocumented and drifts across CLI versions, so we degrade rather than fail.
   */
  async setEffort(effort: string): Promise<void> {
    if (this.opts.effort === effort) return
    this.opts = { ...this.opts, effort, resumeSessionId: this.sessionId ?? this.opts.resumeSessionId }
    if (!this.child) return
    // Live effort change over the control protocol (verified directly-handled);
    // respawn fallback if the control_request errors or times out.
    const ok = await this.sendControl('apply_flag_settings', { settings: { effortLevel: effort } })
    if (!ok) {
      this.emitEvent({ type: 'error', severity: 'info', message: `Live effort change unavailable — reconnecting to apply "${effort}"…` })
      this.respawnForEffort()
    }
  }

  /**
   * Toggle ultracode LIVE (`apply_flag_settings {ultracode}`). Ultracode forces xhigh
   * reasoning + workflow-orchestration disposition; the `Workflow` tool is present at
   * every effort level (verified), so this is a pure live setting, NO respawn. Persisted
   * into opts so a respawn (e.g. effort fallback) keeps it.
   */
  async setUltracode(on: boolean): Promise<void> {
    this.opts = { ...this.opts, ultracode: on, resumeSessionId: this.sessionId ?? this.opts.resumeSessionId }
    if (!this.child) return
    await this.sendControl('apply_flag_settings', { settings: { ultracode: on } })
  }

  /** Fallback: respawn with `--effort <effort> --resume <sessionId>` (the pre-control-protocol
   *  mechanism), used only when the live `apply_flag_settings` path fails. */
  private respawnForEffort(): void {
    if (!this.child) return
    this.respawning = true
    try {
      this.child.stdin.end()
    } catch {
      /* ignore */
    }
    this.child.kill('SIGTERM')
    // The 'close' handler sees respawning=true and relaunches with the new opts.
  }

  /** Interrupt the current turn via the control protocol. */
  interrupt(): void {
    // Flag the mapper so the interrupt's is_error result isn't surfaced as an error box.
    this.mapper.markInterrupted()
    this.writeLine({
      type: 'control_request',
      request_id: `int-${Date.now().toString(36)}`,
      request: { subtype: 'interrupt' }
    })
  }

  /** Kill a background task directly via the control protocol (`stop_task`), verified to
   *  terminate it and emit task_updated:killed with no model turn. Returns false on
   *  error/timeout so the caller can fall back to the tool-mediated stop. */
  stopTask(taskId: string): Promise<boolean> {
    return this.sendControl('stop_task', { task_id: taskId })
  }

  /** Move a RUNNING foreground tool to the background; it keeps running in the tray.
   *  Must be sent while the task runs (after task_started), else it returns backgrounded:false. */
  backgroundTask(toolUseId: string): Promise<boolean> {
    return this.sendControl('background_tasks', { tool_use_id: toolUseId })
  }

  /**
   * Answer a pending permission request. `allow` echoes/overrides the input;
   * deny surfaces `message` back to the model.
   */
  respondPermission(
    requestId: string,
    verdict: { behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string }
  ): void {
    this.writeLine({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: verdict
      }
    })
  }

  stop(): void {
    // Cancel any in-flight effort-respawn: without this, a 'close' still pending from
    // respawnForEffort's SIGTERM would resurrect the child even though we're tearing it
    // down for good. (The 'close' handler also guards on `closed` first; this is the
    // belt to that suspenders, since a pending respawn must not survive an explicit stop.)
    this.respawning = false
    // Resolve any awaited control_requests as failed + clear their timers.
    for (const [, p] of this.pendingControl) {
      clearTimeout(p.timer)
      p.resolve(false)
    }
    this.pendingControl.clear()
    if (!this.child) return
    this.closed = true
    try {
      this.child.stdin.end()
    } catch {
      /* ignore */
    }
    this.child.kill('SIGTERM')
    // Escalate to SIGKILL if the child ignores SIGTERM. Guard on LIVENESS, not
    // `child.killed`: Node sets `killed` true the moment a signal is SENT (the SIGTERM
    // above already did), so `!child.killed` would be permanently false and the escalation
    // would never fire. `exitCode`/`signalCode` are both null only while the process is
    // still alive, the real "did it actually exit?" check.
    const child = this.child
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }
    }, 2000)
    this.child = null
  }
}
