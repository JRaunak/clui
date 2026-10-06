/**
 * Per-turn usage sidecar (`<userData>/session-usage.json`).
 *
 * The CLI persists only a session's running total (one cost-state per process), so a resumed
 * transcript can't show what each turn cost. Clui records every finished turn's own usage here,
 * keyed by the API id of the turn's last assistant message, which is the same on disk and
 * across a fork. App-owned, never touches ~/.claude.
 * Map shape: { "<cli-session-id>": { "<api-message-id>": TurnUsage } }.
 */
import { app } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from '../lib/atomic'
import type { TurnUsage } from '../../shared/events'

type UsageMap = Record<string, Record<string, TurnUsage>>

const usagePath = (): string => join(app.getPath('userData'), 'session-usage.json')

export async function readSessionUsage(): Promise<UsageMap> {
  try {
    const parsed = JSON.parse(await readFile(usagePath(), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as UsageMap) : {}
  } catch {
    return {}
  }
}

// Serialized read-modify-write, the same guard as the model sidecar: sessions finishing turns
// in the same tick must not clobber each other's entries.
let writeChain: Promise<void> = Promise.resolve()
function serialize(mutate: () => Promise<void>): Promise<void> {
  const next = writeChain.then(mutate, mutate)
  writeChain = next.catch(() => {})
  return next
}

export async function recordTurnUsage(sessionId: string, messageId: string, usage: TurnUsage): Promise<void> {
  if (!sessionId || !messageId) return
  return serialize(async () => {
    const map = await readSessionUsage()
    map[sessionId] = { ...map[sessionId], [messageId]: usage }
    await atomicWriteFile(usagePath(), JSON.stringify(map))
  })
}

export async function deleteSessionUsage(sessionId: string): Promise<void> {
  return serialize(async () => {
    const map = await readSessionUsage()
    if (!(sessionId in map)) return
    delete map[sessionId]
    await atomicWriteFile(usagePath(), JSON.stringify(map))
  })
}
