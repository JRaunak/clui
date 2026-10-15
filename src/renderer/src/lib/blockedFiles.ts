import { useSyncExternalStore } from 'react'
import type { Refusal } from '../../../shared/files'

/** Why a file tab can't open: gone from disk, or outside the folder with no grant since the relaunch. */
export type Blocked = 'missing' | 'outside'

// Kept after the file's view unmounts, so the strip can name an inactive tab's state.
const blocked = new Map<string, Blocked>()
const listeners = new Set<() => void>()
let version = 0

const keyOf = (handleId: string, path: string): string => `${handleId}\0${path}`

/** Records what the latest read or stat of `path` found; null when it opened. */
export function noteRead(handleId: string, path: string, reason: Refusal['reason'] | null): void {
  const key = keyOf(handleId, path)
  const next = reason === 'missing' ? 'missing' : reason === 'denied' ? 'outside' : null
  if ((blocked.get(key) ?? null) === next) return
  if (next) blocked.set(key, next)
  else blocked.delete(key)
  version++
  for (const l of listeners) l()
}

export const blockedOf = (handleId: string, path: string): Blocked | null => blocked.get(keyOf(handleId, path)) ?? null

/** Re-renders on any change; read with blockedOf. */
export const useBlockedVersion = (): number =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    () => version
  )

export function recheck(handleId: string, paths: readonly string[]): void {
  for (const p of paths) void window.clui.statFile(handleId, p).then((r) => noteRead(handleId, p, r.ok ? null : r.reason), () => {})
}
