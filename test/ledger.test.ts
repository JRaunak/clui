// Boundary: the Claude change ledger. Wire fixtures are trimmed from CLI 2.1.296 captures;
// the synthetic envelopes below follow the same shapes.
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChangeLedger, applyPatch, lineCount, patchCounts } from '../src/main/surfaces/ledger.ts'
import { equal, ok } from './support/harness.mjs'

const fixture = (name: string): string => new URL(`./fixtures/ledger/${name}`, import.meta.url).pathname
const lines = (name: string): unknown[] =>
  readFileSync(fixture(name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

const use = (id: string, name: string, input: object, ptu?: string) => ({
  type: 'assistant',
  session_id: 'sid',
  parent_tool_use_id: ptu,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }
})
const res = (id: string, result: unknown, extra: object = {}, ptu?: string) => ({
  type: 'user',
  session_id: 'sid',
  parent_tool_use_id: ptu,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...extra }] },
  tool_use_result: result
})
const hunk = (oldStart: number, oldLines: number, newLines: number, ls: string[]) => ({ oldStart, oldLines, newStart: oldStart, newLines, lines: ls })
const edit = (id: string, path: string, originalFile: string | null, patch: object[], extra: object = {}) => [
  use(id, 'Edit', { file_path: path, old_string: 'x', new_string: 'y' }),
  res(id, { filePath: path, originalFile, structuredPatch: patch, userModified: false, ...extra })
]

function ledgerWith(envs: unknown[], handle = 'h'): ChangeLedger {
  const l = new ChangeLedger(() => {})
  l.attach(handle, handle)
  for (const e of envs) l.wire(handle, e)
  return l
}
const one = async (l: ChangeLedger, handle = 'h') => (await l.changes(handle))![0]

// applyPatch
{
  equal(applyPatch('a\nb\nc\n', [hunk(1, 3, 3, [' a', '-b', '+B', ' c'])]), 'a\nB\nc\n', 'applyPatch: a replaced line')
  equal(
    applyPatch('a\nb', [hunk(1, 2, 2, [' a', '-b', '\\ No newline at end of file', '+c', '\\ No newline at end of file'])]),
    'a\nc',
    'applyPatch: no newline at EOF on both sides'
  )
  equal(applyPatch('a\nb', [hunk(1, 2, 2, [' a', '-b', '\\ No newline at end of file', '+b'])]), 'a\nb\n', 'applyPatch: adds the final newline')
  equal(applyPatch('a\nzzz\n', [hunk(1, 2, 2, [' a', '-b', '+B'])]), null, 'applyPatch: a mismatched patch is null')
  equal(lineCount(''), 0, 'lineCount: empty')
  equal(lineCount('x\ny'), 2, 'lineCount: no final newline')
  equal(lineCount('x\ny\n'), 2, 'lineCount: final newline')
  const pc = patchCounts([hunk(1, 2, 2, [' a', '-b', '\\ No newline at end of file', '+c', '+d'])])
  ok(pc.added === 2 && pc.removed === 1, 'patchCounts: the no-newline marker is not a line')
}

// A single verified edit counts its patch exactly.
{
  const s = await one(ledgerWith(edit('e1', '/f.txt', 'a\nb\nc\n', [hunk(1, 3, 3, [' a', '-b', '+B', ' c'])])))
  ok(s.added === 1 && s.removed === 1 && !s.approximate && s.segments === 1 && s.diffAvailable, 'ledger: a single edit counts +1 −1 exactly')
}

// A text mismatch between edits (someone else changed the file) opens a new segment, and the
// outside change never counts.
{
  const l = ledgerWith([
    ...edit('e1', '/f.txt', 'a\nb\n', [hunk(1, 2, 2, [' a', '-b', '+B'])]),
    ...edit('e2', '/f.txt', 'a\nB\nuser line\n', [hunk(1, 3, 4, [' a', ' B', ' user line', '+claude'])])
  ])
  const s = await one(l)
  ok(s.segments === 2 && s.added === 2 && s.removed === 1 && !s.approximate, 'ledger: mismatch breaks the segment; counts stay exact and Claude-only')
}

// A Claude edit that reverts an earlier Claude edit nets to zero.
{
  const l = ledgerWith([
    ...edit('e1', '/f.txt', 'a\nb\n', [hunk(1, 2, 2, [' a', '-b', '+B'])]),
    ...edit('e2', '/f.txt', 'a\nB\n', [hunk(1, 2, 2, [' a', '-B', '+b'])])
  ])
  const s = await one(l)
  ok(s.segments === 1 && s.added === 0 && s.removed === 0 && !s.approximate, 'ledger: a revert nets to +0 −0')
  equal(s.editIds.join(), 'e1,e2', 'ledger: the segment keeps both edits in order')
}

// A verified create counts its content, and later edits net against the empty start.
{
  const created = [use('w1', 'Write', { file_path: '/n.txt', content: 'x\ny\nz\n' }), res('w1', { type: 'create', filePath: '/n.txt', content: 'x\ny\nz\n', structuredPatch: [], originalFile: null })]
  const s = await one(ledgerWith(created))
  ok(s.created && s.added === 3 && s.removed === 0 && !s.approximate, 'ledger: a create counts new +3')
  const s2 = await one(ledgerWith([...created, ...edit('e2', '/n.txt', 'x\ny\nz\n', [hunk(1, 3, 2, [' x', '-y', ' z'])])]))
  ok(s2.created && s2.added === 2 && s2.removed === 0 && !s2.approximate, 'ledger: a create then a removal nets +2 −0')
}

// A patch that doesn't apply to its own originalFile is opaque: approximate, from patch lines.
{
  const l = ledgerWith([...edit('e1', '/f.txt', 'q\n', [hunk(1, 2, 2, [' a', '-b', '+B'])]), ...edit('e2', '/f.txt', 'q\n', [hunk(1, 1, 1, ['-q', '+r'])])])
  const s = await one(l)
  ok(s.approximate && s.added === 2 && s.removed === 2 && s.diffAvailable, 'ledger: an opaque edit is approximate and breaks continuity; its own hunks still show')
}

// Re-keying: a handle buffers under itself until init names the session.
{
  const l = new ChangeLedger(() => {})
  l.attach('h', 'h')
  for (const e of edit('e1', '/f.txt', 'a\n', [hunk(1, 1, 1, ['-a', '+b'])])) l.wire('h', e)
  l.rekey('h', 'sid-1')
  for (const e of edit('e2', '/f.txt', 'b\n', [hunk(1, 1, 1, ['-b', '+c'])])) l.wire('h', e)
  const s = await one(l)
  ok(s.segments === 1 && s.editIds.length === 2 && s.added === 1 && s.removed === 1, 'ledger: re-keying keeps the buffered edits in one history')
  l.attach('h2', 'sid-1')
  equal((await l.changes('h2'))?.length, 1, 'ledger: a second handle on the session sees the same history')
  l.detach('h')
  l.detach('h2')
  equal(await l.changes('h'), null, 'ledger: a detached handle has no changes')
}

// The same envelopes twice (a forwarded duplicate) count once.
{
  const envs = edit('e1', '/f.txt', 'a\n', [hunk(1, 1, 1, ['-a', '+b'])])
  const s = await one(ledgerWith([...envs, ...envs]))
  ok(s.editIds.length === 1 && s.added === 1, 'ledger: a duplicate result is ingested once')
}

// Rejected or failed tools add no row.
{
  const l = ledgerWith([
    use('r1', 'Edit', { file_path: '/r.txt', old_string: 'a', new_string: 'b' }),
    res('r1', 'User rejected tool use', { is_error: true }),
    use('r2', 'Write', { file_path: '/r2.txt', content: 'x' }),
    res('r2', 'User rejected tool use'),
    use('r3', 'Edit', { file_path: '/r3.txt', old_string: 'a', new_string: 'b' }),
    res('r3', undefined, { is_error: true })
  ])
  equal((await l.changes('h'))?.length, 0, 'ledger: a rejected, interrupted or failed edit adds no row')
}

// A subagent's edit carries no result: the row counts from its input, approximate, or unknown.
{
  const l = ledgerWith([
    use('s1', 'Edit', { file_path: '/s.txt', old_string: 'a', new_string: 'b\nc' }, 'toolu_agent'),
    res('s1', undefined, {}, 'toolu_agent'),
    use('s2', 'Write', { file_path: '/w.txt', content: 'x\n' }, 'toolu_agent'),
    res('s2', undefined, {}, 'toolu_agent')
  ])
  const [w, s] = (await l.changes('h'))!
  ok(s.path === '/s.txt' && s.approximate && s.added === 2 && s.removed === 1, 'ledger: a subagent Edit is an approximate +2 −1 from its input')
  ok(w.path === '/w.txt' && w.added === null && w.removed === null && !w.approximate && !w.created, 'ledger: a subagent Write is a row with unknown counts')
}

// Eviction drops old texts but keeps counts, and the open segment keeps its continuity text.
{
  const l = new ChangeLedger(() => {}, 20)
  l.attach('h', 'h')
  const envs = [
    ...edit('e1', '/f.txt', 'a\nb\n', [hunk(1, 2, 2, [' a', '-b', '+B'])]),
    ...edit('e2', '/f.txt', 'other\n', [hunk(1, 1, 1, ['-other', '+x'])]),
    ...edit('e3', '/f.txt', 'x\n', [hunk(1, 1, 1, ['-x', '+y'])])
  ]
  for (const e of envs) l.wire('h', e)
  const s = await one(l)
  ok(!s.diffAvailable && s.segments === 2 && s.added === 2 && s.removed === 2 && !s.approximate, 'ledger: eviction keeps counts and continuity')
}

// Replay (main + subagent transcripts) equals live ingest of the same session.
const home = mkdtempSync(join(tmpdir(), 'clui-ledger-test-'))
process.env.CLAUDE_CONFIG_DIR = home
const project = join(home, 'projects', '-private-tmp-clui-scratch-s0')
mkdirSync(project, { recursive: true })

async function replayed(sid: string): Promise<unknown> {
  const l = new ChangeLedger(() => {})
  l.attach('r', sid)
  await l.replay('r', sid)
  return l.changes('r')
}
const live = (stream: string): Promise<unknown> => ledgerWith(lines(stream), 'live').changes('live')

{
  copyFileSync(fixture('s0-6.session.jsonl'), join(project, 's06.jsonl'))
  const [a, b] = [await live('s0-6.stream.jsonl'), await replayed('s06')]
  equal(JSON.stringify(b), JSON.stringify(a), 'ledger: S0-6 replay equals live ingest')
  const rows = a as { path: string; added: number; removed: number; approximate: boolean; segments: number }[]
  const nb = rows.find((r) => r.path.endsWith('nb.ipynb'))
  const small = rows.find((r) => r.path.endsWith('small.txt'))
  ok(!!small && small.added === 1 && small.removed === 1 && !small.approximate, 'ledger: S0-6 Edit counts +1 −1')
  ok(!!nb && nb.segments === 1 && nb.approximate && nb.added === 2 && nb.removed === 2, 'ledger: S0-6 notebook edits count cell lines, approximate')
}
{
  // A 2.1.300+ transcript ends a turn with api-request-blob copies of its tool blocks.
  const recs = lines('s0-6.session.jsonl') as { type: string; message: { content: unknown } }[]
  const blocks = (type: string) => recs.filter((r) => r.type === type).flatMap((r) => r.message.content as unknown[])
  const blob = (role: string) => JSON.stringify({ type: 'api-request-blob', sessionId: 's06b', hash: role, message: { role, content: blocks(role) } })
  writeFileSync(join(project, 's06b.jsonl'), readFileSync(fixture('s0-6.session.jsonl'), 'utf8') + blob('assistant') + '\n' + blob('user') + '\n')
  equal(JSON.stringify(await replayed('s06b')), JSON.stringify(await live('s0-6.stream.jsonl')), 'ledger: api-request-blob records are ignored on replay')
}
{
  // The parent transcript carries only the Agent call; the edits live in the agent's own transcript.
  writeFileSync(join(project, 's07.jsonl'), '{}\n')
  mkdirSync(join(project, 's07', 'subagents'), { recursive: true })
  copyFileSync(fixture('s0-7-fg.agent-ae2b1bc9af2e99f9c.jsonl'), join(project, 's07', 'subagents', 'agent-ae2b1bc9af2e99f9c.jsonl'))
  const [a, b] = [await live('s0-7-fg.stream.jsonl'), await replayed('s07')]
  equal(JSON.stringify(b), JSON.stringify(a), 'ledger: S0-7 subagent replay equals live ingest')
  const rows = a as { added: number | null }[]
  ok(rows.length === 2 && rows.every((r) => r.added === null), 'ledger: S0-7 replace_all subagent edits are rows with unknown counts')
}

// A big file's replayed Edit has no originalFile: one edit stays exact from its patch, a
// second can't prove continuity and turns the file's total approximate.
{
  copyFileSync(fixture('s0-5.session.jsonl'), join(project, 's05.jsonl'))
  const [big] = (await replayed('s05')) as { added: number; removed: number; approximate: boolean; diffAvailable: boolean }[]
  ok(big.added === 1 && big.removed === 1 && !big.approximate && big.diffAvailable, 'ledger: S0-5 big-file replay counts its patch and can show it')
  const s = await one(
    ledgerWith([
      ...edit('b1', '/big.txt', null, [hunk(10, 1, 1, ['-a', '+b'])]),
      ...edit('b2', '/big.txt', null, [hunk(20, 1, 1, ['-c', '+d'])])
    ])
  )
  ok(s.segments === 2 && s.approximate && s.added === 2 && s.removed === 2, 'ledger: two before-less big-file edits are approximate')
}

// An old transcript's MultiEdit still adds its row.
{
  const s = await one(ledgerWith([use('m1', 'MultiEdit', { file_path: '/m.txt', edits: [{ old_string: 'a', new_string: 'b' }] }), res('m1', { filePath: '/m.txt' })]))
  ok(s.path === '/m.txt' && s.added === null, 'ledger: a MultiEdit without a patch is a row with unknown counts')
}
