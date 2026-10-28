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
  byteVersion: PacketDeps['byteVersion']
  push(e: RefSourceChanged): void
}

interface Entry {
  path: string
  bytes: boolean
  versions: Set<SourceVersion>
  id: string | null
  dead: boolean
}

export function contextWatches(deps: ContextWatchDeps): { sync(handleId: string, entries: RefWatchEntry[]): void; dispose(handleId: string): void } {
  const byHandle = new Map<string, Map<string, Entry>>()

  async function check(handleId: string, e: Entry): Promise<void> {
    const { path } = e
    const r = await (e.bytes ? deps.byteVersion : deps.readRevision)(handleId, path)
    if (e.dead) return
    const bytes = e.bytes ? { bytes: true as const } : {}
    if (!r.ok) return deps.push({ handleId, path, reason: readFailure(r.reason), ...bytes })
    if ([...e.versions].some((v) => v !== r.version)) deps.push({ handleId, path, reason: 'changed', version: r.version, ...bytes })
  }

  async function arm(handleId: string, e: Entry): Promise<void> {
    const r = await deps.resolve(handleId, e.path)
    if (e.dead) return
    if (r.ok) {
      const w = await deps.watch(r, () => void check(handleId, e), 'context')
      if (w.ok && e.dead) return deps.unwatch(w.id)
      if (w.ok) e.id = w.id
    }
    // The file may have changed between the pick and this watch.
    await check(handleId, e)
  }

  function drop(e: Entry): void {
    e.dead = true
    if (e.id) deps.unwatch(e.id)
  }

  function sync(handleId: string, entries: RefWatchEntry[]): void {
    // Keyed by how the version is read too: an SVG can hold a line reference and an image reference at once.
    const want = new Map<string, { path: string; bytes: boolean; versions: Set<SourceVersion> }>()
    for (const { path, version, bytes } of entries) {
      const key = `${bytes ? 'b' : 't'}\0${path}`
      // ponytail: context watches cap at MAX_REFS keys per session; raise or pool by mtime polling if queued review stacks exceed it
      if (!want.has(key) && want.size >= MAX_REFS) continue
      const w = want.get(key) ?? { path, bytes: !!bytes, versions: new Set() }
      want.set(key, w)
      w.versions.add(version)
    }
    const cur = byHandle.get(handleId) ?? new Map<string, Entry>()
    for (const [key, e] of cur) {
      if (want.has(key)) continue
      drop(e)
      cur.delete(key)
    }
    for (const [key, { path, bytes, versions }] of want) {
      const e = cur.get(key)
      if (!e) {
        const next: Entry = { path, bytes, versions, id: null, dead: false }
        cur.set(key, next)
        void arm(handleId, next)
        continue
      }
      const added = [...versions].some((v) => !e.versions.has(v))
      e.versions = versions
      if (added) void check(handleId, e)
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
