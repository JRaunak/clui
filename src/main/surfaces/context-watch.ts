/**
 * Watches the files that draft and queued line references point into, with or without a File tab open, so a
 * change removes the reference while the user can still see why. Dispatch re-checks every reference anyway;
 * this only makes the removal early.
 */
import { MAX_REFS, type SourceVersion } from '../../shared/context'
import type { RefSourceChanged, RefWatchEntry } from '../../shared/ipc'
import { readFailure, type PacketDeps } from '../cli/packet'
import type { FileResource, Refusal, WatchPool } from './files'

export interface ContextWatchDeps {
  resolve(handleId: string, path: string): Promise<FileResource | Refusal>
  watch(r: FileResource, onChange: () => void, pool: WatchPool): Promise<{ ok: true; id: string } | Refusal>
  unwatch(id: string): void
  readRevision: PacketDeps['readRevision']
  push(e: RefSourceChanged): void
}

interface Entry {
  versions: Set<SourceVersion>
  id: string | null
  dead: boolean
}

export function contextWatches(deps: ContextWatchDeps): { sync(handleId: string, entries: RefWatchEntry[]): void; dispose(handleId: string): void } {
  const byHandle = new Map<string, Map<string, Entry>>()

  async function check(handleId: string, path: string, e: Entry): Promise<void> {
    const r = await deps.readRevision(handleId, path)
    if (e.dead) return
    if (!r.ok) return deps.push({ handleId, path, reason: readFailure(r.reason) })
    if ([...e.versions].some((v) => v !== r.version)) deps.push({ handleId, path, reason: 'changed', version: r.version })
  }

  async function arm(handleId: string, path: string, e: Entry): Promise<void> {
    const r = await deps.resolve(handleId, path)
    if (e.dead) return
    if (r.ok) {
      const w = await deps.watch(r, () => void check(handleId, path, e), 'context')
      if (w.ok && e.dead) return deps.unwatch(w.id)
      if (w.ok) e.id = w.id
    }
    // The file may have changed between the pick and this watch.
    await check(handleId, path, e)
  }

  function drop(e: Entry): void {
    e.dead = true
    if (e.id) deps.unwatch(e.id)
  }

  function sync(handleId: string, entries: RefWatchEntry[]): void {
    const want = new Map<string, Set<SourceVersion>>()
    for (const { path, version } of entries) {
      // ponytail: context watches cap at MAX_REFS paths per session; raise or pool by mtime polling if queued review stacks exceed it
      if (!want.has(path) && want.size >= MAX_REFS) continue
      want.set(path, (want.get(path) ?? new Set()).add(version))
    }
    const cur = byHandle.get(handleId) ?? new Map<string, Entry>()
    for (const [path, e] of cur) {
      if (want.has(path)) continue
      drop(e)
      cur.delete(path)
    }
    for (const [path, versions] of want) {
      const e = cur.get(path)
      if (!e) {
        const next: Entry = { versions, id: null, dead: false }
        cur.set(path, next)
        void arm(handleId, path, next)
        continue
      }
      const added = [...versions].some((v) => !e.versions.has(v))
      e.versions = versions
      if (added) void check(handleId, path, e)
    }
    if (cur.size) byHandle.set(handleId, cur)
    else byHandle.delete(handleId)
  }

  function dispose(handleId: string): void {
    for (const e of byHandle.get(handleId)?.values() ?? []) drop(e)
    byHandle.delete(handleId)
  }

  return { sync, dispose }
}
