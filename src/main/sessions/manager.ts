/**
 * Owns all live `ClaudeSession`s, keyed by an app-local handle id (assigned before
 * the CLI's own session id is known). Routes each session's DomainEvents to a sink
 * (the IPC bridge), tagged with the handle so the renderer can demux.
 */
import { randomUUID } from 'node:crypto'
import { ClaudeSession, type ClaudeSessionOptions } from '../cli/session'
import type { DomainEvent } from '../../shared/events'
import type { PermissionVerdict, WireAttachment } from '../../shared/ipc'

export type EventSink = (handleId: string, event: DomainEvent) => void

export class SessionManager {
  private readonly sessions = new Map<string, ClaudeSession>()

  constructor(private readonly sink: EventSink) {}

  /** Create + start a session; returns its handle id. */
  start(opts: ClaudeSessionOptions): string {
    const handleId = randomUUID()
    const session = new ClaudeSession(opts)
    session.on('event', (e) => this.sink(handleId, e))
    session.on('exit', () => this.sessions.delete(handleId))
    this.sessions.set(handleId, session)
    session.start()
    return handleId
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
