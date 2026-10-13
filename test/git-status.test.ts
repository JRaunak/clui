// Boundary: the Changed Files Git reader, against real git in disposable /tmp repositories.
// The suite runner stubs node:child_process; this file restores the real one for the reader only.
import { createRequire, registerHooks } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync, chmodSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { equal, ok } from './support/harness.mjs'

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'node:child_process' && ctx.parentURL?.endsWith('/workspace/git-status.ts')) return { url: 'node:child_process', shortCircuit: true }
    return next(spec, ctx)
  }
})
const { execFileSync } = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process')
const { readGitStatus, parseStatus } = await import('../src/main/workspace/git-status.ts')

const scratch = mkdtempSync('/tmp/clui-gs-')
const quiet = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
for (const k of Object.keys(quiet)) if (k.startsWith('GIT_') && k !== 'GIT_CONFIG_GLOBAL' && k !== 'GIT_CONFIG_SYSTEM') delete quiet[k]
const ident = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', '-c', 'protocol.file.allow=always']
const g = (cwd: string, ...args: string[]): string => execFileSync('git', [...ident, '-C', cwd, ...args], { env: quiet, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()

/** A committed repo holding `files`, at a path whose name can carry a fake-git marker. */
function repo(name: string, files: Record<string, string> = { 'a.txt': 'a\n' }): string {
  const dir = join(scratch, name)
  mkdirSync(dir, { recursive: true })
  g(dir, 'init', '-q')
  for (const [f, body] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true })
    writeFileSync(join(dir, f), body)
  }
  g(dir, 'add', '-A')
  g(dir, 'commit', '-qm', 'init')
  return dir
}
const one = async (p: string) => (await readGitStatus([p]))[p]
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const TTL = 1100

// The reader inherits this process's env: a stray repository context must not redirect it, and
// the user's global config must not shape the fixtures.
const decoy = repo('decoy')
const savedEnv = { ...process.env }
Object.assign(process.env, { GIT_DIR: join(decoy, '.git'), GIT_INDEX_FILE: join(decoy, '.git', 'index'), GIT_WORK_TREE: decoy, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' })

// A fake git first on PATH: repos named gs-slow/gs-big/gs-boom/gs-trunc/gs-untrusted/gs-count
// misbehave on status (or discovery); everything else runs the real binary.
const bin = join(scratch, 'bin')
const countLog = join(scratch, 'status-count.log')
mkdirSync(bin)
writeFileSync(
  join(bin, 'git'),
  `#!/bin/sh
case "$*" in
  *gs-slow*" status "*) sleep 7 ;;
  *gs-big*" status "*) head -c 9437184 /dev/zero ;;
  *gs-boom*" status "*) echo boom >&2; exit 1 ;;
  *gs-trunc*" status "*) printf '1 .M N... 100644 100644 100644 abc abc a.txt' ;;
  *gs-untrusted*) GIT_TEST_ASSUME_DIFFERENT_OWNER=1 exec "${realGit}" "$@" ;;
  *gs-count*" status "*) echo x >> "${countLog}"; sleep 0.3; exec "${realGit}" "$@" ;;
  *) exec "${realGit}" "$@" ;;
esac
`
)
chmodSync(join(bin, 'git'), 0o755)
process.env.PATH = `${bin}:${process.env.PATH}`

// Started first so the 5s timeout overlaps the rest of the suite.
const slow = repo('gs-slow')
const slowRead = one(join(slow, 'a.txt'))

// Porcelain v2 parsing: paths with spaces, a rename's second path, unmerged records.
{
  const out = [
    '1 .M N... 100644 100644 100644 h1 h1 dir/with space.txt',
    '2 RM N... 100644 100644 100644 h1 h2 R100 new name.txt',
    'old name.txt',
    'u UU N... 100644 100644 100644 100644 h1 h2 h3 both.txt',
    ''
  ].join('\0')
  const m = parseStatus(out)
  ok(m.get('dir/with space.txt')?.y === 'M', 'parse: a path with spaces keeps them')
  ok(m.get('new name.txt')?.from === 'old name.txt' && m.get('old name.txt')?.to === 'new name.txt', 'parse: a rename keys both sides')
  ok(m.get('both.txt')?.conflict === true && m.get('both.txt')?.x === 'U', 'parse: an unmerged record is a conflict')
  let threw = false
  try {
    parseStatus('1 .M N... 100644 100644 100644 h h a.txt')
  } catch {
    threw = true
  }
  ok(threw, 'parse: output without its final NUL is unreadable, not empty')
}

// Clean, unstaged, staged, mixed, both deletions, a recreated staged deletion, a type change.
{
  const r = repo('states', { 'clean.txt': '1\n', 'u.txt': '1\n', 's.txt': '1\n', 'mm.txt': '1\n', 'sd.txt': '1\n', 'ud.txt': '1\n', 'back.txt': '1\n', 'tc.txt': '1\n', 'sub/gone.txt': '1\n' })
  writeFileSync(join(r, 'u.txt'), '2\n')
  writeFileSync(join(r, 's.txt'), '2\n')
  g(r, 'add', 's.txt')
  writeFileSync(join(r, 'mm.txt'), '2\n')
  g(r, 'add', 'mm.txt')
  writeFileSync(join(r, 'mm.txt'), '3\n')
  g(r, 'rm', '-q', 'sd.txt', 'back.txt')
  writeFileSync(join(r, 'back.txt'), 'again\n')
  unlinkSync(join(r, 'ud.txt'))
  unlinkSync(join(r, 'tc.txt'))
  symlinkSync('clean.txt', join(r, 'tc.txt'))
  rmSync(join(r, 'sub'), { recursive: true })
  const p = (f: string): string => join(r, f)
  const s = await readGitStatus(['clean.txt', 'u.txt', 's.txt', 'mm.txt', 'sd.txt', 'ud.txt', 'back.txt', 'tc.txt', 'sub/gone.txt'].map(p))
  equal(s[p('clean.txt')].state, 'unlisted', 'status: tracked and unchanged has no record')
  ok(JSON.stringify(s[p('u.txt')]) === JSON.stringify({ state: 'changed', x: '.', y: 'M' }), 'status: unstaged modification')
  ok(JSON.stringify(s[p('s.txt')]) === JSON.stringify({ state: 'changed', x: 'M', y: '.' }), 'status: staged modification')
  ok(JSON.stringify(s[p('mm.txt')]) === JSON.stringify({ state: 'changed', x: 'M', y: 'M' }), 'status: staged and unstaged')
  ok(JSON.stringify(s[p('sd.txt')]) === JSON.stringify({ state: 'changed', x: 'D', y: '.' }), 'status: staged deletion')
  ok(JSON.stringify(s[p('ud.txt')]) === JSON.stringify({ state: 'changed', x: '.', y: 'D' }), 'status: unstaged deletion')
  ok(s[p('back.txt')].state === 'changed' && (s[p('back.txt')] as any).recreated === true, 'status: a staged deletion whose path exists again')
  ok(JSON.stringify(s[p('tc.txt')]) === JSON.stringify({ state: 'changed', x: '.', y: 'T' }), 'status: type change')
  ok(JSON.stringify(s[p('sub/gone.txt')]) === JSON.stringify({ state: 'changed', x: '.', y: 'D' }), 'status: a deleted file whose directory is gone resolves from its parent')
}

// Staged addition before the first commit.
{
  const r = join(scratch, 'unborn')
  mkdirSync(r)
  g(r, 'init', '-q')
  writeFileSync(join(r, 'first.txt'), 'x\n')
  g(r, 'add', 'first.txt')
  ok(JSON.stringify(await one(join(r, 'first.txt'))) === JSON.stringify({ state: 'changed', x: 'A', y: '.' }), 'status: staged add on an unborn branch')
}

// A rename decorates either ledger path, pointing at the other side.
{
  const r = repo('rename', { 'old.txt': 'same body\n'.repeat(20) })
  g(r, 'mv', 'old.txt', 'new.txt')
  const s = await readGitStatus([join(r, 'old.txt'), join(r, 'new.txt')])
  const src = s[join(r, 'old.txt')] as any
  const dst = s[join(r, 'new.txt')] as any
  ok(src.state === 'changed' && src.x === 'R' && src.renamedTo === join(r, 'new.txt'), 'rename: the source names its target, spelled like the ledger path')
  ok(dst.state === 'changed' && dst.x === 'R' && dst.renamedFrom === join(r, 'old.txt'), 'rename: the target names its source')
}

// A merge conflict.
{
  const r = repo('conflict', { 'c.txt': 'base\n' })
  g(r, 'checkout', '-qb', 'other')
  writeFileSync(join(r, 'c.txt'), 'other\n')
  g(r, 'commit', '-qam', 'other')
  g(r, 'checkout', '-q', 'main')
  writeFileSync(join(r, 'c.txt'), 'main\n')
  g(r, 'commit', '-qam', 'main')
  try {
    g(r, 'merge', '-q', 'other')
  } catch {
    /* the conflict is the point */
  }
  ok(JSON.stringify(await one(join(r, 'c.txt'))) === JSON.stringify({ state: 'conflict', x: 'U', y: 'U' }), 'status: an unmerged path is a conflict')
}

// Untracked, ignored, non-Git and relative paths stay regular.
{
  const r = repo('fallback', { '.gitignore': '*.log\n' })
  writeFileSync(join(r, 'new.txt'), 'x\n')
  writeFileSync(join(r, 'debug.log'), 'x\n')
  const plain = join(scratch, 'not-a-repo')
  mkdirSync(plain)
  writeFileSync(join(plain, 'f.txt'), 'x\n')
  const s = await readGitStatus([join(r, 'new.txt'), join(r, 'debug.log'), join(plain, 'f.txt'), 'relative.txt'])
  equal(s[join(r, 'new.txt')].state, 'unlisted', 'fallback: untracked has no record')
  equal(s[join(r, 'debug.log')].state, 'unlisted', 'fallback: ignored has no record')
  equal(s[join(plain, 'f.txt')].state, 'none', 'fallback: outside any repository is none, not unavailable')
  equal(s['relative.txt'].state, 'none', 'fallback: a relative path is never resolved against the main process cwd')
}

// Spaces, Unicode (asked for decomposed), a newline and pathspec magic stay literal.
{
  const names = ['with space.txt', 'ünïcode.txt', 'new\nline.txt', '*.md', ':(glob)x.txt', '-n.txt']
  const r = repo('names', Object.fromEntries([...names, 'plain.md'].map((n) => [n, '1\n'])))
  for (const n of names.filter((n) => n !== '*.md')) writeFileSync(join(r, n), '2\n')
  const asked = [...names.map((n) => join(r, n)), join(r, 'ünïcode.txt'.normalize('NFD'))]
  const s = await readGitStatus(asked)
  for (const n of names.filter((n) => n !== '*.md')) equal((s[join(r, n)] as any)?.y, 'M', `names: ${JSON.stringify(n)} is modified`)
  equal(s[join(r, '*.md')].state, 'unlisted', 'names: a clean glob-like name gets no other file\'s record')
  equal((s[join(r, 'ünïcode.txt'.normalize('NFD'))] as any)?.y, 'M', 'names: a decomposed ledger path matches git\'s composed one')
}

// A nested repository and an initialized submodule use their own status.
{
  const outer = repo('outer', { 'o.txt': '1\n' })
  const inner = join(outer, 'inner')
  mkdirSync(inner)
  g(inner, 'init', '-q')
  writeFileSync(join(inner, 'i.txt'), '1\n')
  g(inner, 'add', 'i.txt')
  g(inner, 'commit', '-qm', 'i')
  writeFileSync(join(inner, 'i.txt'), '2\n')
  const lib = repo('lib-src', { 'l.txt': '1\n' })
  g(outer, 'submodule', 'add', '-q', lib, 'mod')
  g(outer, 'commit', '-qm', 'sub')
  writeFileSync(join(outer, 'mod', 'l.txt'), '2\n')
  const s = await readGitStatus([join(inner, 'i.txt'), join(outer, 'mod', 'l.txt'), join(outer, 'o.txt')])
  equal((s[join(inner, 'i.txt')] as any)?.y, 'M', 'nested: a nested repository reports its own file')
  equal((s[join(outer, 'mod', 'l.txt')] as any)?.y, 'M', 'nested: a submodule file reports from the submodule')
  equal(s[join(outer, 'o.txt')].state, 'unlisted', 'nested: the outer repository has no record for its clean file')
}

// A linked worktree has its own index, and a symlinked directory into another repo is not relabeled.
{
  const r = repo('wt-main', { 'f.txt': '1\n' })
  const wt = join(scratch, 'wt-linked')
  g(r, 'worktree', 'add', '-q', wt, '-b', 'side')
  writeFileSync(join(wt, 'f.txt'), '2\n')
  g(wt, 'add', 'f.txt')
  const other = repo('link-target', { 'x.txt': '1\n' })
  writeFileSync(join(other, 'x.txt'), '2\n')
  const host = repo('link-host', { 'h.txt': '1\n' })
  symlinkSync(other, join(host, 'into'))
  g(host, 'add', 'into')
  symlinkSync(other, join(host, 'untracked-link'))
  const s = await readGitStatus([join(r, 'f.txt'), join(wt, 'f.txt'), join(host, 'into', 'x.txt'), join(host, 'untracked-link', 'x.txt')])
  equal(s[join(r, 'f.txt')].state, 'unlisted', 'worktree: the main checkout has no record from the linked one')
  equal((s[join(wt, 'f.txt')] as any)?.x, 'M', 'worktree: the linked worktree reads its own index')
  equal(s[join(host, 'into', 'x.txt')].state, 'none', 'symlink: a path through a tracked symlink is not relabeled with the target repo')
  equal((s[join(host, 'untracked-link', 'x.txt')] as any)?.y, 'M', 'symlink: an untracked link to a checkout, like /tmp, still reads that checkout')
}

// External staging and commits change the decoration; user edits only touch Git state.
{
  const r = repo('external', { 'e.txt': '1\n' })
  const p = join(r, 'e.txt')
  writeFileSync(p, '2\n')
  equal((await one(p) as any)?.y, 'M', 'external: modified')
  g(r, 'add', 'e.txt')
  await sleep(TTL)
  equal((await one(p) as any)?.x, 'M', 'external: staging outside Clui shows on the next read')
  g(r, 'commit', '-qm', 'e')
  await sleep(TTL)
  equal((await one(p)).state, 'unlisted', 'external: a commit returns the row to regular styling')
}

// Failures are unavailable with a cause, never clean.
{
  const big = repo('gs-big')
  const boom = repo('gs-boom')
  const trunc = repo('gs-trunc')
  const untrusted = repo('gs-untrusted')
  const s = await readGitStatus([join(big, 'a.txt'), join(boom, 'a.txt'), join(trunc, 'a.txt'), join(untrusted, 'a.txt')])
  ok(JSON.stringify(s[join(big, 'a.txt')]) === JSON.stringify({ state: 'unavailable', cause: 'timeout' }), 'failure: output over the cap')
  ok(JSON.stringify(s[join(boom, 'a.txt')]) === JSON.stringify({ state: 'unavailable', cause: 'unreadable' }), 'failure: git exits nonzero')
  ok(JSON.stringify(s[join(trunc, 'a.txt')]) === JSON.stringify({ state: 'unavailable', cause: 'unreadable' }), 'failure: truncated output')
  ok(JSON.stringify(s[join(untrusted, 'a.txt')]) === JSON.stringify({ state: 'unavailable', cause: 'untrusted' }), 'failure: safe.directory refusal')
}

// Concurrent requests for one working tree share a single status read.
{
  const r = repo('gs-count', { 'a.txt': '1\n', 'b.txt': '1\n' })
  writeFileSync(join(r, 'a.txt'), '2\n')
  const [x, y] = await Promise.all([one(join(r, 'a.txt')), one(join(r, 'b.txt'))])
  ok((x as any)?.y === 'M' && y.state === 'unlisted', 'coalesce: both callers get the tree read')
  equal(readFileSync(countLog, 'utf8').split('\n').filter(Boolean).length, 1, 'coalesce: one status per working tree in flight')
}

// Git missing entirely.
{
  const r = repo('nogit')
  const path = process.env.PATH
  process.env.PATH = join(scratch, 'empty-bin')
  const s = await one(join(r, 'a.txt'))
  process.env.PATH = path
  ok(JSON.stringify(s) === JSON.stringify({ state: 'unavailable', cause: 'git-missing' }), 'failure: git not found')
}

ok(JSON.stringify(await slowRead) === JSON.stringify({ state: 'unavailable', cause: 'timeout' }), 'failure: the 5s timeout')

for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]
Object.assign(process.env, savedEnv)
rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
