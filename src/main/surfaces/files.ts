/**
 * Guarded, read-only file access for the surfaces. `resolveAllowed` turns a renderer-supplied path
 * into a FileResource: the canonical path plus the dev/ino it had when it was authorized. Every
 * read reopens that path with symlinks refused in every component, then checks the descriptor is
 * still the object that was authorized, so a swap anywhere in the path between check and use is
 * refused instead of followed.
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants, watch as fsWatch, type BigIntStats, type FSWatcher } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, opendir, realpath, rm, symlink, writeFile, type FileHandle } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { MAX_REFS } from '../../shared/context'
import type { FileStat, ImageInfo, Refusal, TextRead } from '../../shared/files'
import { HEAD_BYTES, readImageHead, tooLarge } from '../../shared/imageHead'

export type FileOperation = 'read-file' | 'list-directory' | 'watch-file' | 'watch-directory' | 'open-external'
/** `web` is an HTML view's own page and assets: workspace files only, never a grant or a ledger path. */
export type FileConsumer = 'file' | 'tree' | 'diff' | 'editor' | 'web'
export interface FileAccess {
  consumer: FileConsumer
  operation: FileOperation
}

export interface FileResource extends FileAccess {
  ok: true
  handleId: string | null
  path: string
  type: 'file' | 'directory'
  dev: bigint
  ino: bigint
}

export type { Refusal, TextRead } from '../../shared/files'

export interface DirEntry {
  name: string
  type: 'file' | 'directory' | 'symlink' | 'other'
}

export interface FileSessions {
  /** Null once the handle is gone. */
  cwd(handleId: string): string | null
  /** Paths Claude successfully changed in the session, as the ledger recorded them. */
  changedPaths(handleId: string): Promise<readonly string[] | null>
}

export const TEXT_MAX = 5 * 1024 * 1024
export const BYTES_MAX = 200 * 1024 * 1024
export const CHUNK_MAX = 4 * 1024 * 1024
export const LIST_MAX = 10_000
/** How far a capped listing keeps counting, so a huge folder can't hold a listing open. */
export const COUNT_MAX = 100_000
export const WATCH_MAX = 32
/** Message references watch their own files, so they never take a surface's slot. */
export type WatchPool = 'surface' | 'context'
const POOL_MAX: Record<WatchPool, number> = { surface: WATCH_MAX, context: MAX_REFS }
const SNIFF = 8192
const DEBOUNCE_MS = 100
const PATH_MAX = 4096

const OPERATIONS = new Set<unknown>(['read-file', 'list-directory', 'watch-file', 'watch-directory', 'open-external'])
const CONSUMERS = new Set<unknown>(['file', 'tree', 'diff', 'editor', 'web'])

// Node doesn't expose the macOS flag; the SDK's fcntl.h defines it as 0x20000000. Anywhere it's
// unknown, reads fail closed rather than fall back to O_NOFOLLOW, which guards only the last component.
const NOFOLLOW_ANY = (constants as Record<string, number | undefined>).O_NOFOLLOW_ANY ?? (process.platform === 'darwin' ? 0x20000000 : undefined)
// NONBLOCK so a FIFO swapped in after authorization opens at once and fstat can refuse it.
const READ = constants.O_RDONLY | constants.O_NONBLOCK | (NOFOLLOW_ANY ?? 0)

class Refused extends Error {
  reason: Refusal['reason']
  constructor(reason: Refusal['reason']) {
    super(reason)
    this.reason = reason
  }
}

const refuse = (reason: Refusal['reason']): Refusal => ({ ok: false, reason })
const code = (e: unknown): unknown => (e as NodeJS.ErrnoException | null)?.code
const failed = (e: unknown): 'permission' | 'unreadable' => (code(e) === 'EACCES' || code(e) === 'EPERM' ? 'permission' : 'unreadable')
const isInt = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max
export const within = (root: string, p: string): boolean => p === root || p.startsWith(root.endsWith('/') ? root : root + '/')
const dirOp = (op: FileOperation): boolean => op === 'list-directory' || op === 'watch-directory'

export const revisionOf = (s: BigIntStats): string =>
  createHash('sha256').update(`${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`).digest('hex').slice(0, 32)

let proven: Promise<boolean> | undefined

// Only resources this module issued can be read: a renderer-shaped copy carries no authority.
const issued = new WeakSet<FileResource>()
const genuine = (r: unknown): r is FileResource => typeof r === 'object' && r !== null && issued.has(r as FileResource)

/** The flag is trusted only after it has refused an ancestor symlink on this machine. */
export function guardProven(): Promise<boolean> {
  proven ??= probe().then((ok) => {
    if (!ok) proven = undefined
    return ok
  })
  return proven
}

async function probe(): Promise<boolean> {
  if (NOFOLLOW_ANY === undefined) return false
  let dir: string | undefined
  try {
    dir = await mkdtemp(join(await realpath(tmpdir()), 'clui-guard-'))
    await mkdir(join(dir, 'real'))
    await writeFile(join(dir, 'real', 'f'), '')
    await symlink('real', join(dir, 'link'))
    await (await open(join(dir, 'real', 'f'), READ)).close()
    try {
      await (await open(join(dir, 'link', 'f'), READ)).close()
      return false
    } catch (e) {
      return code(e) === 'ELOOP'
    }
  } catch {
    return false
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** realpath, or for a path that doesn't exist yet, its deepest existing ancestor's realpath plus the rest. */
async function canonical(p: string): Promise<{ path: string; exists: boolean } | null> {
  try {
    return { path: await realpath(p), exists: true }
  } catch (e) {
    if (code(e) !== 'ENOENT' && code(e) !== 'ENOTDIR') return null
    const parent = dirname(p)
    if (parent === p) return null
    const up = await canonical(parent)
    return up && { path: join(up.path, basename(p)), exists: false }
  }
}

async function openVerified(r: FileResource): Promise<FileHandle> {
  if (!(await guardProven())) throw new Refused('unavailable')
  let fh: FileHandle
  try {
    fh = await open(r.path, READ | (r.type === 'directory' ? constants.O_DIRECTORY : 0))
  } catch (e) {
    throw new Refused(code(e) === 'ENOENT' ? 'missing' : code(e) === 'ELOOP' || code(e) === 'ENOTDIR' ? 'changed' : failed(e))
  }
  try {
    const s = await fh.stat({ bigint: true })
    if (s.dev !== r.dev || s.ino !== r.ino || !(r.type === 'file' ? s.isFile() : s.isDirectory())) throw new Refused('changed')
    return fh
  } catch (e) {
    await fh.close()
    throw e
  }
}

async function guarded<T>(r: FileResource, fn: (fh: FileHandle) => Promise<T>): Promise<T | Refusal> {
  try {
    const fh = await openVerified(r)
    try {
      return await fn(fh)
    } finally {
      await fh.close()
    }
  } catch (e) {
    return refuse(e instanceof Refused ? e.reason : 'unreadable')
  }
}

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  // alloc, not allocUnsafe: on a short read the returned subarray's backing memory would hold uninitialized bytes past n.
  const buf = Buffer.alloc(length)
  let n = 0
  while (n < length) {
    const { bytesRead } = await fh.read(buf, n, length - n, position + n)
    if (!bytesRead) break
    n += bytesRead
  }
  return n === length ? buf : buf.subarray(0, n)
}

export function readText(r: FileResource): Promise<TextRead | Refusal> {
  if (!genuine(r) || r.operation !== 'read-file' || r.type !== 'file') return Promise.resolve(refuse('invalid'))
  return guarded(r, async (fh) => {
    // The fd pins the inode, so only an in-place write can tear the read.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await fh.stat({ bigint: true })
      const size = Number(before.size)
      const want = Math.min(size, TEXT_MAX)
      const bytes = await readAt(fh, 0, want)
      const after = await fh.stat({ bigint: true })
      if (bytes.length !== want || revisionOf(after) !== revisionOf(before)) continue
      const truncated = size > TEXT_MAX
      const binary = bytes.subarray(0, SNIFF).includes(0)
      let text = ''
      let unsupportedEncoding = false
      if (!binary) {
        try {
          // stream: a truncated read may end mid-character, which isn't an encoding error.
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: truncated })
        } catch {
          unsupportedEncoding = true
        }
      }
      const revision = createHash('sha256').update(bytes).digest('hex').slice(0, 32)
      return { ok: true as const, text, size, mtimeMs: Number(after.mtimeMs), binary, truncated, unsupportedEncoding, revision }
    }
    throw new Refused('changed')
  })
}

/** sha256 over every byte, in readText's 32-hex form, read in chunks at one revision. */
async function hashAt(fh: FileHandle, size: number): Promise<string> {
  const h = createHash('sha256')
  for (let off = 0; off < size; off += CHUNK_MAX) h.update(await readAt(fh, off, Math.min(CHUNK_MAX, size - off)))
  return h.digest('hex').slice(0, 32)
}

/** A whole file's content version, as an image reference records it, up to the size a cap serves. */
export function hashFile(r: FileResource): Promise<{ ok: true; version: string } | Refusal> {
  if (!genuine(r) || r.operation !== 'read-file' || r.type !== 'file') return Promise.resolve(refuse('invalid'))
  return guarded(r, async (fh) => {
    const before = await fh.stat({ bigint: true })
    if (Number(before.size) > BYTES_MAX) throw new Refused('too-large')
    const version = await hashAt(fh, Number(before.size))
    if (revisionOf(await fh.stat({ bigint: true })) !== revisionOf(before)) throw new Refused('changed')
    return { ok: true as const, version }
  })
}

/** An image's header, read before anything decodes it, and its content version when it's one Clui shows. */
export function imageInfo(r: FileResource): Promise<ImageInfo | Refusal> {
  if (!genuine(r) || r.operation !== 'read-file' || r.type !== 'file') return Promise.resolve(refuse('invalid'))
  return guarded(r, async (fh) => {
    const before = await fh.stat({ bigint: true })
    const size = Number(before.size)
    // Past this a cap couldn't serve it anyway.
    if (size > BYTES_MAX) throw new Refused('too-large')
    const revision = revisionOf(before)
    if (!size) return { ok: true as const, size, revision, head: null }
    const head = await readImageHead(await readAt(fh, 0, Math.min(size, HEAD_BYTES)), size, (offset, length) => readAt(fh, offset, Math.max(0, Math.min(length, size - offset))))
    const shown = !!head.format && head.complete && !tooLarge(head)
    const version = shown ? await hashAt(fh, size) : undefined
    if (revisionOf(await fh.stat({ bigint: true })) !== revision) throw new Refused('changed')
    return { ok: true as const, size, revision, head, ...(version ? { version } : {}) }
  })
}

/** One bounded range of a file at a known revision; a different revision aborts instead of mixing versions. */
export function readBytes(r: FileResource, range: { revision: string; offset: number; length: number }): Promise<{ ok: true; bytes: Buffer; size: number } | Refusal> {
  const { revision, offset, length } = (range ?? {}) as Record<string, unknown>
  if (!genuine(r) || r.operation !== 'read-file' || r.type !== 'file' || typeof revision !== 'string' || !isInt(offset, 0, BYTES_MAX) || !isInt(length, 1, CHUNK_MAX)) {
    return Promise.resolve(refuse('invalid'))
  }
  return guarded(r, async (fh) => {
    const s = await fh.stat({ bigint: true })
    const size = Number(s.size)
    if (size > BYTES_MAX) throw new Refused('too-large')
    if (revisionOf(s) !== revision) throw new Refused('changed')
    if (offset > size) throw new Refused('invalid')
    const bytes = await readAt(fh, offset, Math.min(length, size - offset))
    if (revisionOf(await fh.stat({ bigint: true })) !== revision) throw new Refused('changed')
    return { ok: true as const, bytes, size }
  })
}

export function statFile(r: FileResource): Promise<FileStat | Refusal> {
  if (!genuine(r)) return Promise.resolve(refuse('invalid'))
  return guarded(r, async (fh) => {
    const s = await fh.stat({ bigint: true })
    return { ok: true as const, type: r.type, size: Number(s.size), mtimeMs: Number(s.mtimeMs), revision: revisionOf(s) }
  })
}

export function listDir(r: FileResource): Promise<{ ok: true; entries: DirEntry[]; truncated: boolean; total: number; totalCapped: boolean } | Refusal> {
  if (!genuine(r) || r.operation !== 'list-directory' || r.type !== 'directory') return Promise.resolve(refuse('invalid'))
  return guarded(r, async (fh) => {
    // /dev/fd/<fd> lists the verified directory itself, not whatever its path names now. The
    // offset is shared with fh, which is why every listing gets a fresh descriptor.
    const dir = await opendir(`/dev/fd/${fh.fd}`)
    const entries: DirEntry[] = []
    let total = 0
    let totalCapped = false
    try {
      for (let d = await dir.read(); d; d = await dir.read()) {
        if (total === COUNT_MAX) {
          totalCapped = true
          break
        }
        if (total++ < LIST_MAX) entries.push({ name: d.name, type: d.isFile() ? 'file' : d.isDirectory() ? 'directory' : d.isSymbolicLink() ? 'symlink' : 'other' })
      }
    } finally {
      await dir.close()
    }
    return { ok: true as const, entries, truncated: total > LIST_MAX, total, totalCapped }
  })
}

interface Watch {
  r: FileResource
  pool: WatchPool
  watcher: FSWatcher | null
  timer: ReturnType<typeof setTimeout> | null
  onChange: () => void
}

export function createFileAccess(sessions: FileSessions) {
  // The null handle holds main-issued Configuration grants, which also apply inside every session.
  const grants = new Map<string, Set<string>>()
  const derived = new Map<string, { handleId: string; consumer: FileConsumer; path: string }>()
  const watches = new Map<string, Watch>()
  let home: Promise<string | null> | undefined
  const grantKey = (handleId: string | null, consumer: FileConsumer): string => `${handleId ?? ''}\0${consumer}`

  async function scopeOf(handleId: string | null, { consumer, operation }: FileAccess, path: string): Promise<'workspace' | 'exact' | 'broad' | null> {
    if (handleId !== null) {
      const cwd = sessions.cwd(handleId)
      if (cwd === null) return null
      const root = await canonical(resolve(cwd))
      home ??= canonical(homedir()).then((c) => c?.path ?? null)
      const h = await home
      // A cwd at or above home would expose all of home: exact grants only. The APFS
      // Data volume reaches the same files under /System/Volumes/Data, which realpath keeps as is.
      // A cwd that's gone still scopes its own paths, so they read as missing rather than outside.
      if (root && h !== null && within(root.path, path)) {
        if (!within(root.path, h) && !within('/System/Volumes', root.path)) return 'workspace'
        // A page inside such a cwd is the session's own, so it's refused as that, never as outside it.
        if (consumer === 'web') return 'broad'
      }
    }
    if (dirOp(operation) || consumer === 'web') return null
    if (grants.get(grantKey(null, consumer))?.has(path)) return 'exact'
    if (handleId === null) return null
    if (grants.get(grantKey(handleId, consumer))?.has(path)) return 'exact'
    const changed = await sessions.changedPaths(handleId).catch(() => null)
    if (!changed?.length) return null
    const canon = await Promise.all(changed.map((p) => (typeof p === 'string' && isAbsolute(p) ? canonical(resolve(p)) : null)))
    return canon.some((c) => c?.path === path) ? 'exact' : null
  }

  async function identify(path: string, handleId: string | null, access: FileAccess, scope: 'workspace' | 'exact'): Promise<FileResource | Refusal> {
    let s: BigIntStats
    try {
      s = await lstat(path, { bigint: true })
    } catch (e) {
      return refuse(code(e) === 'ENOENT' ? 'missing' : failed(e))
    }
    if (s.isSymbolicLink()) return refuse('changed')
    const type = s.isFile() ? 'file' : s.isDirectory() ? 'directory' : null
    const { operation } = access
    const fits =
      operation === 'open-external' ? type === 'file' || (type === 'directory' && scope === 'workspace') : type === (dirOp(operation) ? 'directory' : 'file')
    if (!type || !fits) return refuse('wrong-type')
    const r: FileResource = Object.freeze({ ok: true as const, handleId, consumer: access.consumer, operation, path, type, dev: s.dev, ino: s.ino })
    issued.add(r)
    return r
  }

  const validHandle = (h: unknown): h is string | null => h === null || (typeof h === 'string' && h.length > 0 && h.length <= 200)
  const validPath = (p: unknown): p is string => typeof p === 'string' && p.length <= PATH_MAX && isAbsolute(p) && !p.includes('\0')
  const validAccess = (a: unknown): a is FileAccess => !!a && CONSUMERS.has((a as FileAccess).consumer) && OPERATIONS.has((a as FileAccess).operation)

  /**
   * Authorize `path` for one consumer and operation of a session. A missing path is reported as
   * missing only where it would be authorized; anywhere else it's denied, so existence doesn't leak.
   */
  async function resolveAllowed(handleId: string | null, path: string, access: FileAccess): Promise<FileResource | Refusal> {
    if (!validHandle(handleId) || !validPath(path) || !validAccess(access)) return refuse('invalid')
    const c = await canonical(resolve(path))
    if (!c) return refuse('denied')
    const scope = await scopeOf(handleId, access, c.path)
    if (!scope) return refuse('denied')
    if (scope === 'broad') return refuse('too-broad')
    if (!c.exists) return refuse('missing')
    return identify(c.path, handleId, { consumer: access.consumer, operation: access.operation }, scope)
  }

  /**
   * An exact file grant for a user-opened file or a Configuration source (`handleId` null). Main
   * calls this only for paths it obtained itself; it never grants the file's directory.
   */
  async function grant(handleId: string | null, consumer: FileConsumer, path: string): Promise<boolean> {
    if (!validHandle(handleId) || !CONSUMERS.has(consumer) || !validPath(path)) return false
    const c = await canonical(resolve(path))
    if (!c?.exists || !(await lstat(c.path).catch(() => null))?.isFile()) return false
    const key = grantKey(handleId, consumer)
    grants.set(key, (grants.get(key) ?? new Set()).add(c.path))
    return true
  }

  /** A file main produced itself, addressable by the renderer only through the returned id. */
  async function registerDerived(handleId: string, consumer: FileConsumer, path: string): Promise<string | null> {
    if (!validHandle(handleId) || handleId === null || !CONSUMERS.has(consumer) || !validPath(path)) return null
    const c = await canonical(resolve(path))
    if (!c?.exists || !(await lstat(c.path).catch(() => null))?.isFile()) return null
    const id = randomUUID()
    derived.set(id, { handleId, consumer, path: c.path })
    return id
  }

  async function resolveDerived(handleId: string, id: string, access: FileAccess): Promise<FileResource | Refusal> {
    if (!validHandle(handleId) || typeof id !== 'string' || !validAccess(access)) return refuse('invalid')
    const d = derived.get(id)
    if (!d || d.handleId !== handleId || d.consumer !== access.consumer || dirOp(access.operation)) return refuse('denied')
    return identify(d.path, handleId, { consumer: access.consumer, operation: access.operation }, 'exact')
  }

  function arm(id: string, entry: Watch): FSWatcher | null {
    try {
      const w = fsWatch(entry.r.path, { persistent: false }, () => schedule(id))
      // No re-arm on error: a persistent failure would turn into a change every debounce.
      w.on('error', () => {
        w.close()
        if (entry.watcher === w) entry.watcher = null
        if (watches.get(id) === entry) entry.onChange()
      })
      return w
    } catch {
      return null
    }
  }

  function schedule(id: string): void {
    const entry = watches.get(id)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = setTimeout(() => void settle(id, entry), DEBOUNCE_MS)
  }

  async function settle(id: string, entry: Watch): Promise<void> {
    entry.timer = null
    const s = await lstat(entry.r.path, { bigint: true }).catch(() => null)
    // An atomic replace leaves the watcher on the old inode: re-authorize the path and re-arm.
    // A path that is now missing or denied stays dormant until the consumer reconciles.
    if (!entry.watcher || !s || s.dev !== entry.r.dev || s.ino !== entry.r.ino) {
      entry.watcher?.close()
      entry.watcher = null
      const next = await resolveAllowed(entry.r.handleId, entry.r.path, entry.r)
      if (watches.get(id) !== entry) return
      if (next.ok) {
        entry.r = next
        entry.watcher = arm(id, entry)
      }
    }
    if (watches.get(id) === entry) entry.onChange()
  }

  /** Shallow and debounced. Events are hints: the consumer re-resolves before acting on one. */
  async function watch(r: FileResource, onChange: () => void, pool: WatchPool = 'surface'): Promise<{ ok: true; id: string } | Refusal> {
    if (!genuine(r) || (r.operation !== 'watch-file' && r.operation !== 'watch-directory') || typeof onChange !== 'function') return refuse('invalid')
    let count = 0
    for (const w of watches.values()) if (w.r.handleId === r.handleId && w.pool === pool) count++
    if (count >= POOL_MAX[pool]) return refuse('limit')
    const id = randomUUID()
    const entry: Watch = { r, pool, watcher: null, timer: null, onChange }
    watches.set(id, entry)
    entry.watcher = arm(id, entry)
    const s = await lstat(r.path, { bigint: true }).catch(() => null)
    if (!entry.watcher || !s || s.dev !== r.dev || s.ino !== r.ino) {
      unwatch(id)
      return refuse(s ? 'changed' : 'missing')
    }
    return { ok: true, id }
  }

  function unwatch(id: string): void {
    const entry = watches.get(id)
    if (!entry) return
    watches.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    entry.watcher?.close()
  }

  /** Drops a handle's grants, derived ids and watches; `null` drops the app-level ones. */
  function dispose(handleId: string | null): void {
    for (const [id, w] of watches) if (w.r.handleId === handleId) unwatch(id)
    for (const key of grants.keys()) if (key.startsWith(`${handleId ?? ''}\0`)) grants.delete(key)
    for (const [id, d] of derived) if (d.handleId === handleId) derived.delete(id)
  }

  return { resolveAllowed, grant, registerDerived, resolveDerived, watch, unwatch, dispose }
}
