/**
 * Owns all live `ClaudeSession`s, keyed by an app-local handle id (assigned before
 * the CLI's own session id is known). Routes each session's DomainEvents to a sink
 * (the IPC bridge), tagged with the handle so the renderer can demux.
 */
import { randomUUID } from 'node:crypto'
import { ClaudeSession, type ClaudeSessionOptions } from '../cli/session'
import type { DomainEvent } from '../../shared/events'
import type { PermissionVerdict, WireAttachment } from '../../shared/ipc'
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

  constructor(private readonly sink: EventSink) {}

  start(opts: ClaudeSessionOptions): string {
    const handleId = randomUUID()
    const session = new ClaudeSession(opts)
    session.on('event', (e) => {
      this.sink(handleId, e)
      if (mutatesTasks(e.type)) this.scheduleTaskRead(handleId, session)
    })
    session.on('exit', () => {
      this.sessions.delete(handleId)
      const t = this.taskTimers.get(handleId)
      if (t) clearTimeout(t)
      this.taskTimers.delete(handleId)
      this.lastTaskSnapshot.delete(handleId)
    })
    this.sessions.set(handleId, session)
    session.start()
    return handleId
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
        void readTasks(sessionId).then((tasks) => {
          if (!this.sessions.has(handleId)) return // session closed while reading
          const snapshot = JSON.stringify(tasks)
          if (snapshot === this.lastTaskSnapshot.get(handleId)) return
          this.lastTaskSnapshot.set(handleId, snapshot)
          this.sink(handleId, { type: 'task-list', tasks })
        })
      }, TASK_READ_DEBOUNCE_MS)
    )
  }

  send(handleId: string, text: string, attachments?: WireAttachment[]): void {
    this.sessions.get(handleId)?.send(text, attachments)
  }

  interrupt(handleId: string): void {
    this.sessions.get(handleId)?.interrupt()
  }

  setPermissionMode(handleId: string, mode: string): void {
    this.sessions.get(handleId)?.setPermissionMode(mode)
  }

  setModel(handleId: string, model: string): void {
    this.sessions.get(handleId)?.setModel(model)
  }

  setEffort(handleId: string, effort: string): Promise<void> {
    return this.sessions.get(handleId)?.setEffort(effort) ?? Promise.resolve()
  }

  setUltracode(handleId: string, on: boolean): Promise<void> {
    return this.sessions.get(handleId)?.setUltracode(on) ?? Promise.resolve()
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

  stop(handleId: string): void {
    const s = this.sessions.get(handleId)
    if (s) {
      s.stop()
      this.sessions.delete(handleId)
    }
  }

  /** Kill everything (called on app quit / window close). */
  stopAll(): void {
    for (const s of this.sessions.values()) s.stop()
    this.sessions.clear()
  }
}
