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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { DomainEvent, ElicitationResponse } from '../../shared/events'
import type { DispatchResult, ModeChangeResult, ModelSwitchResult } from '../../shared/ipc'
import { clampEffort, deriveModelInfo, effortsFromCatalog, isEffortChoice, setLiveEfforts } from '../../shared/settings'
import { NdjsonParser } from './ndjson'
import { EventMapper } from './event-mapper'
import { stripRuntimeMarkers } from './shell-env'
import { recordTurnUsage } from '../sessions/usage'

/** `onWritten` runs right after this exact envelope is written, never for a preparation that isn't. */
type Prepared = { ok: true; content: string | unknown[]; text: string; onWritten?: () => void } | Extract<DispatchResult, { ok: false }>

const GONE = 'This session is no longer running.'

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
  /** From the `enableTaskTools` setting; an explicit shell value wins (see childEnv). */
  enableTaskTools?: boolean
  /** Quick chat: pass `--no-session-persistence` so nothing is written to disk. */
  ephemeral?: boolean
  /** Ultracode on (workflow orchestration at the current effort). Passed at launch via
   *  `--settings {ultracode:true}` so it survives a resume; toggled live otherwise. */
  ultracode?: boolean
  /** With `resumeSessionId`, pass `--fork-session` → the CLI branches to a NEW
   *  session id carrying the resumed context, leaving the original jsonl untouched
   *  (verified live 2.1.220). Fork-from-HEAD only. Ignored without a resume id. */
  fork?: boolean
  /** Session title → `-n` (see buildArgs). */
  name?: string
  /** Clui's own MCP servers: the config JSON (tokens inside, so it goes to a 0600 file) and the exact allow rules. */
  cluiMcp?: { config: string; allow: string[] }
  /** An MCP config file passed as-is next to Clui's (the elicitation probe's stub server). */
  mcpConfigPath?: string
  /** Extra env for the child (merged over process.env). */
  env?: Record<string, string>
  /** From `classifierEnv`. Merged last, over the shell's values. */
  classifierEnv?: Record<string, string>
}

/**
 * The child's env. The task-tools default goes under process.env so an explicit shell value wins,
 * while the classifier vars go over it: once the user turns the local classifier on in Clui, a stray
 * shell value must not change which model gets billed, including a shell pin when Clui chose none.
 * Runtime markers are stripped from the final merge so a Clui launched inside a Claude Code session
 * doesn't leak its own markers into the child.
 */
export function childEnv(
  opts: Pick<ClaudeSessionOptions, 'enableTaskTools' | 'env' | 'classifierEnv'>,
  base: NodeJS.ProcessEnv = process.env
): Record<string, string | undefined> {
  const env = stripRuntimeMarkers({ CLAUDE_CODE_ENABLE_TODO_TOOLS: opts.enableTaskTools ? '1' : '0', ...base, ...opts.env })
  if (opts.classifierEnv?.CLAUDE_CODE_AUTO_MODE_SERVER) delete env.CLAUDE_CODE_AUTO_MODE_MODEL
  return { ...env, ...opts.classifierEnv }
}

export declare interface ClaudeSession {
  on(event: 'event', listener: (e: DomainEvent) => void): this
  on(event: 'exit', listener: (code: number | null) => void): this
  /** Raw user/assistant envelopes, for the change ledger: they carry tool results the mapper drops. */
  on(event: 'wire', listener: (raw: unknown) => void): this
}

/** Result of an awaited control_request: success flag + the response payload (so a
 *  caller can inspect fields like `background_tasks`' `backgrounded`, not just success). */
interface ControlResult {
  ok: boolean
  payload?: Record<string, unknown>
  errorCode?: string
  error?: string
  timedOut?: true
}

/**
 * Tools withheld from a Quick (ephemeral) session via `--disallowedTools`: sub-agent
 * orchestration, workflows, cron, worktrees, and plan mode. Read/Edit/Write/Bash/WebFetch/
 * Skill/ToolSearch/NotebookEdit/ReportFindings stay available, so a quick chat can still read
 * and edit. Task-tracking tools (TaskCreate/…) are governed by enableTaskTools, not this list.
 * Names verified live on CLI 2.1.310.
 */
const EPHEMERAL_DISALLOWED_TOOLS = [
  'Task',
  'TaskOutput',
  'TaskStop',
  'ListAgents',
  'SendMessage',
  'Workflow',
  'CronCreate',
  'CronDelete',
  'CronList',
  'ScheduleWakeup',
  'Monitor',
  'EnterWorktree',
  'ExitWorktree',
  'EnterPlanMode',
  'ExitPlanMode'
]

/** Bounded wait for the initialize ACK. The first launch is cold (Bedrock auth + model-list
 *  warm-up precede the ACK) and can take tens of seconds; a stall past this is a failed
 *  start, not slow reasoning. */
const INIT_TIMEOUT_MS = 60_000

export class ClaudeSession extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  // Recreated per child generation (a respawn must not reuse a decoder holding the old
  // child's half-line or a mapper holding its per-connection state).
  private parser = new NdjsonParser()
  private mapper = new EventMapper()
  /** Monotonic child-generation counter; bumped on every spawn so a retired child's
   *  late stdout/stderr/close can be ignored. */
  private generation = 0
  /** CLI-assigned session id, captured from the init event. */
  private sessionId: string | null = null
  private closed = false

  // --- Gated-mode handshake state ---
  /** request_id of our initialize control_request, if gated. */
  private initRequestId: string | null = null
  /** True once the CLI ACKs the initialize handshake. */
  private initAcked = false
  /** Fires if the initialize ACK never arrives; cleared on ack/close. */
  private initTimer: ReturnType<typeof setTimeout> | null = null
  /** True between ending the old child's stdin and the replacement's init ACK, so a
   *  send in that window is queued (not written to an ended stream). */
  private reconnecting = false
  private respawned = false
  /** User messages go through one chain, so a slow validation can't reorder them. */
  private outbox: Promise<unknown> = Promise.resolve()
  /** Bumped by a Stop: a message sent before it and not yet written is cancelled. */
  private cancelEpoch = 0
  private writers: { resolve: () => void; reject: (e: Error) => void }[] = []
  /** True while the effort-fallback respawn is in progress (suppresses exit event). */
  private respawning = false
  /** Holds the browser tools' MCP config for the spawn that hasn't reported init yet. */
  private mcpDir: string | null = null
  /** Partial trailing stderr line held until its newline arrives, so classification
   *  runs per complete line, not per arbitrary transport chunk. */
  private stderrBuf = ''
  /** Send-now messages waiting for the CLI to queue them before the interrupt goes out, by uuid. */
  private pendingCuts = new Map<string, ReturnType<typeof setTimeout>>()
  /** request_ids of elicitations the user hasn't answered yet. */
  private elicitations = new Set<string>()
  /**
   * In-flight control_requests awaiting their control_response, keyed by request_id
   * (general control-protocol client). Resolves `{ok, payload}` on the response, or
   * `{ok:false}` on `error` / no-response timeout, so callers can fall back or inspect
   * the payload. The init handshake stays on its own `initRequestId`/`initAcked` path
   * (it gates message flushing and predates this map).
   */
  private pendingControl = new Map<string, { resolve: (r: ControlResult) => void; timer: ReturnType<typeof setTimeout> }>()

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
    if (this.opts.ephemeral) {
      // Quick chat: the CLI streams normally but writes no transcript to disk.
      args.push('--no-session-persistence')
      // Locked-down tool set for a throwaway session. --disallowedTools is variadic, so a
      // following flag (--resume) or the end of the bare args terminates the list.
      args.push('--disallowedTools', ...EPHEMERAL_DISALLOWED_TOOLS)
    }
    const mcp = this.opts.cluiMcp ? [this.writeMcpConfig(this.opts.cluiMcp.config)] : []
    if (this.opts.mcpConfigPath) mcp.push(this.opts.mcpConfigPath)
    // Both flags are variadic; the --resume that follows (or the end of args) closes each list.
    if (mcp.length) args.push('--mcp-config', ...mcp)
    if (this.opts.cluiMcp?.allow.length) args.push('--allowedTools', ...this.opts.cluiMcp.allow)
    if (this.opts.resumeSessionId) {
      args.push('--resume', this.opts.resumeSessionId)
      // Fork branches the resumed session to a new id (original untouched). Only
      // meaningful alongside --resume; the CLI ignores it otherwise.
      if (this.opts.fork) args.push('--fork-session')
    }
    return args
  }

  /** The config carries the tools' bearer token, and argv is readable by other processes, so it goes
   *  in a file only this user can read. The CLI has loaded it by the time its init arrives. */
  private writeMcpConfig(json: string): string {
    this.dropMcpConfig()
    this.mcpDir = mkdtempSync(join(tmpdir(), 'clui-mcp-'))
    const file = join(this.mcpDir, 'config.json')
    writeFileSync(file, json, { mode: 0o600 })
    return file
  }

  private dropMcpConfig(): void {
    if (this.mcpDir) rmSync(this.mcpDir, { recursive: true, force: true })
    this.mcpDir = null
  }

  start(): void {
    if (this.child) throw new Error('session already started')
    this.spawnChild()
  }

  private spawnChild(): void {
    // Reset per-spawn handshake state (a respawn re-runs the initialize dance) and give
    // this generation a fresh decoder + mapper so no half-line or per-connection state
    // leaks across the reconnect.
    const gen = ++this.generation
    this.initRequestId = null
    this.initAcked = false
    this.reconnecting = false
    this.parser = new NdjsonParser()
    this.mapper = new EventMapper(this.opts.model)
    if (gen > 1) this.emitEvent({ type: 'mod-status-reset' })
    this.stderrBuf = ''
    if (this.initTimer) {
      clearTimeout(this.initTimer)
      this.initTimer = null
    }

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
        this.failWriters()
        this.emitEvent({ type: 'process-exit', code: null })
        this.emit('exit', null)
      }
      return
    }

    const child = spawn(this.opts.cliPath, this.buildArgs(), {
      cwd: this.opts.cwd,
      env: childEnv(this.opts),
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child
    // Consume `fork` on respawn: a reconnect resumes the already-forked session, so
    // re-passing --fork-session would branch again. Keep `name`: without a re-fork the
    // same `-n` is idempotent and preserves the customTitle mirror the CLI else re-derives.
    if (this.opts.fork) this.opts = { ...this.opts, fork: false }

    // stdin errors (EPIPE from a crashed child, write-after-end during a reconnect) are
    // emitted asynchronously; without a listener Node throws them as uncaught. Swallow
    // them here; the 'close'/'error' handlers own teardown.
    child.stdin.on('error', () => {})
    if (!this.opts.gated) this.releaseWriters()

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
        // perTaskStopAffordance: the tray stops background tasks one by one (stop_task), so a Stop
        // only aborts the turn and spares them. Public protocol (2.1.296); re-verify on a CLI bump.
        request: { subtype: 'initialize', forwardSubagentText: true, perTaskStopAffordance: true }
      })
      this.initTimer = setTimeout(() => {
        if (this.initAcked || this.closed || gen !== this.generation) return
        this.emitEvent({
          type: 'error',
          message: 'The session did not start (no response from the CLI). Try resuming it again.'
        })
        this.teardown(null)
      }, INIT_TIMEOUT_MS)
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (gen !== this.generation) return // late output from a retired child
      this.onStdout(chunk)
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (gen !== this.generation) return
      this.onStderr(chunk)
    })

    child.on('error', (err) => {
      if (gen !== this.generation) return
      this.emitEvent({ type: 'error', message: `spawn failed: ${err.message}` })
      // A spawn failure (e.g. ENOENT from a wrong CLI path) fires 'error' but NOT
      // 'close', so without this the session would never emit process-exit and
      // would linger forever as a phantom "live" session. Tear it down like an
      // exit so the manager drops it and the renderer stops counting it as live.
      // Guard against a later 'close' double-firing via `closed`.
      if (this.respawning || this.closed) return
      this.child = null
      this.teardown(null)
    })

    child.on('close', (code) => {
      if (gen !== this.generation && !this.respawning) return
      // A real stop() ran (closed=true): never respawn, even mid-effort-respawn. This
      // guard MUST precede the respawning branch, else a stop()/stopAll() that lands in
      // the window between respawnWith's SIGTERM and this 'close' would take the
      // respawning branch and spawnChild() a NEW orphaned process after the handle was
      // already deleted from the manager. (Mirrors the 'error' handler, which already
      // guards on both flags.)
      if (this.closed) return
      // A respawn is in flight; swallow this exit and relaunch.
      if (this.respawning) {
        this.respawning = false
        this.child = null
        this.spawnChild()
        return
      }
      this.teardown(code)
    })
  }

  /**
   * Terminal teardown for a spawn/init failure or a real process close: flush the
   * decoder's trailing line, stop the init timer, and emit process-exit exactly once.
   */
  private teardown(code: number | null): void {
    if (this.closed) return
    this.closed = true
    this.failWriters()
    if (this.initTimer) {
      clearTimeout(this.initTimer)
      this.initTimer = null
    }
    this.dropMcpConfig()
    this.cancelElicitations()
    if (this.stderrBuf.trim()) this.classifyStderrLine(this.stderrBuf)
    this.stderrBuf = ''
    for (const raw of this.parser.flush()) {
      this.emitWire(raw)
      for (const ev of this.mapper.map(raw)) this.emitEvent(ev)
    }
    this.emitEvent({ type: 'process-exit', code })
    this.emit('exit', code)
  }

  private onStdout(chunk: string): void {
    for (const raw of this.parser.push(chunk)) {
      // In gated mode, intercept control-protocol envelopes (the mapper ignores
      // control_response) to drive the handshake before mapping to domain events.
      if (this.opts.gated) this.handleControlEnvelope(raw)
      this.emitWire(raw)
      const life = raw as { type?: string; command_uuid?: string; state?: string }
      if (life?.type === 'command_lifecycle' && life.command_uuid && this.pendingCuts.has(life.command_uuid)) {
        if (life.state === 'queued') this.cutFor(life.command_uuid)
        else {
          clearTimeout(this.pendingCuts.get(life.command_uuid))
          this.pendingCuts.delete(life.command_uuid)
        }
      }
      for (const ev of this.mapper.map(raw)) {
        if (ev.type === 'session-init' && ev.sessionId) this.sessionId = ev.sessionId
        if (ev.type === 'session-init') this.dropMcpConfig()
        if (ev.type === 'elicitation-request') this.elicitations.add(ev.requestId)
        if (ev.type === 'permission-cancel') this.elicitations.delete(ev.requestId)
        this.emitEvent(ev)
      }
    }
  }

  /** Classify stderr per COMPLETE line (a benign warning and a following fatal can
   *  arrive in one chunk, and a warning can split across two). Holds the trailing
   *  partial line until its newline; `flushStderr` drains it on close. */
  private onStderr(chunk: string): void {
    this.stderrBuf += chunk
    let nl: number
    while ((nl = this.stderrBuf.indexOf('\n')) >= 0) {
      const line = this.stderrBuf.slice(0, nl)
      this.stderrBuf = this.stderrBuf.slice(nl + 1)
      this.classifyStderrLine(line)
    }
  }

  private classifyStderrLine(raw: string): void {
    // CLI writes benign diagnostics to stderr too (e.g. "Warning: Opus 4.8 not
    // available, using Opus 4.7 for this session"). These are NOT errors: the CLI
    // already handled the fallback, so styling them as a red error (and, at startup,
    // also as a top banner) would mislead and duplicate. Only surface a line as an
    // error if it doesn't self-identify as a warning/info note.
    const text = raw.trim()
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
    // A Bedrock model newer than the CLI still runs with a guessed context window. The docs link is for gateway ids;
    // Clui's come from Bedrock, where updating the CLI is the fix.
    if (/^Claude Code doesn't recognize the model\b/i.test(text)) {
      this.emitEvent({ type: 'error', severity: 'info', message: text.replace(/, or see \S+ to set the window\.$/, '.') })
      return
    }
    this.emitEvent({ type: 'error', message: text })
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
      response?: { subtype?: string; request_id?: string; response?: Record<string, unknown>; error_code?: string; error?: unknown }
    }
    if (env.type !== 'control_response') return
    const reqId = env.response?.request_id
    const ok = env.response?.subtype === 'success'

    // Init handshake: an explicit error ACK is a failed start, not something to wait out.
    if (!ok && reqId === this.initRequestId && !this.initAcked) {
      this.emitEvent({ type: 'error', message: 'The CLI rejected the session handshake.' })
      this.teardown(null)
      return
    }

    // Init handshake ACK: flush queued user messages once.
    if (ok && reqId === this.initRequestId && !this.initAcked) {
      this.initAcked = true
      if (this.initTimer) {
        clearTimeout(this.initTimer)
        this.initTimer = null
      }
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
      const efforts = effortsFromCatalog(env.response?.response?.models)
      if (Object.keys(efforts).length) {
        setLiveEfforts(efforts)
        this.emitEvent({ type: 'model-efforts', efforts })
      }
      if (this.respawned) {
        this.respawned = false
        this.emitEvent({ type: 'reconnected' })
      }
      this.releaseWriters()
      return
    }

    // A general awaited control_request: resolve its promise with success + payload.
    if (reqId && this.pendingControl.has(reqId)) {
      const p = this.pendingControl.get(reqId)!
      this.pendingControl.delete(reqId)
      clearTimeout(p.timer)
      const error = env.response?.error
      p.resolve({
        ok,
        payload: env.response?.response,
        errorCode: env.response?.error_code,
        error: typeof error === 'string' ? error : undefined
      })
    }
  }

  /**
   * Send a control_request and await its control_response, returning the full result
   * (success flag + response payload). Resolves `{ok:false}` on `error`, and
   * `{ok:false, timedOut:true}` if no response arrives within `timeoutMs` (so callers can fall back).
   * NOTE: only reliable for the CLI's directly-handled ("worker allowlist") subtypes.
   * Callback-gated getters (get_context_usage, etc.) never respond over the wire
   * and would always time out (verified).
   */
  private sendControlResult(
    subtype: string,
    extra: Record<string, unknown> = {},
    timeoutMs = 5000
  ): Promise<ControlResult> {
    const requestId = `ctl-${randomUUID()}`
    if (!this.child || !this.child.stdin.writable) return Promise.resolve({ ok: false })
    return new Promise<ControlResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(requestId)
        resolve({ ok: false, timedOut: true })
      }, timeoutMs)
      this.pendingControl.set(requestId, { resolve, timer })
      this.writeLine({ type: 'control_request', request_id: requestId, request: { subtype, ...extra } })
    })
  }

  /** Convenience: awaited control_request resolving true on success. */
  private async sendControl(subtype: string, extra: Record<string, unknown> = {}, timeoutMs = 5000): Promise<boolean> {
    return (await this.sendControlResult(subtype, extra, timeoutMs)).ok
  }

  private emitWire(raw: unknown): void {
    const type = (raw as { type?: unknown } | null)?.type
    if (type === 'user' || type === 'assistant') this.emit('wire', raw)
  }

  private emitEvent(e: DomainEvent): void {
    if (e.type === 'result' && e.usage && e.messageId) void recordTurnUsage(e.sessionId, e.messageId, e.usage).catch(() => {})
    this.emit('event', e)
  }

  private writeLine(obj: unknown): void {
    const child = this.child
    if (!child || !child.stdin.writable) return
    try {
      child.stdin.write(JSON.stringify(obj) + '\n')
    } catch {
      // stdin ended/broke between the check and the write; 'error'/'close' own teardown.
    }
  }

  private writable(): boolean {
    return !!this.child?.stdin.writable && (!this.opts.gated || (this.initAcked && !this.reconnecting))
  }

  /** Gated mode writes nothing before the init ACK or during a reconnect, never to an ended stdin. */
  private whenWritable(): Promise<void> {
    if (this.closed) return Promise.reject(new Error(GONE))
    if (this.writable()) return Promise.resolve()
    return new Promise((resolve, reject) => this.writers.push({ resolve, reject }))
  }

  private releaseWriters(): void {
    const w = this.writers
    this.writers = []
    for (const x of w) x.resolve()
  }

  private failWriters(): void {
    const w = this.writers
    this.writers = []
    for (const x of w) x.reject(new Error(GONE))
  }

  /**
   * Send one user message. `prepare` validates and serializes it under the envelope's uuid, so the
   * packetId in the text and the uuid the CLI echoes are one value. `now` sends into the running turn: the
   * message is written, then an interrupt naming it, so the CLI stops the running step and answers it as a
   * turn of its own; `joined` is false when no turn was open, so it started one.
   */
  send(now: boolean, prepare: (uuid: string) => Promise<Prepared>): Promise<DispatchResult> {
    const epoch = this.cancelEpoch
    const run = this.outbox.then(() => this.deliver(epoch, now, prepare))
    this.outbox = run.catch(() => {})
    return run
  }

  private async deliver(epoch: number, now: boolean, prepare: (uuid: string) => Promise<Prepared>): Promise<DispatchResult> {
    for (;;) {
      await this.whenWritable()
      if (this.cancelEpoch !== epoch) return { ok: false, reason: 'cancelled' }
      const uuid = randomUUID()
      const r = await prepare(uuid)
      if (!r.ok) return r
      if (this.cancelEpoch !== epoch) return { ok: false, reason: 'cancelled' }
      if (this.closed) throw new Error(GONE)
      // A reconnect started during prepare: validate again against the new child.
      if (!this.writable()) continue
      const joined = this.writeUser(uuid, r.content, now)
      r.onWritten?.()
      return { ok: true, packetId: uuid, text: r.text, joined }
    }
  }

  // The CLI names the uuids each result answered, which is how a turn's end is found when the message joined a
  // background turn or was sent mid-turn.
  private writeUser(uuid: string, content: string | unknown[], now: boolean): boolean {
    const open = now && this.mapper.hasOpenTurn()
    this.mapper.trackSent(uuid, open)
    this.writeLine({ type: 'user', message: { role: 'user', content }, uuid })
    // The CLI only cuts a turn for a message already in its queue, so the interrupt waits for the
    // message's `queued` frame, with a timer in case that frame never comes.
    if (open) this.pendingCuts.set(uuid, setTimeout(() => this.cutFor(uuid), 1000))
    return open
  }

  /**
   * `send_now` is internal protocol (2.1.296, advertised as interrupt_send_now_v1 on init): re-verify
   * its shape and its sparing of background tasks on a CLI bump. A reply of `nothing_waiting` means
   * the turn already took the message in or ended, and the message's own result still closes it.
   */
  private cutFor(uuid: string): void {
    const timer = this.pendingCuts.get(uuid)
    if (!timer) return
    clearTimeout(timer)
    this.pendingCuts.delete(uuid)
    this.writeLine({
      type: 'control_request',
      request_id: `now-${randomUUID()}`,
      request: { subtype: 'interrupt', send_now: true, message_uuid: uuid }
    })
  }

  /**
   * Push a discovery-name change onto the RUNNING session via the CLI's `/rename`: updates the
   * peer registry (nameSource:user) and writes customTitle, no respawn. The mapper swallows the
   * echoed turn. Caller ensures the session is idle so the suppress window can't eat a real turn.
   */
  injectRename(name: string): void {
    const trimmed = name.trim()
    if (!trimmed) return
    const child = this.child
    if (!child || !child.stdin.writable || !this.initAcked || this.reconnecting) return
    this.mapper.beginRenameSuppression()
    this.writeLine({ type: 'user', message: { role: 'user', content: `/rename ${trimmed}` } })
  }

  /**
   * Change the permission mode of THIS running session via the control protocol
   * (`set_permission_mode`). Takes effect for subsequent tool calls; verified to
   * work mid-session. Does not touch any settings file.
   *
   * Also persists the new mode into `opts.permissionMode` so a later effort-driven
   * respawn (which rebuilds argv from opts) keeps it, else the respawn would
   * silently revert to the launch-time mode. The IPC handler resolves 'inherit' from
   * settings.json before calling this (there's no mid-session "unset"), so `mode` is concrete here.
   */
  async setPermissionMode(mode: string): Promise<ModeChangeResult> {
    if (!this.child) return { ok: false }
    // Await the control ACK and commit opts ONLY on success (a rejected change must not
    // update the launch mode a later respawn would rebuild from). Both set_* subtypes
    // are verified to emit a success/error control_response.
    const { ok, errorCode } = await this.sendControlResult('set_permission_mode', { mode })
    if (ok) this.opts = { ...this.opts, permissionMode: mode }
    return { ok, errorCode }
  }

  /**
   * Change the model of THIS running session live via the control protocol
   * (`set_model`). Verified to work mid-session. Commits opts only on the success ACK
   * so a later effort-respawn rebuilds from the confirmed model.
   */
  async setModel(model: string): Promise<ModelSwitchResult> {
    if (!this.child) return { ok: false }
    // The CLI checks the model against the API before it ACKs and waits up to 15s for that.
    const r = await this.sendControlResult('set_model', { model }, 16_000)
    if (!r.ok) return { ok: false, timedOut: r.timedOut, errorCode: r.errorCode, reason: r.error }
    const regained = !deriveModelInfo(this.opts.model ?? '').efforts.length && !!deriveModelInfo(model).efforts.length
    this.opts = { ...this.opts, model }
    this.mapper.setModel(model)
    // Whether the CLI kept the effortLevel across a model that takes none is unverified, so
    // the stored effort is sent again. The renderer's own setEffort then matches and no-ops.
    const effort = this.opts.effort
    if (regained && isEffortChoice(effort)) {
      const next = clampEffort(model, effort)
      this.opts = { ...this.opts, effort: next }
      await this.applyEffort(next)
    }
    return { ok: true }
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
    this.opts = { ...this.opts, effort }
    if (!this.child) return
    await this.applyEffort(effort)
  }

  private async applyEffort(effort: string): Promise<void> {
    const ok = await this.sendControl('apply_flag_settings', { settings: { effortLevel: effort } })
    if (!ok) {
      this.emitEvent({ type: 'error', severity: 'info', message: `Live effort change unavailable. Reconnecting to apply "${effort}"…` })
      this.respawnWith()
    }
  }

  /**
   * Toggle ultracode live (`apply_flag_settings {ultracode}`). Ultracode runs at the current
   * effortLevel and the `Workflow` tool is present at every effort level (verified), so it
   * needs no respawn. Persisted into opts so a respawn (e.g. effort fallback) keeps it.
   */
  async setUltracode(on: boolean): Promise<boolean> {
    if (!this.child) return false
    const ok = await this.sendControl('apply_flag_settings', { settings: { ultracode: on } })
    if (ok) this.opts = { ...this.opts, ultracode: on }
    return ok
  }

  /** Respawn with `--resume <sessionId>` and the current opts: the effort fallback when the
   *  live `apply_flag_settings` path fails. */
  private respawnWith(): void {
    if (!this.child) return
    this.respawning = true
    this.reconnecting = true
    this.respawned = true
    this.initAcked = false
    this.cancelElicitations()
    // Resume the CURRENT confirmed id (not one snapshotted before init arrived); never
    // re-fork. Keep `name`: the idempotent `-n` preserves the peer name / mirror.
    this.opts = {
      ...this.opts,
      resumeSessionId: this.sessionId ?? this.opts.resumeSessionId,
      fork: false
    }
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
    // A Stop cancels anything not yet delivered, so a later init/reconnect can't send a turn the user
    // already stopped.
    this.cancelEpoch++
    // Nothing was written to the CLI yet (still initializing / reconnecting): no running
    // turn to interrupt, and the control channel isn't ready.
    if (!this.initAcked) return
    this.cancelElicitations()
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

  /** Move a RUNNING foreground tool to the background; it keeps running in the tray. Must
   *  be sent while the task runs (after task_started). A `success` envelope can still
   *  carry `backgrounded:false` (timing/completion race), so require the payload flag
   *  (not just delivery) before reporting the move succeeded. */
  async backgroundTask(toolUseId: string): Promise<boolean> {
    const r = await this.sendControlResult('background_tasks', { tool_use_id: toolUseId })
    return r.ok && r.payload?.backgrounded === true
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

  respondElicitation(requestId: string, response: ElicitationResponse): void {
    this.elicitations.delete(requestId)
    this.writeLine({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
  }

  /** A stopped turn or session must not leave an MCP server blocked on an unanswered card, and
   *  the CLI isn't known to withdraw elicitations itself, so each gets an explicit cancel. */
  private cancelElicitations(): void {
    for (const requestId of [...this.elicitations]) {
      this.respondElicitation(requestId, { action: 'cancel' })
      this.emitEvent({ type: 'permission-cancel', requestId })
    }
  }

  stop(): void {
    // Cancel any in-flight effort-respawn: without this, a 'close' still pending from
    // respawnWith's SIGTERM would resurrect the child even though we're tearing it
    // down for good. (The 'close' handler also guards on `closed` first; this is the
    // belt to that suspenders, since a pending respawn must not survive an explicit stop.)
    this.respawning = false
    this.dropMcpConfig()
    this.cancelElicitations()
    // Resolve any awaited control_requests as failed + clear their timers.
    for (const [, p] of this.pendingControl) {
      clearTimeout(p.timer)
      p.resolve({ ok: false })
    }
    this.pendingControl.clear()
    for (const t of this.pendingCuts.values()) clearTimeout(t)
    this.pendingCuts.clear()
    if (this.initTimer) {
      clearTimeout(this.initTimer)
      this.initTimer = null
    }
    if (!this.child) return
    this.closed = true
    this.failWriters()
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
