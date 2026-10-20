// Boundary: Claude changes diffs from the ledger, change marks, the editor's frozen snapshot pair, and
// the highlight helpers the File and Diff surfaces share.
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChangeLedger } from '../src/main/surfaces/ledger.ts'
import { changeMarks, diffSnapshots, getDiff, parseChangeRefRequest, parseDiffRequest, selectChange, type DiffSource } from '../src/main/surfaces/diff.ts'
import { ChangeRefs } from '../src/main/surfaces/change-refs.ts'
import { changeSelection, type PatchHunk } from '../src/shared/changes.ts'
import { markHtml, splitHighlightedLines } from '../src/renderer/src/lib/highlightLines.ts'
import { langForPath } from '../src/renderer/src/lib/highlight.ts'
import { equal, ok } from './support/harness.mjs'

const use = (id: string, name: string, input: object) => ({
  type: 'assistant',
  session_id: 'sid',
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }
})
const res = (id: string, result: unknown) => ({
  type: 'user',
  session_id: 'sid',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
  tool_use_result: result
})
const hunk = (oldStart: number, oldLines: number, newLines: number, ls: string[]) => ({ oldStart, oldLines, newStart: oldStart, newLines, lines: ls })
const edit = (id: string, path: string, originalFile: string | null, patch: object[]) => [
  use(id, 'Edit', { file_path: path, old_string: 'x', new_string: 'y' }),
  res(id, { filePath: path, originalFile, structuredPatch: patch, userModified: false })
]

function ledgerWith(envs: unknown[]): ChangeLedger {
  const l = new ChangeLedger(() => {})
  l.attach('h', 'h')
  for (const e of envs) l.wire('h', e)
  return l
}
const source = (l: ChangeLedger, disk: string | null = null): DiffSource => ({
  segments: (h, p) => l.segments(h, p),
  current: async () => (disk === null ? null : { text: disk, revision: `rev:${disk.length}` })
})

// splitHighlightedLines
{
  const html = '<span class="c">/* a\nb */</span> x\n<span class="k">if</span>'
  const out = splitHighlightedLines(html)
  equal(out.length, 3, 'split: one string per source line')
  equal(out[0], '<span class="c">/* a</span>', 'split: a span open at a break is closed')
  equal(out[1], '<span class="c">b */</span> x', 'split: and reopened on the next line')
  equal(out[2], '<span class="k">if</span>', 'split: the last line')
  const nested = splitHighlightedLines('<span class="a"><span class="b">x\ny</span>z</span>\n')
  ok(nested[0] === '<span class="a"><span class="b">x</span></span>' && nested[1] === '<span class="a"><span class="b">y</span>z</span>' && nested[2] === '', 'split: nested spans and a final newline')
  equal(splitHighlightedLines('a &lt; b').join('|'), 'a &lt; b', 'split: plain text passes through')
}

// markHtml and langForPath
{
  equal(markHtml('ab<span class="k">cd</span>e', [[1, 4]], 0, 'm', 'A'), 'a<mark class="A">b</mark><span class="k"><mark class="A">cd</mark></span>e', 'mark: a match across a tag closes and reopens around it')
  equal(markHtml('a &lt; b', [[2, 3]], -1, 'm', 'A'), 'a <mark class="m">&lt;</mark> b', 'mark: an entity counts as one character')
  equal(markHtml('xyxy', [[0, 2], [2, 4]], 1, 'm', 'A'), '<mark class="m">xy</mark><mark class="A">xy</mark>', 'mark: only the active match takes the active class')
  ok(langForPath('/a/b.tsx') === 'tsx' && langForPath('/a/x.h') === 'h' && langForPath('/a/Makefile') === null && langForPath('/a/.env') === null, 'langForPath: aliases, mapped extensions and none')
}

// A continuous run of edits is one full segment: one jsdiff group over its first before → last after.
{
  const l = ledgerWith([
    ...edit('e1', '/f.ts', 'a\nb\nc\n', [hunk(1, 3, 3, [' a', '-b', '+B', ' c'])]),
    ...edit('e2', '/f.ts', 'a\nB\nc\n', [hunk(1, 3, 3, [' a', ' B', '-c', '+C'])])
  ])
  const d = (await getDiff(source(l, 'a\nB\nC\n'), 'h', { path: '/f.ts' }))!
  const s = d.segments[0]
  ok(d.segments.length === 1 && s.mode === 'full' && s.groups.length === 1 && s.snapshot && !s.outsideBefore, 'diff: one full segment')
  equal(s.groups[0].map((h) => h.lines.join('|')).join(), ' a|-b|-c|+B|+C', 'diff: the net hunk with context')
  ok(s.groups[0].every((h) => h.segmentId === s.id && h.revision === s.revision && h.id.length === 32), 'diff: hunks carry their segment identity')
  ok(!d.changedSince && !d.truncated, 'diff: disk equal to Claude last version')
  const again = (await getDiff(source(l), 'h', { path: '/f.ts' }))!
  equal(again.segments[0].groups[0][0].id, s.groups[0][0].id, 'diff: a hunk id is stable across reads')
  for (const e of edit('e3', '/f.ts', 'a\nB\nC\n', [hunk(1, 3, 4, [' a', ' B', ' C', '+D'])])) l.wire('h', e)
  const grown = (await getDiff(source(l), 'h', { path: '/f.ts' }))!
  ok(grown.segments[0].revision !== s.revision && grown.segments[0].groups[0][0].id !== s.groups[0][0].id, 'diff: extending a segment mints a new revision and hunk ids')
  equal(s.groups[0][0].lines.join('|'), ' a|-b|-c|+B|+C', 'diff: an earlier read is untouched by the extension')
}

// An outside change between Claude's edits starts a second segment, marked as such; disk drift is reported.
{
  const l = ledgerWith([
    ...edit('e1', '/g.ts', 'a\nb\n', [hunk(1, 2, 2, [' a', '-b', '+B'])]),
    ...edit('e2', '/g.ts', 'a\nB\nuser\n', [hunk(1, 3, 4, [' a', ' B', ' user', '+claude'])])
  ])
  const d = (await getDiff(source(l, 'a\nB\nuser\nclaude\nlater\n'), 'h', { path: '/g.ts' }))!
  ok(d.segments.length === 2 && !d.segments[0].outsideBefore && d.segments[1].outsideBefore, 'diff: the second segment follows an outside change')
  ok(!d.segments[1].groups[0].some((h) => h.lines.some((x) => x === '+user')), "diff: the outside change never shows as Claude's")
  ok(d.changedSince, 'diff: disk past the last segment is reported')
}

// A replayed big edit has its patch only, and a subagent edit has nothing recorded.
{
  const l = ledgerWith([
    ...edit('p1', '/big.ts', null, [hunk(10, 1, 1, ['-x', '+y'])]),
    ...edit('p2', '/big.ts', null, [hunk(20, 1, 1, ['-m', '+n'])]),
    use('s1', 'Edit', { file_path: '/sub.ts', old_string: 'a', new_string: 'b' }),
    res('s1', undefined)
  ])
  const d = (await getDiff(source(l), 'h', { path: '/big.ts' }))!
  ok(d.segments.every((s) => s.mode === 'patch' && !s.snapshot) && d.segments.flatMap((s) => s.groups).length === 2, 'diff: patch-only edits show their own hunks')
  equal(d.segments[1].groups[0][0].oldStart, 20, "diff: a patch keeps its edit's coordinates")
  const sub = (await getDiff(source(l), 'h', { path: '/sub.ts' }))!
  ok(sub.segments[0].mode === 'none' && !sub.segments[0].groups.length, 'diff: nothing recorded is mode none')
  equal(await getDiff(source(l), 'h', { path: '/elsewhere.ts' }), null, "diff: a path the ledger doesn't hold is null")
  equal(await getDiff(source(l), 'other', { path: '/big.ts' }), null, "diff: another handle can't read it")
  const s = (await l.changes('h'))!.find((c) => c.path === '/big.ts')!
  ok(s.diffAvailable, 'ledger: patch-only history still has a diff')
}

// Edits that cancel out leave an empty full group.
{
  const l = ledgerWith([
    ...edit('r1', '/r.ts', 'a\nb\n', [hunk(1, 2, 2, [' a', '-b', '+B'])]),
    ...edit('r2', '/r.ts', 'a\nB\n', [hunk(1, 2, 2, [' a', '-B', '+b'])])
  ])
  const d = (await getDiff(source(l), 'h', { path: '/r.ts' }))!
  ok(d.segments[0].mode === 'full' && d.segments[0].groups[0].length === 0, 'diff: a revert has no hunks')
}

// Requests are validated before they reach the ledger.
{
  equal(parseDiffRequest({ path: '/a' })?.path, '/a', 'request: a path')
  equal(parseDiffRequest({ path: '/a', segmentId: 's' })?.segmentId, 's', 'request: a segment')
  ok(parseDiffRequest(null) === null && parseDiffRequest({ path: 3 }) === null && parseDiffRequest({ path: '/a', segmentId: 7 }) === null, 'request: malformed is refused')
}

// The editor gets the segment's own before and after, frozen read-only, registered with the guard.
{
  const root = join(mkdtempSync(join(tmpdir(), 'clui-diff-')), 'snapshots')
  const l = ledgerWith([
    ...edit('o1', '/w/o.ts', 'one\n', [hunk(1, 1, 1, ['-one', '+two'])]),
    ...edit('o2', '/w/p.ts', null, [hunk(1, 1, 1, ['-x', '+y'])])
  ])
  const registered: string[] = []
  const snaps = diffSnapshots(root, source(l), async (_h, p) => (registered.push(p), `id:${p}`))
  let launched: string[] = []
  const r = await snaps.open('h', { path: '/w/o.ts' }, 'code', async (a, b) => void (launched = [a, b]))
  ok(r.ok && launched.length === 2 && launched.every((p) => p.startsWith(root) && p.endsWith('/o.ts')), 'snapshots: the pair is under root and keeps the basename')
  ok(readFileSync(launched[0], 'utf8') === 'one\n' && readFileSync(launched[1], 'utf8') === 'two\n', 'snapshots: before and after are the ledger texts')
  equal(statSync(launched[0]).mode & 0o222, 0, 'snapshots: read-only')
  equal(registered.join(), launched.join(), 'snapshots: both registered as derived resources')
  await snaps.open('h', { path: '/w/o.ts' }, 'code', async () => {})
  equal(registered.length, 2, 'snapshots: a repeat open reuses the registered pair')
  const failed = await snaps.open('h', { path: '/w/o.ts' }, 'zed', async () => {
    throw new Error('nope')
  })
  ok(!failed.ok && failed.message.includes('"zed" with --diff'), 'snapshots: an editor failure names the command')
  const partial = await snaps.open('h', { path: '/w/p.ts' }, 'code', async () => {})
  ok(!partial.ok && partial.message.startsWith("Couldn't open the diff for p.ts."), 'snapshots: patch-only history has no pair to open')
  snaps.clear()
  ok(!existsSync(root), 'snapshots: clear removes the folder')
}

// Change markers: Claude's lines projected onto the current text, never onto someone else's.
{
  const base = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n') + '\n'
  const one = base.replace('l3\n', 'C3\n')
  const two = one.replace('l15\nl16\n', 'l15\nC15b\nl16\n').replace('l18\n', '')
  const l = ledgerWith([
    ...edit('m1', '/m.ts', base, [hunk(3, 1, 1, ['-l3', '+C3'])]),
    ...edit('m2', '/m.ts', one, [hunk(15, 4, 4, [' l15', '+C15b', ' l16', ' l17', '-l18'])])
  ])
  const direct = (await changeMarks(source(l, two), 'h', '/m.ts'))!
  equal(direct.state, 'marked', 'marks: disk equal to the ledger maps directly')
  equal(JSON.stringify(direct.hunks.map((h) => [h.bars, h.wedge ?? null])), JSON.stringify([[[[3, 3]], null], [[[16, 16]], { line: 19, count: 1 }]]), 'marks: bars on changed lines, a wedge where a line was removed')
  const d = (await getDiff(source(l, two), 'h', { path: '/m.ts' }))!
  equal(direct.hunks.map((h) => h.id).join(), d.segments[0].groups[0].map((h) => h.id).join(), 'marks: hunk ids are the Claude changes tab ids')

  const shifted = (await changeMarks(source(l, 'user top\n' + two.replace('C15b\n', 'user rewrote it\n')), 'h', '/m.ts'))!
  equal(JSON.stringify(shifted.hunks.map((h) => [h.bars, h.wedge?.line])), JSON.stringify([[[[4, 4]], null], [[], 20]]), "marks: a user edit shifts Claude's lines and drops the one the user rewrote")
  const shiftedText = 'user top\n' + two.replace('C15b\n', 'user rewrote it\n')
  const placed = (await getDiff(source(l, shiftedText), 'h', { path: '/m.ts' }))!.segments[0].groups[0].map((h) => h.current ?? null)
  equal(JSON.stringify(placed), JSON.stringify([{ start: 4, end: 4 }, null]), 'diff: a hunk is placed in the file while its added lines survive, and stale once one is rewritten')
  equal(JSON.stringify(d.segments[0].groups[0].map((h) => h.current)), JSON.stringify([{ start: 3, end: 3 }, { start: 16, end: 16 }]), 'diff: unchanged disk places every hunk')
  const many = ledgerWith(
    Array.from({ length: 17 }, (_, k) => edit(`k${k}`, '/k.ts', `${'x\n'.repeat(k)}v${k}\n`, [hunk(k + 1, 1, 1, [`-v${k}`, `+w${k}`])])).flat()
  )
  equal((await changeMarks(source(many, 'w\n'), 'h', '/k.ts'))?.state, 'unavailable', 'marks: past 16 segments nothing is attributed')
  ok(shifted.revision === `rev:${('user top\n' + two.replace('C15b\n', 'user rewrote it\n')).length}`, 'marks: tagged with the revision they were projected onto')

  const seg = ledgerWith([
    ...edit('s1', '/s.ts', 'a\nb\nc\n', [hunk(2, 1, 1, ['-b', '+B'])]),
    ...edit('s2', '/s.ts', 'top\na\nB\nc\n', [hunk(4, 1, 1, ['-c', '+C'])])
  ])
  const across = (await changeMarks(source(seg, 'top\na\nB\nC\n'), 'h', '/s.ts'))!
  equal(JSON.stringify(across.hunks.map((h) => h.bars)), JSON.stringify([[[3, 3]], [[4, 4]]]), 'marks: an earlier segment projects through the outside change')

  const patchOnly = ledgerWith(edit('p1', '/p.ts', null, [hunk(1, 1, 1, ['-x', '+y'])]))
  equal((await changeMarks(source(patchOnly, 'y\n'), 'h', '/p.ts'))?.state, 'unavailable', 'marks: patch-only history marks nothing')

  const made = ledgerWith([use('w1', 'Write', { file_path: '/n.ts', content: 'a\nb\n' }), res('w1', { type: 'create', filePath: '/n.ts', content: 'a\nb\n' })])
  const created = (await changeMarks(source(made, 'a\nb\n'), 'h', '/n.ts'))!
  ok(created.state === 'created' && created.hunks.length === 1 && !created.hunks[0].bars.length, 'marks: an untouched created file is one chip, no bars')
  equal(await changeMarks(source(made, null), 'h', '/n.ts'), null, 'marks: an unreadable file has none')
}

// changeSelection: the text one side of a hunk slice reads as, numbered as the Diff surface numbers its rows.
{
  const h: PatchHunk = { oldStart: 3, oldLines: 3, newStart: 3, newLines: 3, lines: [' a', '-b', '+B', ' c', '\\ No newline at end of file'] }
  const sel = (side: 'diff' | 'before' | 'after', rows?: { start: number; end: number }): string => JSON.stringify(changeSelection(h, side, rows))
  equal(sel('diff'), JSON.stringify({ ok: true, text: h.lines.join('\n'), old: { start: 3, end: 5 }, new: { start: 3, end: 5 }, lines: 5, bytes: h.lines.join('\n').length }), 'select: diff keeps every row verbatim, no-newline row included')
  equal(sel('before'), JSON.stringify({ ok: true, text: 'a\nb\nc', old: { start: 3, end: 5 }, new: { start: 3, end: 5 }, lines: 3, bytes: 5 }), 'select: before keeps context and removed rows, stripped')
  equal(sel('after'), JSON.stringify({ ok: true, text: 'a\nB\nc', old: { start: 3, end: 5 }, new: { start: 3, end: 5 }, lines: 3, bytes: 5 }), 'select: after keeps context and added rows')
  equal(sel('before', { start: 2, end: 2 }), JSON.stringify({ ok: true, text: 'b', old: { start: 4, end: 4 }, lines: 1, bytes: 1 }), 'select: a removed row has no after-side lines')
  equal(sel('after', { start: 2, end: 3 }), JSON.stringify({ ok: true, text: 'B', old: { start: 4, end: 4 }, new: { start: 4, end: 4 }, lines: 1, bytes: 1 }), 'select: rows numbered by their own side')
  equal(sel('before', { start: 3, end: 3 }), JSON.stringify({ ok: false, reason: 'empty', lines: 0, bytes: 0 }), 'select: no row of the side in range is empty')
  equal(JSON.parse(sel('diff', { start: 5, end: 5 })).reason, 'empty', 'select: a no-newline row alone is empty')
  ok([{ start: 0, end: 1 }, { start: 4, end: 6 }, { start: 3, end: 2 }, { start: 1.5, end: 2 }].every((r) => JSON.parse(sel('diff', r)).reason === 'empty'), 'select: rows outside the hunk or reversed are empty')
  const tall = (n: number): PatchHunk => ({ oldStart: 1, oldLines: 0, newStart: 1, newLines: n, lines: Array.from({ length: n }, () => '+x') })
  ok(changeSelection(tall(400), 'after').ok, 'select: 400 lines fit')
  equal(JSON.stringify(changeSelection(tall(401), 'after')), JSON.stringify({ ok: false, reason: 'too-large', lines: 401, bytes: 801, new: { start: 1, end: 401 } }), 'select: 401 lines are too large, measured, and still numbered')
  const wide = (s: string): PatchHunk => ({ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: [`+${s}`] })
  ok(changeSelection(wide('€'.repeat(10922) + 'aa'), 'after').ok, 'select: 32,768 UTF-8 bytes fit')
  const over = changeSelection(wide('€'.repeat(10923)), 'after')
  ok(!over.ok && over.reason === 'too-large' && over.bytes === 32769 && over.lines === 1, 'select: 32,769 bytes of multi-byte text are too large')
}

// selectChange: mint finds the hunk ids getDiff shows, from ledger memory only.
{
  const base = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n') + '\n'
  const one = base.replace('l3\n', 'C3\n')
  const envs = [...edit('m1', '/m.ts', base, [hunk(3, 1, 1, ['-l3', '+C3'])])]
  const l = ledgerWith(envs)
  let currents = 0
  const src: DiffSource = { segments: (h, p) => l.segments(h, p), current: async () => (currents++, null) }
  const diff = (await getDiff(source(l, one), 'h', { path: '/m.ts' }))!
  const [seg] = diff.segments
  const req = (h: { id: string }, over: Record<string, unknown> = {}): any => ({ path: '/m.ts', segmentId: seg.id, revision: seg.revision, hunkId: h.id, side: 'before', ...over })
  ok(seg.mode === 'full', 'mint: a full-mode fixture')
  const whole = await selectChange(src, 'h', req(seg.groups[0][0]))
  ok(whole.ok && whole.sel.text === 'l1\nl2\nl3\nl4\nl5\nl6' && JSON.stringify(whole.sel.old) === '{"start":1,"end":6}', 'mint: the full-mode hunk id getDiff shows is found')
  const r = await selectChange(src, 'h', req(seg.groups[0][0], { rows: { start: 3, end: 3 } }))
  ok(r.ok && r.sel.text === 'l3' && JSON.stringify(r.sel.old) === '{"start":3,"end":3}' && r.sel.new === undefined, 'mint: one removed row')
  equal((await selectChange(src, 'h', req(seg.groups[0][0], { revision: 'f'.repeat(32) }))).ok ? '' : 'changed', 'changed', 'mint: a stale revision is changed')
  equal((await selectChange(src, 'h', req({ id: 'f'.repeat(32) }))) .ok, false, 'mint: an unknown hunk is changed')
  equal((await selectChange(src, 'h', req(seg.groups[0][0], { segmentId: 'e'.repeat(32) }))).ok, false, 'mint: an unknown segment is changed')
  const rows = await selectChange(src, 'h', req(seg.groups[0][0], { side: 'after', rows: { start: 3, end: 3 } }))
  ok(!rows.ok && rows.reason === 'empty', 'mint: a removed row read as after is empty')

  const patchOnly = ledgerWith(edit('p1', '/p.ts', null, [hunk(1, 1, 1, ['-x', '+y'])]))
  const pd = (await getDiff(source(patchOnly), 'h', { path: '/p.ts' }))!
  const ps = pd.segments[0]
  const pr = await selectChange({ segments: (h, p) => patchOnly.segments(h, p) }, 'h', { path: '/p.ts', segmentId: ps.id, revision: ps.revision, hunkId: ps.groups[0][0].id, side: 'diff' })
  ok(ps.mode === 'patch' && pr.ok && pr.sel.text === '-x\n+y', 'mint: the patch-mode hunk id getDiff shows is found')

  // A ref minted before the segment extends still reads the bytes the user saw.
  const refs = new ChangeRefs()
  refs.track('h', { quick: false, sessionId: 'S' })
  const before = r.ok ? r.sel : null
  const ref = refs.mint('h', { path: '/m.ts', label: 'm.ts', segmentId: seg.id, revision: seg.revision, hunkId: seg.groups[0][0].id, side: 'before', rows: { start: 3, end: 3 }, old: before!.old, text: before!.text, bytes: before!.bytes })!
  refs.activate('h', 'p', [ref])
  for (const e of edit('m2', '/m.ts', one, [hunk(15, 1, 1, ['-l15', '+C15'])])) l.wire('h', e)
  const grown = (await l.segments('h', '/m.ts'))!
  ok(grown.length === 1 && grown[0].revision !== seg.revision, 'mint: the segment extended in place')
  equal((await selectChange(src, 'h', req(seg.groups[0][0]))).ok, false, 'mint: the old revision no longer mints')
  equal(refs.resolve('h', ref)?.text, 'l3', 'mint: the earlier ref resolves byte-identical')
  equal(currents, 0, "mint: the current file is never read")
}

// parseChangeRefRequest: every field shape-checked before use.
{
  const hex = 'a'.repeat(32)
  const good = { path: '/w/a.ts', segmentId: hex, revision: hex, hunkId: hex, side: 'diff' }
  ok(!!parseChangeRefRequest(good) && JSON.stringify(parseChangeRefRequest({ ...good, rows: { start: 2, end: 3 }, extra: 1 })) === JSON.stringify({ ...good, rows: { start: 2, end: 3 } }), 'parse: the request, unknown keys dropped')
  const bad = [
    { ...good, path: 'a.ts' },
    { ...good, path: '/a\0b' },
    { ...good, path: '/' + 'a'.repeat(4096) },
    { ...good, hunkId: 'A'.repeat(32) },
    { ...good, revision: 'a'.repeat(31) },
    { ...good, side: 'both' },
    { ...good, rows: { start: 0, end: 1 } },
    { ...good, rows: { start: 3, end: 2 } },
    { ...good, rows: { start: 1, end: 100_001 } },
    { ...good, rows: [1, 2] },
    null
  ]
  ok(bad.every((b) => parseChangeRefRequest(b) === null), 'parse: a bad path, id, side or row range is refused')
}
