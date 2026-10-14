// Boundary: the file tree's listing (guard, Git ignore batch, cap), the context menu payload check,
// and the tree's pure flattening and keyboard helpers. Real git against disposable /tmp fixtures.
import { createRequire, registerHooks } from 'node:module'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { equal, ok } from './support/harness.mjs'

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === 'node:child_process' && ctx.parentURL?.endsWith('/workspace/git-status.ts')) return { url: 'node:child_process', shortCircuit: true }
    return next(spec, ctx)
  }
})
const { execFileSync } = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process')
const { createFileAccess, listDir, LIST_MAX, COUNT_MAX } = await import('../src/main/surfaces/files.ts')
const { listTree, treeTarget, validRel } = await import('../src/main/surfaces/tree.ts')
const { ignoredNames } = await import('../src/main/workspace/git-status.ts')
const { parseMenuItems, parseAnchor } = await import('../src/main/context-menu.ts')
const { flatten, sortEntries, typeahead, changeIndex, survivor, ancestorsOf, tilde } = await import('../src/renderer/src/lib/tree.ts')

const fx = mkdtempSync('/tmp/clui-tree-')
const ws = join(fx, 'ws')
const out = join(fx, 'out')
for (const d of [ws, join(ws, 'src'), join(ws, 'src', 'deep'), join(ws, 'node_modules'), join(ws, 'build'), out]) mkdirSync(d, { recursive: true })
writeFileSync(join(ws, 'a.ts'), '')
writeFileSync(join(ws, 'x.log'), '')
writeFileSync(join(ws, ':(top)x.log'), '')
writeFileSync(join(ws, '.env'), '')
writeFileSync(join(ws, 'src', 'deep', 'f.ts'), '')
writeFileSync(join(ws, 'café.md'.normalize('NFD')), '')
writeFileSync(join(out, 'secret.txt'), '')
symlinkSync(out, join(ws, 'outdir'))
execFileSync('mkfifo', [join(ws, 'fifo')])

const cwds = new Map<string, string>([['h1', ws]])
const fa = createFileAccess({ cwd: (h) => cwds.get(h) ?? null, changedPaths: async () => null })
const reason = (r: { ok: boolean }): string => ('reason' in r ? String((r as { reason: string }).reason) : 'ok')
const within = <T,>(p: Promise<T>, ms: number): Promise<T | 'timeout'> => Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))])

// Paths the tree may name, and what the guard refuses
{
  ok(validRel('') && validRel('src/deep') && validRel('a b/c'), 'tree: cwd-relative segments are valid')
  ok(!validRel('/etc') && !validRel('..') && !validRel('src/../..') && !validRel('./src') && !validRel('src//deep') && !validRel('src/') && !validRel('a\0b') && !validRel(3), 'tree: absolute, dot, empty-segment, NUL and non-string paths are invalid')
  equal(reason(await listTree(fa, 'h1', ws, '../out')), 'invalid', 'tree: a parent segment never reaches the guard')
  equal(reason(await listTree(fa, 'h1', ws, 'outdir')), 'denied', 'tree: a child symlink to an outside folder is denied')
  equal(reason(await listTree(fa, 'nobody', null, '')), 'invalid', 'tree: a handle with no cwd is refused')
  equal(reason(await listTree(fa, 'h1', ws, 'a.ts')), 'wrong-type', 'tree: a file cannot be listed')
  equal(reason((await within(listTree(fa, 'h1', ws, 'fifo'), 2000)) as { ok: boolean }), 'wrong-type', 'tree: a FIFO is refused promptly')
  equal(reason(await listTree(fa, 'h1', ws, 'gone')), 'missing', 'tree: a folder that is gone is missing')

  // An ancestor swapped for a symlink after authorization: the verified read refuses it.
  const r = await treeTarget(fa, 'h1', ws, 'src/deep', 'list-directory')
  ok(r.ok, 'tree: a nested folder authorizes')
  renameSync(join(ws, 'src'), join(ws, 'src.bak'))
  symlinkSync(join(ws, 'src.bak'), join(ws, 'src'))
  if (r.ok) equal(reason(await listDir(r)), 'changed', 'tree: an ancestor swapped for a symlink is refused')
  rmSync(join(ws, 'src'))
  renameSync(join(ws, 'src.bak'), join(ws, 'src'))
  equal(reason(await treeTarget(fa, 'h1', ws, 'src', 'watch-directory')), 'ok', 'tree: a folder authorizes for watching')
}

// Outside a repository, the usual build and dependency folders are dimmed
{
  const l = await listTree(fa, 'h1', ws, '')
  ok(l.ok, 'tree: the root lists')
  if (l.ok) {
    const flag = Object.fromEntries(l.entries.map((e) => [e.name, e.ignored]))
    ok(flag.node_modules && flag.build && !flag['x.log'] && !flag.src && !flag['.env'], `tree: SKIP_DIRS fallback outside Git (${JSON.stringify(flag)})`)
    equal(l.total, l.entries.length, 'tree: total equals entries when uncapped')
  }
  equal(await ignoredNames(ws, ['a.ts']), null, 'tree: check-ignore outside a repository answers null')
  // Thousands of names into a git that exits at once: the broken pipe is absorbed, not thrown.
  const many = Array.from({ length: 20_000 }, (_, i) => `name-${i}-${'x'.repeat(40)}`)
  equal(await within(ignoredNames(ws, many), 5000), null, 'tree: a large batch to a non-repository settles without EPIPE')
}

// In a repository, one check-ignore batch flags what Git ignores
{
  const quiet = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
  execFileSync('git', ['-C', ws, 'init', '-q'], { env: quiet })
  writeFileSync(join(ws, '.gitignore'), 'node_modules/\n*.log\ncaf*.md\nsrc/deep/\n')
  const l = await listTree(fa, 'h1', ws, '')
  if (l.ok) {
    const flag = Object.fromEntries(l.entries.map((e) => [e.name.normalize('NFC'), e.ignored]))
    ok(flag.node_modules && flag['x.log'] && flag[':(top)x.log'] && flag['café.md'] && !flag.build && !flag.src && !flag['a.ts'] && !flag['.git'], `tree: Git's verdict replaces the fallback, NFD and magic-looking names included (${JSON.stringify(flag)})`)
  } else ok(false, `tree: repo root lists (${reason(l)})`)
  const sub = await listTree(fa, 'h1', ws, 'src')
  ok(sub.ok && sub.entries.find((e) => e.name === 'deep')?.ignored === true, 'tree: a nested folder is judged from its own directory')
  const inside = await listTree(fa, 'h1', ws, 'node_modules')
  ok(inside.ok, 'tree: an ignored folder still lists')
  const dotgit = await listTree(fa, 'h1', ws, '.git')
  ok(dotgit.ok && dotgit.entries.every((e) => !e.ignored), 'tree: inside .git, where Git refuses to answer, nothing is flagged by Git')
  equal((await ignoredNames(ws, [])).size, 0, 'tree: an empty batch runs no git')

  // A repository's own fsmonitor hook never runs for the tree: check-ignore pins core.fsmonitor=false.
  const marker = join(fx, 'fsmonitor-ran')
  const hook = join(fx, 'fsmonitor.sh')
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`)
  chmodSync(hook, 0o755)
  execFileSync('git', ['-C', ws, 'config', 'core.fsmonitor', hook], { env: quiet })
  execFileSync('git', ['-C', ws, 'status', '--porcelain'], { env: quiet, stdio: 'ignore' })
  ok(existsSync(marker), 'tree: the fixture hook runs for a plain git status')
  rmSync(marker)
  ok((await ignoredNames(ws, ['x.log', 'a.ts']))?.has('x.log') && !existsSync(marker), 'tree: check-ignore answers without running the fsmonitor hook')
  execFileSync('git', ['-C', ws, 'config', '--unset', 'core.fsmonitor'], { env: quiet })
}

// A folder past the cap lists the first LIST_MAX and still counts the rest
{
  const big = join(fx, 'big')
  mkdirSync(big)
  for (let i = 0; i < LIST_MAX + 7; i++) writeFileSync(join(big, `f${i}`), '')
  cwds.set('h2', big)
  const l = await listTree(fa, 'h2', big, '')
  ok(l.ok && l.entries.length === LIST_MAX && l.total === LIST_MAX + 7 && !l.totalCapped, `tree: capped listing keeps the total (${l.ok ? `${l.entries.length}/${l.total}` : reason(l)})`)
  for (let i = LIST_MAX + 7; i < COUNT_MAX + 3; i++) writeFileSync(join(big, `f${i}`), '')
  const huge = await listTree(fa, 'h2', big, '')
  ok(huge.ok && huge.entries.length === LIST_MAX && huge.total === COUNT_MAX && huge.totalCapped, `tree: the count stops at COUNT_MAX and says so (${huge.ok ? `${huge.total}/${huge.totalCapped}` : reason(huge)})`)
  rmSync(big, { recursive: true, force: true })
}

// The context menu payload
{
  const item = (id: string, label = 'Open') => ({ type: 'normal', id, label, enabled: true })
  ok(parseMenuItems([item('open'), { type: 'separator' }, item('copy-relative', "View Claude's Changes")])?.length === 3, 'menu: plain rows pass')
  equal(parseMenuItems([]), null, 'menu: an empty menu is refused')
  equal(parseMenuItems('open'), null, 'menu: a non-array is refused')
  equal(parseMenuItems(Array.from({ length: 17 }, (_, i) => item(`i${i}`))), null, 'menu: more than 16 rows are refused')
  equal(parseMenuItems([{ ...item('open'), role: 'quit' }]), null, 'menu: an extra key such as role is refused')
  equal(parseMenuItems([{ ...item('open'), click: () => {} }]), null, 'menu: a callback is refused')
  equal(parseMenuItems([{ type: 'submenu', id: 'x', label: 'x', enabled: true }]), null, 'menu: other item types are refused')
  equal(parseMenuItems([{ type: 'separator', label: 'x' }, item('a')]), null, 'menu: a separator carries nothing')
  equal(parseMenuItems([item('a'), item('a')]), null, 'menu: duplicate ids are refused')
  equal(parseMenuItems([item('Bad Id')]), null, 'menu: ids are short lowercase tokens')
  equal(parseMenuItems([item('a', 'x'.repeat(81))]), null, 'menu: an overlong label is refused')
  equal(parseMenuItems([item('a', 'Open\u202Efdp.exe')]), null, 'menu: a bidi override in a label is refused')
  equal(parseMenuItems([item('a', 'Open\nnow')]), null, 'menu: a control character in a label is refused')
  equal(parseMenuItems([item('a', 'Open\u200Efile')]), null, 'menu: a left-to-right mark in a label is refused')
  equal(parseMenuItems([item('a', 'Op\u200Ben')]), null, 'menu: a zero-width space in a label is refused')
  equal(parseMenuItems([item('a', '   ')]), null, 'menu: a blank label is refused')
  equal(parseMenuItems([{ ...item('a'), enabled: 'yes' }]), null, 'menu: enabled must be boolean')
  equal(parseMenuItems([{ ...item('a'), enabled: false }, { type: 'separator' }]), null, 'menu: a menu with nothing to choose is refused')
  equal(parseMenuItems([Object.assign(Object.create({ evil: 1 }), item('a'))]), null, 'menu: only plain objects pass')
  equal(parseAnchor(undefined), undefined, 'menu: no anchor opens at the pointer')
  equal(JSON.stringify(parseAnchor({ x: 10, y: 24 })), '{"x":10,"y":24}', 'menu: an integer anchor passes')
  ok(parseAnchor({ x: -1, y: 0 }) === null && parseAnchor({ x: 1.5, y: 0 }) === null && parseAnchor({ x: 1, y: 2, z: 3 }) === null && parseAnchor('1,2') === null, 'menu: negative, fractional, extra-key and non-object anchors are refused')
}

// Flattening, sort, type-ahead, change marks and focus fallback
{
  const e = (name: string, type: 'file' | 'directory' | 'symlink' | 'other' = 'file', ignored = false) => ({ name, type, ignored })
  const root = sortEntries([e('b.ts'), e('src', 'directory'), e('.github', 'directory'), e('a10.ts'), e('a2.ts'), e('node_modules', 'directory', true), e('B.md')])
  equal(root.map((x) => x.name).join(), '.github,node_modules,src,a2.ts,a10.ts,B.md,b.ts', 'tree: folders first, numeric and case-insensitive name order, dotfiles in place')
  const dirs = {
    '': { t: 'ok' as const, entries: root, total: 9, totalCapped: false },
    src: { t: 'ok' as const, entries: sortEntries([e('main', 'directory'), e('x.ts')]), total: 2, totalCapped: false },
    'src/main': { t: 'loading' as const, slow: false },
    '.github': { t: 'ok' as const, entries: [e('ci.yml'), e('link', 'symlink'), e('.secret', 'file')], total: 3, totalCapped: false }
  }
  const rows = flatten(dirs, new Set(['src', 'src/main', '.github']))
  equal(rows.map((r) => (r.t === 'entry' ? `${r.depth}:${r.name}${r.dim ? `(${r.dim})` : ''}` : r.t)).join(' '),
    '0:.github(hidden) 1:ci.yml(hidden) 1:link(hidden) 1:.secret(hidden) 0:node_modules(ignored) 0:src 1:main 1:x.ts 0:a2.ts 0:a10.ts 0:B.md 0:b.ts more',
    'tree: depth-first rows, dim inherited, a fresh load hidden, the cap row last')
  const byName = (n: string) => rows.find((r) => r.t === 'entry' && r.name === n)
  const ci = byName('ci.yml'), secret = byName('.secret'), link = byName('link')
  ok(ci?.t === 'entry' && ci.own === null && ci.dim === 'hidden' && secret?.t === 'entry' && secret.own === 'hidden' && link?.t === 'entry' && link.special === 'link' && !link.dir, 'tree: own dim apart from inherited dim; a symlink is a special leaf')
  const more = rows.at(-1)
  ok(more?.t === 'more' && more.total === 9 && !more.totalCapped, 'tree: the cap row carries the total and whether it is a floor')
  const src = rows.find((r) => r.t === 'entry' && r.name === 'src')
  ok(src?.t === 'entry' && src.open && src.size === 7 && src.pos === 3, 'tree: setsize and posinset are per folder')
  const slow = flatten({ ...dirs, 'src/main': { t: 'loading', slow: true }, src: { t: 'ok', entries: [e('main', 'directory')], total: 1, totalCapped: false } }, new Set(['src', 'src/main']))
  ok(slow.some((r) => r.t === 'loading' && r.parent === 'src/main' && r.depth === 2), 'tree: a slow folder shows one loading row at the child depth')
  ok(flatten({ '': { t: 'ok', entries: [e('d', 'directory')], total: 1, totalCapped: false }, d: { t: 'ok', entries: [], total: 0, totalCapped: false } }, new Set(['d'])).at(-1)?.t === 'empty', 'tree: an empty folder shows its empty row')
  ok(flatten({ '': { t: 'ok', entries: [e('d', 'directory')], total: 1, totalCapped: false }, d: { t: 'error', reason: 'permission' } }, new Set(['d'])).at(-1)?.t === 'error', 'tree: a failed listing shows its error row')

  const at = (name: string) => rows.findIndex((r) => r.t === 'entry' && r.name === name)
  equal(typeahead(rows, at('a2.ts'), 'a'), at('a10.ts'), 'tree: one letter moves past the focused row')
  equal(typeahead(rows, at('B.md'), 'a'), at('a2.ts'), 'tree: type-ahead wraps')
  equal(typeahead(rows, at('a10.ts'), 'a1'), at('a10.ts'), 'tree: a longer buffer can stay on the focused row')
  equal(typeahead(rows, 0, 'zz'), -1, 'tree: no match moves nothing')

  const change = (path: string, missingOnDisk = false) => ({ path, added: 1, removed: 0, created: false, missingOnDisk, approximate: false, diffAvailable: true, snapshot: true, segments: 1, editIds: [] })
  const idx = changeIndex([change('/w/src/main/a.ts'), change('/w/src/b.ts'), change('/w/lib/gone.ts', true), change('/elsewhere/x.ts')], '/w')
  ok(idx.files.has('src/main/a.ts') && idx.files.has('lib/gone.ts') && !idx.files.has('/elsewhere/x.ts'), 'tree: changed files keyed by cwd-relative path')
  ok(idx.dirs.get('src') === '/w/src/main/a.ts' && idx.dirs.has('src/main') && !idx.dirs.has('lib'), 'tree: folders above an on-disk change are marked, first in ledger order; a deleted file marks nothing')

  const prev = rows
  const gone = flatten({ ...dirs, src: { t: 'ok', entries: [e('x.ts')], total: 1, totalCapped: false } }, new Set(['src']))
  equal(survivor(prev, gone, 'src/main'), 'src/x.ts', 'tree: a removed row hands focus to its next sibling')
  const lastGone = flatten({ ...dirs, src: { t: 'ok', entries: [e('main', 'directory')], total: 1, totalCapped: false } }, new Set(['src', 'src/main']))
  equal(survivor(prev, lastGone, 'src/x.ts'), 'src/main', 'tree: else to the previous sibling')
  const collapsed = flatten(dirs, new Set(['.github']))
  equal(survivor(prev, collapsed, 'src/x.ts'), 'src', 'tree: else to the nearest shown parent')
  equal(ancestorsOf('a/b/c.ts').join(), 'a,a/b', 'tree: ancestors outermost first')
  equal(tilde('/Users/me/code', '/Users/me') + tilde('/Users/meow', '/Users/me'), '~/code/Users/meow', 'tree: tilde only on a path boundary')
}

rmSync(fx, { recursive: true, force: true })
