/**
 * Read-only Git metadata for the Changed Files tray: one porcelain v2 status per working tree.
 * Decoration only; it never reads file contents and never touches the ledger's counts.
 */
import { execFile, type ExecFileException } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { ChangeGitStatus, GitPathStatus, GitUnavailableCause } from '../../shared/changes'

const TIMEOUT_MS = 5000
const MAX_BUFFER = 8 * 1024 * 1024
/** Coalesces bursts (streaming edits, several sessions in one checkout) under the tray's 2s poll. */
const STATUS_TTL_MS = 1000
const ROOT_TTL_MS = 10_000

// `git rev-parse --local-env-vars`: the variables git itself clears so an outer repository
// context can't redirect a command to another checkout or index.
const REPO_ENV = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR'
]

type Reason = GitUnavailableCause | 'not-repo'

class GitFailure extends Error {
  readonly reason: Reason
  constructor(reason: Reason) {
    super(reason)
    this.reason = reason
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of REPO_ENV) delete env[k]
  // The not-a-repository and safe.directory checks match git's English messages.
  env.LC_ALL = 'C'
  return env
}

function classify(err: ExecFileException, stderr: string): Reason {
  if (err.code === 'ENOENT') return 'git-missing'
  if (err.killed || err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'timeout'
  if (/dubious ownership|safe\.directory/.test(stderr)) return 'untrusted'
  if (/not a git repository|must be run in a work tree/.test(stderr)) return 'not-repo'
  return 'unreadable'
}

function git(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-C', root, ...args],
      { env: gitEnv(), timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
      (err, stdout, stderr) => (err ? reject(new GitFailure(classify(err, stderr))) : resolve(stdout))
    )
  })
}

const reasonOf = (e: unknown): Reason => (e instanceof GitFailure ? e.reason : 'unreadable')
// APFS hands back names as stored while git precomposes them; compare composed forms.
const nfc = (s: string): string => s.normalize('NFC')

interface StatusRecord {
  x: string
  y: string
  conflict: boolean
  to?: string
  from?: string
}

/** Text after the record's `n`th space: the path, which may itself hold spaces. */
function pathAfter(rec: string, n: number): string {
  let at = -1
  for (let i = 0; i < n; i++) {
    at = rec.indexOf(' ', at + 1)
    if (at < 0) throw new GitFailure('unreadable')
  }
  return rec.slice(at + 1)
}

/** `status --porcelain=v2 -z`, keyed by repo-relative path. A rename's source is keyed too, unless it has its own record. */
export function parseStatus(out: string): Map<string, StatusRecord> {
  if (out && !out.endsWith('\0')) throw new GitFailure('unreadable')
  const direct = new Map<string, StatusRecord>()
  const sources = new Map<string, StatusRecord>()
  const recs = out.split('\0')
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i]
    const x = rec[2]
    const y = rec[3]
    if (rec[0] === '1') direct.set(nfc(pathAfter(rec, 8)), { x, y, conflict: false })
    else if (rec[0] === 'u') direct.set(nfc(pathAfter(rec, 10)), { x, y, conflict: true })
    else if (rec[0] === '2') {
      const to = nfc(pathAfter(rec, 9))
      const from = recs[++i]
      if (!from) throw new GitFailure('unreadable')
      direct.set(to, { x, y, conflict: false, from: nfc(from) })
      sources.set(nfc(from), { x, y, conflict: false, to })
    }
  }
  for (const [p, r] of sources) if (!direct.has(p)) direct.set(p, r)
  return direct
}

interface Cached<T> {
  at: number
  pending: boolean
  read: Promise<T>
}

/** One read per key: an in-flight read is shared whatever its age, a settled one until `ttl`. */
function cachedRead<T>(cache: Map<string, Cached<T>>, key: string, ttl: number, run: () => Promise<T>): Promise<T> {
  const now = Date.now()
  for (const [k, c] of cache) if (!c.pending && now - c.at >= ttl) cache.delete(k)
  const hit = cache.get(key)
  if (hit) return hit.read
  const entry: Cached<T> = { at: now, pending: true, read: run() }
  const settle = (): void => {
    entry.pending = false
    entry.at = Date.now()
  }
  entry.read.then(settle, settle)
  cache.set(key, entry)
  return entry.read
}

const roots = new Map<string, Cached<string>>()
const trees = new Map<string, Cached<Map<string, StatusRecord>>>()

function toplevel(dir: string): Promise<string> {
  return cachedRead(roots, dir, ROOT_TTL_MS, async () => {
    const out = await git(dir, ['rev-parse', '--show-toplevel'])
    return out.endsWith('\n') ? out.slice(0, -1) : out
  })
}

function treeStatus(top: string): Promise<Map<string, StatusRecord>> {
  return cachedRead(trees, top, STATUS_TTL_MS, async () =>
    parseStatus(await git(top, ['status', '--porcelain=v2', '-z', '--untracked-files=no', '--ignore-submodules=none']))
  )
}

interface Located {
  path: string
  top: string
  /** The checkout root as the ledger spells it, for absolute rename targets the tray can relativize. */
  lexicalTop: string
  rel: string
}

/**
 * The working tree that holds `path`, found from its nearest existing directory, so a deleted
 * file still resolves. A path reached through a symlinked directory resolves to nothing: its
 * target's status would describe a different file.
 */
async function locate(path: string): Promise<Located | Reason> {
  if (!isAbsolute(path)) return 'not-repo'
  let dir = dirname(path)
  let real: string | null = null
  while (real === null) {
    real = await realpath(dir).catch(() => null)
    if (real === null) {
      if (dirname(dir) === dir) return 'not-repo'
      dir = dirname(dir)
    }
  }
  let top: string
  try {
    top = await toplevel(dir)
  } catch (e) {
    return reasonOf(e)
  }
  const inRepo = nfc(relative(top, real))
  if (inRepo.startsWith('..') || isAbsolute(inRepo)) return 'not-repo'
  const lexicalDir = nfc(dir)
  if (inRepo && !lexicalDir.endsWith(sep + inRepo)) return 'not-repo'
  const lexicalTop = inRepo ? lexicalDir.slice(0, -(inRepo.length + 1)) : lexicalDir
  if ((await realpath(lexicalTop).catch(() => null)) !== top) return 'not-repo'
  if (lexicalTop !== top && (await viaTrackedSymlink(lexicalTop))) return 'not-repo'
  const rel = relative(lexicalTop, nfc(path)).split(sep).join('/')
  return rel ? { path, top, lexicalTop, rel } : 'not-repo'
}

/** True when a symlink on the way to the checkout is itself tracked by an outer repository. */
async function viaTrackedSymlink(lexicalTop: string): Promise<boolean> {
  for (let d = lexicalTop; dirname(d) !== d; d = dirname(d)) {
    if (!(await lstat(d).then((st) => st.isSymbolicLink(), () => false))) continue
    if (await git(dirname(d), ['ls-files', '--cached', '-z', '--', basename(d)]).catch(() => '')) return true
  }
  return false
}

const fromReason = (r: Reason): GitPathStatus => (r === 'not-repo' ? { state: 'none' } : { state: 'unavailable', cause: r })

async function decorate(l: Located, rec: StatusRecord): Promise<GitPathStatus> {
  if (rec.conflict) return { state: 'conflict', x: rec.x, y: rec.y }
  const s: GitPathStatus = { state: 'changed', x: rec.x, y: rec.y }
  if (rec.to !== undefined) s.renamedTo = join(l.lexicalTop, rec.to)
  if (rec.from !== undefined) s.renamedFrom = join(l.lexicalTop, rec.from)
  if (rec.x === 'D' && rec.y === '.' && (await lstat(l.path).then(() => true, () => false))) s.recreated = true
  return s
}

async function readTree(top: string, items: Located[], out: ChangeGitStatus): Promise<void> {
  let status: Map<string, StatusRecord>
  try {
    status = await treeStatus(top)
  } catch (e) {
    for (const l of items) out[l.path] = fromReason(reasonOf(e))
    return
  }
  for (const l of items) {
    const rec = status.get(l.rel)
    out[l.path] = rec ? await decorate(l, rec) : { state: 'unlisted' }
  }
}

/** Git decoration for each ledger path. Failure is `unavailable`, never unlisted; a non-repository path is `none`. */
export async function readGitStatus(paths: string[]): Promise<ChangeGitStatus> {
  const out: ChangeGitStatus = {}
  const byTree = new Map<string, Located[]>()
  await Promise.all(
    [...new Set(paths)].map(async (p) => {
      const l = await locate(p)
      if (typeof l === 'string') out[p] = fromReason(l)
      else byTree.set(l.top, [...(byTree.get(l.top) ?? []), l])
    })
  )
  await Promise.all([...byTree].map(([top, items]) => readTree(top, items, out)))
  return out
}
