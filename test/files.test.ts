// Boundary: the guarded file layer, against real fixtures in a disposable /tmp tree.
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync, appendFileSync, openSync, ftruncateSync, closeSync, utimesSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createFileAccess, guardProven, listDir, readBytes, readText, statFile, CHUNK_MAX, TEXT_MAX, WATCH_MAX, type FileResource, type Refusal } from '../src/main/surfaces/files.ts'
import { equal, ok } from './support/harness.mjs'

const { execFileSync } = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process')

// The /tmp spelling on purpose: /tmp is a symlink to /private/tmp, so every input here is non-canonical.
const fx = mkdtempSync('/tmp/clui-files-')
const real = realpathSync(fx)
const ws = join(fx, 'ws')
const out = join(fx, 'out')
for (const d of [ws, join(ws, 'sub'), join(ws, 'other'), out, join(out, 'dir')]) mkdirSync(d)
writeFileSync(join(ws, 'a.txt'), 'hello\n')
writeFileSync(join(ws, 'sub', 'f.txt'), 'inside\n')
writeFileSync(join(ws, 'other', 'f.txt'), 'impostor\n')
writeFileSync(join(out, 'secret.txt'), 'secret\n')
writeFileSync(join(out, 'granted.txt'), 'granted\n')
writeFileSync(join(out, 'neighbour.txt'), 'neighbour\n')
writeFileSync(join(out, 'ledger.txt'), 'ledger\n')
writeFileSync(join(out, 'derived.txt'), 'derived\n')
writeFileSync(join(out, 'dir', 'secret.txt'), 'secret\n')
symlinkSync(join(ws, 'sub', 'f.txt'), join(ws, 'inlink'))
symlinkSync(join(out, 'secret.txt'), join(ws, 'outlink'))
symlinkSync(join(out, 'dir'), join(ws, 'outdir'))

const cwds = new Map<string, string>([['h1', ws], ['h2', ws]])
const ledger = new Map<string, string[]>([['h1', [join(out, 'ledger.txt'), join(out, 'deleted.txt')]]])
const fa = createFileAccess({ cwd: (h) => cwds.get(h) ?? null, changedPaths: async (h) => ledger.get(h) ?? null })

const file = { consumer: 'file', operation: 'read-file' } as const
const tree = { consumer: 'tree', operation: 'list-directory' } as const
const reason = (r: FileResource | Refusal | { ok: boolean }): string => ('reason' in r ? (r as Refusal).reason : 'ok')
const must = async (p: Promise<FileResource | Refusal>): Promise<FileResource> => {
  const r = await p
  if (!r.ok) throw new Error(`expected a resource, got ${r.reason}`)
  return r
}
const fds = (): number => readdirSync('/dev/fd').length
const within = <T,>(p: Promise<T>, ms: number): Promise<T | 'timeout'> => Promise.race([p, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms))])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

ok(await guardProven(), 'files: O_NOFOLLOW_ANY refuses an ancestor symlink on this runtime')
// Taken after the first async fs call, which lazily opens a libuv descriptor of its own.
const fdsBefore = fds()

// Workspace containment and canonical paths
{
  const r = await must(fa.resolveAllowed('h1', join(ws, 'a.txt'), file))
  equal(r.path, join(real, 'ws', 'a.txt'), 'files: resolved path is canonical')
  const t = await readText(r)
  ok(t.ok && t.text === 'hello\n' && !t.binary && !t.truncated && t.size === 6, 'files: workspace file reads')
  equal(reason(await fa.resolveAllowed('h1', join(ws, 'sub', '..', '..', 'out', 'secret.txt'), file)), 'denied', 'files: dot-dot traversal out of the workspace is denied')
  equal(reason(await fa.resolveAllowed('h1', join(ws, '%2e%2e', 'out', 'secret.txt'), file)), 'missing', 'files: percent-encoded traversal is a literal name, not a parent')
  equal(reason(await fa.resolveAllowed('h1', join(ws, '..%2fout%2fsecret.txt'), file)), 'missing', 'files: encoded separator is a literal name')
  equal(reason(await fa.resolveAllowed('h1', 'a.txt', file)), 'invalid', 'files: relative path is invalid')
  equal(reason(await fa.resolveAllowed('h1', join(ws, 'a.txt\0x'), file)), 'invalid', 'files: NUL byte is invalid')
  equal(reason(await fa.resolveAllowed('h1', 42 as unknown as string, file)), 'invalid', 'files: non-string path is invalid')
  equal(reason(await fa.resolveAllowed('h1', join(ws, 'a.txt'), { consumer: 'browser', operation: 'read-file' } as never)), 'invalid', 'files: unknown consumer is invalid')
  equal(reason(await fa.resolveAllowed('h1', join(ws, 'a.txt'), { consumer: 'file', operation: 'write-file' } as never)), 'invalid', 'files: unknown operation is invalid')
  equal(reason(await fa.resolveAllowed('gone', join(ws, 'a.txt'), file)), 'denied', 'files: a gone session has no workspace')
  cwds.set('pfx', join(fx, 'w'))
  mkdirSync(join(fx, 'w'))
  equal(reason(await fa.resolveAllowed('pfx', join(ws, 'a.txt'), file)), 'denied', 'files: containment is by path component, not string prefix')
}

// Symlinks inside and outside
{
  const r = await must(fa.resolveAllowed('h1', join(ws, 'inlink'), file))
  equal(r.path, join(real, 'ws', 'sub', 'f.txt'), 'files: an inside symlink resolves to its inside target')
  equal(reason(await fa.resolveAllowed('h1', join(ws, 'outlink'), file)), 'denied', 'files: a symlink to an outside file is denied')
  equal(reason(await fa.resolveAllowed('h1', join(ws, 'outdir'), tree)), 'denied', 'files: listing a symlinked outside dir is denied')
  equal(reason(await fa.resolveAllowed('h1', join(ws, 'outdir', 'secret.txt'), file)), 'denied', 'files: reading through a symlinked outside dir is denied')
}

// Root listing versus directory bytes
{
  const root = await must(fa.resolveAllowed('h1', ws, tree))
  const l = await listDir(root)
  const names = l.ok ? l.entries.map((e) => `${e.name}:${e.type}`).sort() : []
  ok(names.includes('a.txt:file') && names.includes('sub:directory') && names.includes('outlink:symlink') && !names.includes('.:directory'), 'files: the root lists, symlinks reported as symlinks')
  equal(reason(await fa.resolveAllowed('h1', ws, file)), 'wrong-type', 'files: reading directory bytes is refused')
  equal(reason(await readText({ ...root, operation: 'read-file' })), 'invalid', 'files: a forged resource is refused')
  equal(reason(await readText({ ...root, operation: 'read-file', type: 'file' })), 'invalid', 'files: a forged file resource over a directory is refused')
  equal(reason(await statFile({ ...root })), 'invalid', 'files: a copied resource is refused')
  ok(Object.isFrozen(root), 'files: issued resources are frozen')
  equal(reason(await readText(root)), 'invalid', 'files: a list resource cannot be read as text')
  equal(reason(await listDir(await must(fa.resolveAllowed('h1', join(ws, 'a.txt'), file)))), 'invalid', 'files: a file resource cannot be listed')
  equal(reason(await fa.resolveAllowed('h1', join(ws, 'a.txt'), tree)), 'wrong-type', 'files: listing a file is refused')
  const st = await statFile(root)
  ok(st.ok && st.type === 'directory', 'files: statFile on the root')
}

// Home and filesystem-root narrowing, compared canonically
{
  cwds.set('home', homedir() + '/')
  cwds.set('slash', '/')
  cwds.set('tmp', '/tmp/../tmp')
  equal(reason(await fa.resolveAllowed('home', homedir(), tree)), 'denied', 'files: a home cwd cannot list home')
  equal(reason(await fa.resolveAllowed('home', join(homedir(), '.clui-no-such-file'), file)), 'denied', 'files: a home cwd confers nothing under home')
  const realHome = realpathSync(homedir())
  cwds.set('data', '/System/Volumes/Data')
  cwds.set('datahome', '/System/Volumes/Data' + realHome)
  for (const h of ['data', 'datahome']) {
    equal(reason(await fa.resolveAllowed(h, '/System/Volumes/Data' + realHome, tree)), 'denied', `files: a ${h} cwd cannot list home via the Data volume`)
    equal(reason(await fa.resolveAllowed(h, '/System/Volumes/Data' + realHome + '/.zshrc', file)), 'denied', `files: a ${h} cwd confers nothing under home`)
  }
  equal(reason(await fa.resolveAllowed('slash', join(ws, 'a.txt'), file)), 'denied', 'files: a / cwd confers nothing')
  equal(reason(await fa.resolveAllowed('slash', '/', tree)), 'denied', 'files: a / cwd cannot list /')
  ok((await fa.resolveAllowed('tmp', join(ws, 'a.txt'), file)).ok, 'files: a non-canonical cwd spelling still contains')
  ok(await fa.grant('slash', 'file', join(out, 'granted.txt')), 'files: grant under a narrowed cwd')
  ok((await fa.resolveAllowed('slash', join(out, 'granted.txt'), file)).ok, 'files: exact grants still work under a narrowed cwd')
}

// Exact grants: outside the workspace, bound to session and consumer, never the parent
{
  ok(await fa.grant('h1', 'file', join(out, 'granted.txt')), 'files: user-open grant accepted')
  const g = await must(fa.resolveAllowed('h1', join(out, 'granted.txt'), file))
  const t = await readText(g)
  ok(t.ok && t.text === 'granted\n', 'files: outside exact grant reads')
  equal(reason(await fa.resolveAllowed('h1', join(out, 'neighbour.txt'), file)), 'denied', 'files: the grant does not expose a neighbour')
  equal(reason(await fa.resolveAllowed('h1', out, tree)), 'denied', 'files: the grant does not confer its directory')
  equal(reason(await fa.resolveAllowed('h1', join(out, 'granted.txt'), { consumer: 'diff', operation: 'read-file' })), 'denied', 'files: cross-consumer grant refused')
  equal(reason(await fa.resolveAllowed('h2', join(out, 'granted.txt'), file)), 'denied', 'files: cross-session grant refused')
  equal(reason(await fa.resolveAllowed(null, join(out, 'granted.txt'), file)), 'denied', 'files: session grant is not app-level')
  ok(!(await fa.grant('h1', 'file', out)), 'files: a directory cannot be granted')
  ok(!(await fa.grant('h1', 'file', join(out, 'nope.txt'))), 'files: a missing file cannot be granted')
  ok(!(await fa.grant('h1', 'browser' as never, join(out, 'granted.txt'))), 'files: grant validates the consumer')
  ok(await fa.grant(null, 'editor', join(out, 'neighbour.txt')), 'files: configuration grant accepted')
  ok((await fa.resolveAllowed(null, join(out, 'neighbour.txt'), { consumer: 'editor', operation: 'open-external' })).ok, 'files: configuration open-external without a session')
  ok((await fa.resolveAllowed('h2', join(out, 'neighbour.txt'), { consumer: 'editor', operation: 'open-external' })).ok, 'files: configuration grant also applies inside a session')
  equal(reason(await fa.resolveAllowed(null, join(out, 'neighbour.txt'), file)), 'denied', 'files: configuration grant is consumer-bound')
  equal(reason(await fa.resolveAllowed(null, join(ws, 'a.txt'), file)), 'denied', 'files: no session means no workspace')
  ok((await fa.resolveAllowed('h1', join(ws, 'sub'), { consumer: 'editor', operation: 'open-external' })).ok, 'files: open-external on a workspace dir')
}

// Ledger paths: exact, current state, missing reported as missing
{
  ok((await fa.resolveAllowed('h1', join(out, 'ledger.txt'), { consumer: 'diff', operation: 'read-file' })).ok, 'files: a ledger path is readable (recorded via /tmp, resolved canonically)')
  equal(reason(await fa.resolveAllowed('h1', join(out, 'deleted.txt'), file)), 'missing', 'files: a deleted ledger file is missing, not denied')
  equal(reason(await fa.resolveAllowed('h1', join(out, 'gone.txt'), file)), 'denied', 'files: an unlisted outside missing file is denied, not missing')
  equal(reason(await fa.resolveAllowed('h2', join(out, 'ledger.txt'), file)), 'denied', 'files: ledger grants are per session')
  equal(reason(await fa.resolveAllowed('h1', out, tree)), 'denied', 'files: a ledger path confers no directory')
  equal(reason(await fa.resolveAllowed('h1', join(ws, 'gone.txt'), file)), 'missing', 'files: a missing workspace file is missing')
  // The decisions the openInEditor / openDiff handlers make.
  const editor = { consumer: 'editor', operation: 'open-external' } as const
  ok((await fa.resolveAllowed('h1', join(out, 'ledger.txt'), editor)).ok, 'files: Changed Files opens an outside ledger path in the editor')
  ok((await fa.resolveAllowed('h1', join(ws, 'sub', 'f.txt'), editor)).ok, 'files: the editor opens a workspace file')
  equal(reason(await fa.resolveAllowed('h1', join(out, 'secret.txt'), editor)), 'denied', 'files: the editor cannot open an arbitrary outside file')
  equal(reason(await fa.resolveAllowed(null, join(out, 'ledger.txt'), editor)), 'denied', 'files: a null handle reaches only Configuration grants')
  equal(reason(await fa.resolveAllowed('h1', join(out, 'deleted.txt'), editor)), 'missing', 'files: opening a deleted ledger file reports missing')
}

// Derived resources: opaque id, bound to session and consumer
{
  const id = await fa.registerDerived('h1', 'file', join(out, 'derived.txt'))
  ok(typeof id === 'string', 'files: derived registered')
  const d = await fa.resolveDerived('h1', id as string, file)
  ok(d.ok && (await readText(d)).ok, 'files: derived resource reads')
  equal(reason(await fa.resolveDerived('h2', id as string, file)), 'denied', 'files: derived id is session-bound')
  equal(reason(await fa.resolveDerived('h1', id as string, { consumer: 'diff', operation: 'read-file' })), 'denied', 'files: derived id is consumer-bound')
  equal(reason(await fa.resolveDerived('h1', 'forged', file)), 'denied', 'files: unknown derived id refused')
  equal(reason(await fa.resolveAllowed('h1', join(out, 'derived.txt'), file)), 'denied', 'files: a derived file is not reachable by path')
}

// Swaps between authorization and open
{
  writeFileSync(join(ws, 'swap.txt'), 'original\n')
  writeFileSync(join(ws, 'next.txt'), 'replacement\n')
  const r = await must(fa.resolveAllowed('h1', join(ws, 'swap.txt'), file))
  renameSync(join(ws, 'next.txt'), join(ws, 'swap.txt'))
  equal(reason(await readText(r)), 'changed', 'files: replacement between stat and open is refused')

  const f = await must(fa.resolveAllowed('h1', join(ws, 'a.txt'), file))
  renameSync(join(ws, 'a.txt'), join(ws, 'a.bak'))
  symlinkSync(join(ws, 'a.bak'), join(ws, 'a.txt'))
  equal(reason(await readText(f)), 'changed', 'files: final-component symlink swap is refused')
  unlinkSync(join(ws, 'a.txt'))
  renameSync(join(ws, 'a.bak'), join(ws, 'a.txt'))

  const s = await must(fa.resolveAllowed('h1', join(ws, 'sub', 'f.txt'), file))
  renameSync(join(ws, 'sub'), join(ws, 'sub.bak'))
  symlinkSync(join(ws, 'sub.bak'), join(ws, 'sub'))
  equal(reason(await readText(s)), 'changed', 'files: ancestor symlink swap to the same inode is refused (ELOOP)')
  unlinkSync(join(ws, 'sub'))
  symlinkSync(join(out, 'dir'), join(ws, 'sub'))
  equal(reason(await readText(s)), 'changed', 'files: ancestor swap to an outside dir is refused')
  unlinkSync(join(ws, 'sub'))
  renameSync(join(ws, 'sub.bak'), join(ws, 'sub'))

  const dir = await must(fa.resolveAllowed('h1', join(ws, 'sub'), tree))
  renameSync(join(ws, 'sub'), join(ws, 'sub.bak'))
  renameSync(join(ws, 'other'), join(ws, 'sub'))
  equal(reason(await listDir(dir)), 'changed', 'files: directory replaced after authorization is refused')
  renameSync(join(ws, 'sub'), join(ws, 'other'))
  symlinkSync(join(out, 'dir'), join(ws, 'sub'))
  equal(reason(await listDir(dir)), 'changed', 'files: directory swapped for a symlink is refused')
  unlinkSync(join(ws, 'sub'))
  renameSync(join(ws, 'sub.bak'), join(ws, 'sub'))
  ok((await listDir(dir)).ok, 'files: the original directory lists again once restored')

  const gone = await must(fa.resolveAllowed('h1', join(ws, 'swap.txt'), file))
  unlinkSync(join(ws, 'swap.txt'))
  equal(reason(await readText(gone)), 'missing', 'files: deleted after authorization is missing')
}

// FIFO, socket, device: refused, and nothing hangs
{
  execFileSync('mkfifo', [join(ws, 'fifo')])
  equal(reason(await within(fa.resolveAllowed('h1', join(ws, 'fifo'), file), 2000)), 'wrong-type', 'files: a FIFO is refused promptly')
  writeFileSync(join(ws, 'pipe.txt'), 'x')
  const r = await must(fa.resolveAllowed('h1', join(ws, 'pipe.txt'), file))
  unlinkSync(join(ws, 'pipe.txt'))
  execFileSync('mkfifo', [join(ws, 'pipe.txt')])
  equal(reason(await within(readText(r), 2000)), 'changed', 'files: a FIFO swapped in after authorization is refused without hanging')

  const server = createServer()
  await new Promise<void>((res) => server.listen(join(ws, 'sock'), res))
  equal(reason(await fa.resolveAllowed('h1', join(ws, 'sock'), file)), 'wrong-type', 'files: a socket is refused')
  await new Promise((res) => server.close(res))

  cwds.set('dev', '/dev')
  equal(reason(await within(fa.resolveAllowed('dev', '/dev/null', file), 2000)), 'wrong-type', 'files: a device is refused')
  equal(reason(await within(fa.resolveAllowed('dev', '/dev/zero', { consumer: 'editor', operation: 'open-external' }), 2000)), 'wrong-type', 'files: a device cannot be opened externally')
}

// readText limits, binary and encoding
{
  writeFileSync(join(ws, 'big.txt'), '€'.repeat(Math.ceil((TEXT_MAX + 1000) / 3)))
  const t = await readText(await must(fa.resolveAllowed('h1', join(ws, 'big.txt'), file)))
  ok(t.ok && t.truncated && !t.unsupportedEncoding && !t.binary && t.text.length === Math.floor(TEXT_MAX / 3), 'files: 5 MiB ceiling truncates on a character boundary')
  writeFileSync(join(ws, 'bin.dat'), Buffer.from([1, 2, 0, 3]))
  const b = await readText(await must(fa.resolveAllowed('h1', join(ws, 'bin.dat'), file)))
  ok(b.ok && b.binary && b.text === '', 'files: a NUL in the prefix is binary')
  writeFileSync(join(ws, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]))
  const l = await readText(await must(fa.resolveAllowed('h1', join(ws, 'latin1.txt'), file)))
  ok(l.ok && l.unsupportedEncoding && l.text === '', 'files: invalid UTF-8 is disclosed, not mangled')
  const e = await readText(await must(fa.resolveAllowed('h1', join(ws, 'a.txt'), file)))
  const e2 = await readText(await must(fa.resolveAllowed('h1', join(ws, 'a.txt'), file)))
  ok(e.ok && e2.ok && e.revision === e2.revision, 'files: the revision is stable for unchanged content')
  const st0 = await statFile(await must(fa.resolveAllowed('h1', join(ws, 'a.txt'), file)))
  await sleep(10)
  writeFileSync(join(ws, 'a.txt'), 'hello\n')
  utimesSync(join(ws, 'a.txt'), new Date(), new Date())
  const same = await readText(await must(fa.resolveAllowed('h1', join(ws, 'a.txt'), file)))
  const st1 = await statFile(await must(fa.resolveAllowed('h1', join(ws, 'a.txt'), file)))
  ok(e.ok && same.ok && e.revision === same.revision, 'files: an identical rewrite plus touch keeps the text revision')
  ok(st0.ok && st1.ok && st0.revision !== st1.revision, 'files: the metadata revision still moves on that touch')
  appendFileSync(join(ws, 'a.txt'), 'more\n')
  const e3 = await readText(await must(fa.resolveAllowed('h1', join(ws, 'a.txt'), file)))
  ok(e.ok && e3.ok && e.revision !== e3.revision, 'files: the revision changes with the content')
}

// readBytes: bounded ranges and revision aborts
{
  writeFileSync(join(ws, 'bytes.bin'), Buffer.from('0123456789'))
  const r = await must(fa.resolveAllowed('h1', join(ws, 'bytes.bin'), file))
  const st = await statFile(r)
  if (!st.ok) throw new Error('stat failed')
  const b = await readBytes(r, { revision: st.revision, offset: 2, length: 3 })
  ok(b.ok && b.bytes.toString() === '234' && b.size === 10, 'files: a range reads')
  const tail = await readBytes(r, { revision: st.revision, offset: 8, length: 100 })
  ok(tail.ok && tail.bytes.toString() === '89', 'files: a range past EOF clamps')
  for (const [bad, label] of [
    [{ revision: st.revision, offset: -1, length: 1 }, 'negative offset'],
    [{ revision: st.revision, offset: 1.5, length: 1 }, 'fractional offset'],
    [{ revision: st.revision, offset: 0, length: 0 }, 'zero length'],
    [{ revision: st.revision, offset: 0, length: CHUNK_MAX + 1 }, 'oversized chunk'],
    [{ revision: st.revision, offset: 11, length: 1 }, 'offset past EOF'],
    [{ revision: 5, offset: 0, length: 1 }, 'non-string revision'],
    [{ revision: st.revision, offset: '0', length: 1 }, 'string offset'],
    [null, 'no range']
  ] as const) {
    equal(reason(await readBytes(r, bad as never)), 'invalid', `files: readBytes rejects ${label}`)
  }
  appendFileSync(join(ws, 'bytes.bin'), 'x')
  equal(reason(await readBytes(r, { revision: st.revision, offset: 0, length: 1 })), 'changed', 'files: a changed revision aborts the range')
  const fd = openSync(join(ws, 'huge.bin'), 'w')
  ftruncateSync(fd, 201 * 1024 * 1024) // sparse
  closeSync(fd)
  const h = await must(fa.resolveAllowed('h1', join(ws, 'huge.bin'), file))
  const hs = await statFile(h)
  equal(reason(await readBytes(h, { revision: hs.ok ? hs.revision : '', offset: 0, length: 1 })), 'too-large', 'files: the 200 MiB ceiling holds')
  const ht = await readText(h)
  ok(ht.ok && ht.truncated && ht.binary, 'files: readText on a huge file stays bounded')
}

// Watches: debounced, re-armed on atomic replace, capped, cleaned up
{
  const wf = { consumer: 'file', operation: 'watch-file' } as const
  writeFileSync(join(ws, 'w.txt'), '1')
  let hits = 0
  const w = await fa.watch(await must(fa.resolveAllowed('h1', join(ws, 'w.txt'), wf)), () => hits++)
  ok(w.ok, 'files: watch armed')
  await sleep(50)
  for (let i = 0; i < 5; i++) appendFileSync(join(ws, 'w.txt'), String(i))
  await sleep(600)
  equal(hits, 1, 'files: a burst of writes is one debounced change')
  writeFileSync(join(ws, 'w.tmp'), 'replaced')
  renameSync(join(ws, 'w.tmp'), join(ws, 'w.txt'))
  await sleep(600)
  equal(hits, 2, 'files: an atomic replace is a change')
  appendFileSync(join(ws, 'w.txt'), 'after')
  await sleep(600)
  equal(hits, 3, 'files: the watch re-armed on the replacement file')
  if (w.ok) fa.unwatch(w.id)
  appendFileSync(join(ws, 'w.txt'), 'quiet')
  await sleep(400)
  equal(hits, 3, 'files: no change after unwatch')

  let dirHits = 0
  const wd = await fa.watch(await must(fa.resolveAllowed('h1', ws, { consumer: 'tree', operation: 'watch-directory' })), () => dirHits++)
  ok(wd.ok, 'files: directory watch armed')
  await sleep(50)
  writeFileSync(join(ws, 'new-child.txt'), 'x')
  await sleep(600)
  ok(dirHits >= 1, 'files: a new child fires the directory watch')

  equal(reason(await fa.watch(await must(fa.resolveAllowed('h1', join(ws, 'w.txt'), file)), () => {})), 'invalid', 'files: a read resource cannot be watched')
  const base = fds()
  const ids: string[] = []
  for (let i = 1; i < WATCH_MAX; i++) {
    const x = await fa.watch(await must(fa.resolveAllowed('h1', join(ws, 'w.txt'), wf)), () => {})
    if (x.ok) ids.push(x.id)
  }
  equal(ids.length, WATCH_MAX - 1, 'files: watches up to the cap (one directory watch already held)')
  equal(reason(await fa.watch(await must(fa.resolveAllowed('h1', join(ws, 'w.txt'), wf)), () => {})), 'limit', 'files: the 33rd watch is refused')
  ok((await fa.watch(await must(fa.resolveAllowed('h2', join(ws, 'w.txt'), wf)), () => {})).ok, 'files: the cap is per handle')
  fa.dispose('h1')
  fa.dispose('h2')
  appendFileSync(join(ws, 'w.txt'), 'disposed')
  await sleep(400)
  ok(fds() <= base, 'files: dispose closes every watcher descriptor')
  equal(reason(await fa.resolveAllowed('h1', join(out, 'granted.txt'), file)), 'denied', 'files: dispose drops the session grants')
  ok((await fa.watch(await must(fa.resolveAllowed('h1', join(ws, 'w.txt'), wf)), () => {})).ok, 'files: slots are free after dispose')
  fa.dispose('h1')
}

await sleep(200)
equal(fds(), fdsBefore, 'files: no descriptor leaked across every success and refusal path')
rmSync(fx, { recursive: true, force: true })
