import type { FileChangeSummary } from '../../../shared/changes'
import type { Refusal, TreeEntry } from '../../../shared/files'

/** A folder's listing as the tree holds it, keyed by its cwd-relative path ('' for the cwd). */
export type DirState =
  | { t: 'loading'; slow: boolean }
  | { t: 'ok'; entries: TreeEntry[]; total: number; totalCapped: boolean }
  | { t: 'error'; reason: Refusal['reason'] }

export type Dim = 'ignored' | 'hidden' | null

export type TreeRow =
  | {
      t: 'entry'
      key: string
      rel: string
      name: string
      depth: number
      dir: boolean
      /** A symlink or a special file: a leaf, never followed. */
      special: 'link' | 'other' | null
      open: boolean
      /** The row's tone: its own state, else one inherited from a folder above it. */
      dim: Dim
      /** The row's own state, which the description names and `*` respects. */
      own: Dim
      /** Hidden only by its own leading dot, so its icon keeps the mapped hue. */
      lit: boolean
      size: number
      pos: number
      parent: string
    }
  | { t: 'loading' | 'empty'; key: string; parent: string; depth: number }
  | { t: 'error'; key: string; parent: string; depth: number; reason: Refusal['reason'] }
  | { t: 'more'; key: string; parent: string; depth: number; shown: number; total: number; totalCapped: boolean }

const COLLATE = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Folders first, then files, each in Finder's name order. A symlink to a folder stays a leaf. */
export const sortEntries = (entries: TreeEntry[]): TreeEntry[] =>
  entries.toSorted((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || COLLATE.compare(a.name, b.name))

export const parentOf = (rel: string): string => rel.slice(0, Math.max(0, rel.lastIndexOf('/')))
export const nameOf = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1)
export const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name)
export const tilde = (p: string, home: string): string => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p)

/** The fewest trailing directory names that tell apart file tabs sharing a basename. */
export function suffixes(paths: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const groups = Map.groupBy(paths, nameOf)
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const dirs = group.map((p) => parentOf(p).split('/').filter(Boolean))
    for (const [i, p] of group.entries()) {
      const mine = dirs[i]
      let k = 1
      const tail = (d: string[], n: number): string => d.slice(-n).join('/')
      while (k < mine.length && dirs.some((d, j) => j !== i && tail(d, k) === tail(mine, k))) k++
      out.set(p, tail(mine, k))
    }
  }
  return out
}

/** The folders that hold `rel`, outermost first, without the root. */
export function ancestorsOf(rel: string): string[] {
  const out: string[] = []
  for (let i = rel.indexOf('/'); i >= 0; i = rel.indexOf('/', i + 1)) out.push(rel.slice(0, i))
  return out
}

/** The visible rows, depth first. A folder whose listing isn't in yet shows its loading row only once it's slow. */
export function flatten(dirs: Readonly<Record<string, DirState>>, open: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (dir: string, depth: number, dim: Dim): void => {
    const d = dirs[dir]
    if (!d || (d.t === 'loading' && !d.slow)) return
    const status = (t: 'loading' | 'empty'): void => void rows.push({ t, key: `\0${t}:${dir}`, parent: dir, depth })
    if (d.t === 'loading') return status('loading')
    if (d.t === 'error') return void rows.push({ t: 'error', key: `\0error:${dir}`, parent: dir, depth, reason: d.reason })
    if (!d.entries.length) return status('empty')
    const size = d.entries.length
    d.entries.forEach((e, i) => {
      const rel = join(dir, e.name)
      const isDir = e.type === 'directory'
      const own: Dim = e.ignored ? 'ignored' : e.name.startsWith('.') ? 'hidden' : null
      const isOpen = isDir && open.has(rel)
      const special = e.type === 'symlink' ? 'link' : e.type === 'other' ? 'other' : null
      rows.push({ t: 'entry', key: rel, rel, name: e.name, depth, dir: isDir, special, open: isOpen, dim: own ?? dim, own, lit: own === 'hidden' && !dim, size, pos: i + 1, parent: dir })
      if (isOpen) walk(rel, depth + 1, own ?? dim)
    })
    if (d.total > size) rows.push({ t: 'more', key: `\0more:${dir}`, parent: dir, depth, shown: size, total: d.total, totalCapped: d.totalCapped })
  }
  walk('', 0, null)
  return rows
}

/**
 * Type-ahead over the visible entries, wrapping. A fresh single character starts past `from`, so
 * pressing one letter again cycles through the names that start with it.
 */
export function typeahead(rows: readonly TreeRow[], from: number, text: string): number {
  const n = rows.length
  const start = text.length === 1 ? from + 1 : from
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n
    const r = rows[i]
    if (r.t === 'entry' && r.name.toLowerCase().startsWith(text)) return i
  }
  return -1
}

/** Claude's changed files by cwd-relative path, and every folder above one that's still on disk. */
export function changeIndex(changes: readonly FileChangeSummary[], cwd: string): { files: Map<string, FileChangeSummary>; dirs: Map<string, string> } {
  const files = new Map<string, FileChangeSummary>()
  // Each folder maps to its first changed file in ledger order, the one View Claude's Changes opens at.
  const dirs = new Map<string, string>()
  for (const c of changes) {
    if (!c.path.startsWith(`${cwd}/`)) continue
    const rel = c.path.slice(cwd.length + 1)
    files.set(rel, c)
    if (c.missingOnDisk) continue
    for (const a of ancestorsOf(rel)) if (!dirs.has(a)) dirs.set(a, c.path)
  }
  return { files, dirs }
}

/** Where focus goes when the focused row leaves: its next sibling still shown, else the previous, else its parent. */
export function survivor(prev: readonly TreeRow[], rows: readonly TreeRow[], key: string): string | null {
  const keys = new Set(rows.map((r) => r.key))
  const i = prev.findIndex((r) => r.key === key)
  if (i < 0) return rows[0]?.key ?? null
  const parent = prev[i].parent
  const sibling = (r: TreeRow): boolean => r.t === 'entry' && r.parent === parent && keys.has(r.key)
  const next = prev.slice(i + 1).find(sibling) ?? prev.slice(0, i).findLast(sibling)
  if (next) return next.key
  for (let p = parent; p; p = parentOf(p)) if (keys.has(p)) return p
  return rows[0]?.key ?? null
}

/**
 * Folders saved before a relaunch, split into those to reopen now and those still waiting on their
 * parent's listing. One that is Git-ignored, hidden or gone drops out with everything under it, so a
 * restore never reopens what only the user's own expand may open.
 */
export function vetExpanded(pending: readonly string[], open: ReadonlySet<string>, dirs: Readonly<Record<string, DirState>>): { admit: string[]; wait: string[] } {
  const admit: string[] = []
  const wait: string[] = []
  for (const rel of pending) {
    const parent = parentOf(rel)
    if (parent && !open.has(parent)) {
      if (pending.includes(parent)) wait.push(rel)
      continue
    }
    const d = dirs[parent]
    if (!d || d.t === 'loading') {
      wait.push(rel)
      continue
    }
    const name = nameOf(rel)
    const e = d.t === 'ok' ? d.entries.find((x) => x.name === name) : undefined
    if (e && e.type === 'directory' && !e.ignored && !name.startsWith('.')) admit.push(rel)
  }
  return { admit, wait }
}
