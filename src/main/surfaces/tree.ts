/** The file tree's listing: one guarded directory read plus Git's ignore verdict for its children. */
import { join } from 'node:path'
import type { Refusal, TreeListing } from '../../shared/files'
import { listDir, type createFileAccess } from './files'
import { ignoredNames } from '../workspace/git-status'
import { SKIP_DIRS } from '../workspace/files'

const REL_MAX = 4096

/** A tree path names a folder under the cwd by its segments: '' is the root, and there is no `.`, `..` or leading slash. */
export const validRel = (rel: unknown): rel is string =>
  typeof rel === 'string' && rel.length <= REL_MAX && !rel.includes('\0') && (rel === '' || rel.split('/').every((s) => s !== '' && s !== '.' && s !== '..'))

/** Where `rel` sits for `operation`, or why it can't; the guard still decides containment from the canonical path. */
export function treeTarget(files: ReturnType<typeof createFileAccess>, handleId: unknown, cwd: string | null, rel: unknown, operation: 'list-directory' | 'watch-directory') {
  if (typeof handleId !== 'string' || cwd === null || !validRel(rel)) return Promise.resolve<Refusal>({ ok: false, reason: 'invalid' })
  return files.resolveAllowed(handleId, rel ? join(cwd, rel) : cwd, { consumer: 'tree', operation })
}

export async function listTree(files: ReturnType<typeof createFileAccess>, handleId: unknown, cwd: string | null, rel: unknown): Promise<TreeListing | Refusal> {
  const r = await treeTarget(files, handleId, cwd, rel, 'list-directory')
  if (!r.ok) return r
  const l = await listDir(r)
  if (!l.ok) return l
  const ignored = await ignoredNames(r.path, l.entries.map((e) => e.name))
  return {
    ok: true,
    total: l.total,
    totalCapped: l.totalCapped,
    entries: l.entries.map((e) => ({ ...e, ignored: ignored ? ignored.has(e.name) : e.type === 'directory' && SKIP_DIRS.has(e.name) }))
  }
}
