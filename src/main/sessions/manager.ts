/**
 * Owns all live `ClaudeSession`s, keyed by an app-local handle id (assigned before
 * the CLI's own session id is known). Routes each session's DomainEvents to a sink
 * (the IPC bridge), tagged with the handle so the renderer can demux.
 */
import { ClaudeSession, type ClaudeSessionOptions } from '../cli/session'
import type { DomainEvent, ElicitationResponse } from '../../shared/events'
import type { ModeChangeResult, PermissionVerdict, WireAttachment } from '../../shared/ipc'
import type { FileChangeSummary } from '../../shared/changes'
import { ChangeLedger, type PublishFn, type SegmentView } from '../surfaces/ledger'
import { readTasks } from './tasks'

export type EventSink = (handleId: string, event: DomainEvent) => void

/** Re-read the task list this long after task-mutating activity settles. Trailing
 *  debounce collapses a burst of tool events into one disk read; the terminal
 *  `result` event guarantees a final read of the turn's end state. */
const TASK_READ_DEBOUNCE_MS = 250

/** Events that flow right after the CLI writes/updates a task file on disk, so a
 *  re-read after them reflects the live list without an fs.watch or a poll. */
function mutatesTasks(type: DomainEvent['type']): boolean {
  return (
    type === 'tool-result' ||
    type === 'turn-complete' ||
    type === 'result' ||
    type === 'session-init'
  )
}

export class SessionManager {
  private readonly sessions = new Map<string, ClaudeSession>()
  /** Pending debounced task-read timer per handle (trailing debounce). */
  private readonly taskTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Last emitted task snapshot per handle (serialized), to skip no-op re-emits. */
  private readonly lastTaskSnapshot = new Map<string, string>()
  /** Monotonic per-handle read sequence: an in-flight read that finishes after a newer
   *  one started is dropped, so a slow stale snapshot can't overwrite the newer state. */
  private readonly taskReadSeq = new Map<string, number>()

  private readonly ledger: ChangeLedger
  private readonly cwds = new Map<string, string>()

  constructor(private readonly sink: EventSink, publishChanges: PublishFn) {
    this.ledger = new ChangeLedger(publishChanges)
  }

  start(handleId: string, opts: ClaudeSessionOptions): void {
    const session = new ClaudeSession(opts)
    this.cwds.set(handleId, opts.cwd)
    // A resume keeps its id, so its ledger key is known now. A fork or a new session goes by its
    // handle until init names the session; a fork's inherited history is the source's transcript.
    this.ledger.attach(handleId, opts.resumeSessionId && !opts.fork ? opts.resumeSessionId : handleId)
    if (opts.resumeSessionId && !opts.ephemeral) void this.ledger.replay(handleId, opts.resumeSessionId)
    session.on('wire', (raw) => this.ledger.wire(handleId, raw))
    session.on('event', (e) => {
      if (e.type === 'session-init' && e.sessionId) this.ledger.rekey(handleId, e.sessionId)
      this.sink(handleId, e)
      if (mutatesTasks(e.type)) this.scheduleTaskRead(handleId, session)
    })
    session.on('exit', () => {
      this.sessions.delete(handleId)
      this.cleanupHandle(handleId)
    })
    this.sessions.set(handleId, session)
    session.start()
  }

  /** Drop all per-handle bookkeeping. Called from BOTH natural exit and explicit stop
   *  (an explicit stop suppresses the exit event, so without this its timers/snapshots
   *  would leak). */
  private cleanupHandle(handleId: string): void {
    const t = this.taskTimers.get(handleId)
    if (t) clearTimeout(t)
    this.taskTimers.delete(handleId)
    this.lastTaskSnapshot.delete(handleId)
    this.taskReadSeq.delete(handleId)
    this.cwds.delete(handleId)
    this.ledger.detach(handleId)
  }

  /** The live session's working directory; null once it's gone. */
  cwd(handleId: string): string | null {
    return this.cwds.get(handleId) ?? null
  }

  /** The handle's Claude changes; null once its session is gone. */
  changes(handleId: string): Promise<FileChangeSummary[] | null> {
    return this.ledger.changes(handleId)
  }

  /** One file's ledger segments, for its diff; null once the session is gone or the path isn't Claude's. */
  segments(handleId: string, path: string): Promise<SegmentView[] | null> {
    return this.ledger.segments(handleId, path)
  }

  /** Trailing-debounced re-read of the session's on-disk task list, emitting a
   *  `task-list` event only when the snapshot actually changed. */
  private scheduleTaskRead(handleId: string, session: ClaudeSession): void {
    const existing = this.taskTimers.get(handleId)
    if (existing) clearTimeout(existing)
    this.taskTimers.set(
      handleId,
      setTimeout(() => {
        this.taskTimers.delete(handleId)
        const sessionId = session.getSessionId()
        if (!sessionId) return
        const seq = (this.taskReadSeq.get(handleId) ?? 0) + 1
        this.taskReadSeq.set(handleId, seq)
        void readTasks(sessionId)
          .then((tasks) => {
            if (!this.sessions.has(handleId)) return // session closed while reading
            if (this.taskReadSeq.get(handleId) !== seq) return // a newer read superseded this
            const snapshot = JSON.stringify(tasks)
            if (snapshot === this.lastTaskSnapshot.get(handleId)) return
            this.lastTaskSnapshot.set(handleId, snapshot)
            this.sink(handleId, { type: 'task-list', tasks })
          })
          .catch(() => {}) // a transient unreadable task file must not reject unhandled
      }, TASK_READ_DEBOUNCE_MS)
    )
  }

  send(handleId: string, text: string, attachments?: WireAttachment[]): void {
    const s = this.sessions.get(handleId)
    // Throw (rather than silently no-op) so a send to a stopped/evicted session rejects
    // through IPC and the renderer can roll back its optimistic busy state.
    if (!s) throw new Error('This session is no longer running.')
    s.send(text, attachments)
  }

  sendNow(handleId: string, text: string, attachments?: WireAttachment[]): boolean {
    const s = this.sessions.get(handleId)
    if (!s) throw new Error('This session is no longer running.')
    return s.sendNow(text, attachments)
  }

  interrupt(handleId: string): void {
    this.sessions.get(handleId)?.interrupt()
  }

  stopTask(handleId: string, taskId: string): Promise<boolean> {
    return this.sessions.get(handleId)?.stopTask(taskId) ?? Promise.resolve(false)
  }

  backgroundTask(handleId: string, toolUseId: string): Promise<boolean> {
    return this.sessions.get(handleId)?.backgroundTask(toolUseId) ?? Promise.resolve(false)
  }

  setPermissionMode(handleId: string, mode: string): Promise<ModeChangeResult> {
    return this.sessions.get(handleId)?.setPermissionMode(mode) ?? Promise.resolve({ ok: false })
  }

  setModel(handleId: string, model: string): Promise<boolean> {
    return this.sessions.get(handleId)?.setModel(model) ?? Promise.resolve(false)
  }

  setEffort(handleId: string, effort: string): Promise<void> {
    return this.sessions.get(handleId)?.setEffort(effort) ?? Promise.resolve()
  }

  /** Push a discovery-name change onto a running session via `/rename` (no-op if not live). */
  injectRename(handleId: string, name: string): void {
    this.sessions.get(handleId)?.injectRename(name)
  }

  setUltracode(handleId: string, on: boolean): Promise<boolean> {
    return this.sessions.get(handleId)?.setUltracode(on) ?? Promise.resolve(false)
  }

  sessionIdOf(handleId: string): string | null {
    return this.sessions.get(handleId)?.getSessionId() ?? null
  }

  respondPermission(handleId: string, verdict: PermissionVerdict): void {
    const session = this.sessions.get(handleId)
    if (!session) return
    if (verdict.behavior === 'allow') {
      session.respondPermission(verdict.requestId, {
        behavior: 'allow',
        updatedInput: verdict.updatedInput
      })
    } else {
      session.respondPermission(verdict.requestId, {
        behavior: 'deny',
        message: verdict.message
      })
    }
  }

  respondElicitation(handleId: string, requestId: string, response: ElicitationResponse): void {
    this.sessions.get(handleId)?.respondElicitation(requestId, response)
  }

  stop(handleId: string): void {
    const s = this.sessions.get(handleId)
    if (s) {
      s.stop()
      this.sessions.delete(handleId)
      this.cleanupHandle(handleId)
    }
  }

  /** Kill everything (called on app quit / window close). */
  stopAll(): void {
    for (const handleId of [...this.sessions.keys()]) {
      this.sessions.get(handleId)?.stop()
      this.cleanupHandle(handleId)
    }
    this.sessions.clear()
  }
}
