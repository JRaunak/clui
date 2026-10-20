// Change references from the Diff surface: a selection becomes the request main mints, the same text selected two
// ways is one selection, an empty side falls back, and every sentence the chip, bar and notices say.
import { changeBlocked, diffSelection, mintedRef, mintedRequest, normalRows, recordMint, requestOf, rowCount, sideEmpty } from '../src/renderer/src/lib/changeRefs.ts'
import {
  addedText,
  changeSelectedSpoken,
  changeSelectedText,
  noticeLead,
  pausedText,
  removalSpoken,
  removedText,
  shortLabel,
  spokenRef,
  tooLargeText
} from '../src/renderer/src/lib/refCopy.ts'
import { changeSelection } from '../src/shared/changes.ts'
import { equal, ok } from './support/harness.mjs'

const H = 'a'.repeat(32)
const hunk = { id: H, segmentId: 'b'.repeat(32), revision: 'c'.repeat(32), oldStart: 3, oldLines: 3, newStart: 3, newLines: 4, lines: [' a', '-b', '+c', '+d', ' e', '\\ No newline at end of file'] }

// Selection → request.
{
  ok(normalRows(hunk, { start: 1, end: 6 }) === undefined && normalRows(hunk, undefined) === undefined, 'whole: a range over every line is the whole hunk')
  ok(normalRows(hunk, { start: 1, end: 5 }) === undefined, 'whole: a range over every shown line is the whole hunk, past a hidden No newline row')
  equal(JSON.stringify(normalRows(hunk, { start: 1, end: 4 })), '{"start":1,"end":4}', 'whole: a range short of the last shown line stays a range')
  equal(rowCount(hunk), 5, 'rows: a whole hunk counts its rendered rows, not the no-newline marker')
  equal(rowCount(hunk, { start: 2, end: 4 }), 3, 'rows: a range counts its rows')

  const { sel, fellFrom } = diffSelection('/w/mcp.ts', hunk, 'before', { start: 1, end: 2 })
  ok(!fellFrom && sel.side === 'before' && sel.rows?.start === 1 && sel.fits, 'select: a side with lines keeps it')
  equal(JSON.stringify([sel.old, sel.new]), '[{"start":3,"end":4},{"start":3,"end":3}]', 'select: both numberings of the range')
  ok(sel.path === '/w/mcp.ts' && sel.hunkId === H && sel.segmentId === hunk.segmentId && sel.revision === hunk.revision, 'select: it names the hunk it was made on')

  const added = diffSelection('/w/mcp.ts', hunk, 'before', { start: 3, end: 4 })
  ok(added.sel.side === 'diff' && added.fellFrom === 'before', 'select: an added-only range has no before side, so it falls back to diff')
  ok(sideEmpty(hunk, 'after', { start: 2, end: 2 }) && !sideEmpty(hunk, 'before', { start: 2, end: 2 }), 'select: a removed-only range has no after side')

  const whole = diffSelection('/w/mcp.ts', hunk, 'diff', { start: 1, end: 6 }).sel
  ok(whole.rows === undefined, 'select: the full range is stored as the whole hunk')
  const req = requestOf(whole)
  equal(JSON.stringify(req), JSON.stringify({ path: '/w/mcp.ts', segmentId: hunk.segmentId, revision: hunk.revision, hunkId: H, side: 'diff' }), 'request: what main mints, no display fields, rows absent')

  recordMint('h1', `chg_${'1'.repeat(32)}`, req)
  equal(mintedRef('h1', requestOf(diffSelection('/w/mcp.ts', hunk, 'diff').sel)), `chg_${'1'.repeat(32)}`, 'minted: the same selection by the hunk button finds its ref')
  ok(mintedRef('h1', { ...req, side: 'after' }) === null && mintedRef('h2', req) === null, 'minted: another side or another handle has none')
  ok(mintedRequest('h1', `chg_${'1'.repeat(32)}`)?.hunkId === H, 'minted: a chip finds the request to restore')
}

// The bar's blocked states.
{
  const big = { ...hunk, lines: Array.from({ length: 401 }, (_, i) => `+${i}`) }
  equal(changeBlocked(false, changeSelection(hunk, 'diff')), "Claude can't read changes in this session", 'blocked: no change_read comes first')
  equal(changeBlocked(null, changeSelection(big, 'after')), 'Too large to add: 401 lines, 400 max', 'blocked: over the line limit')
  ok(changeBlocked(null, changeSelection(hunk, 'diff')) === undefined && changeBlocked(true, changeSelection(hunk, 'diff')) === undefined, 'blocked: before init, mint decides')
  const sel = changeSelection(big, 'after')
  ok(!sel.ok && sel.new?.start === 3 && sel.new.end === 403, 'too large: still carries its numbering, for the @ row label')
  equal(tooLargeText(10, 32 * 1024 + 1), 'Too large to add: 33 KB, 32 KB max', 'too large: KB rounds up, so it never reads 32 KB, 32 KB max')
  equal(tooLargeText(512, 99_999), 'Too large to add: 512 lines, 400 max', 'too large: lines win when both are over')
}

// Copy.
{
  const chg = (o: Record<string, unknown>): any => ({ id: 'r1', kind: 'change', changeRef: `chg_${'2'.repeat(32)}`, path: '/w/src/mcp.ts', side: 'before', old: { start: 40, end: 45 }, ...o })
  equal(spokenRef(chg({})), 'mcp.ts change, before side, lines 40 to 45', 'spoken: before')
  equal(spokenRef(chg({ side: 'after', old: undefined, new: { start: 41, end: 41 } })), 'mcp.ts change, after side, line 41', 'spoken: after, one line')
  equal(spokenRef(chg({ side: 'diff', new: { start: 41, end: 53 } })), 'mcp.ts change, lines 40 to 45 before and 41 to 53 after', 'spoken: diff, both')
  equal(spokenRef(chg({ side: 'diff' })), 'mcp.ts change, removed lines 40 to 45', 'spoken: diff, removed only')
  equal(spokenRef(chg({ side: 'diff', old: undefined, new: { start: 41, end: 53 } })), 'mcp.ts change, added lines 41 to 53', 'spoken: diff, added only')
  equal(addedText(chg({})), 'Added mcp.ts change, before side, lines 40 to 45, to the message.', 'added: a change')
  equal(shortLabel(chg({})), 'mcp.ts · before L40–45', 'notice: a removed change names its file')
  equal(changeSelectedText(12, true), 'Whole hunk selected, 12 rows', 'bar: whole hunk')
  equal(changeSelectedText(1, false), '1 row selected', 'bar: one row')
  equal(changeSelectedSpoken(3, false, 'diff'), '3 rows selected, diff side', 'announce: a range')
  equal(changeSelectedSpoken(3, false, 'diff', 'before'), '3 rows selected. Before side has no lines here, so diff side is selected', 'announce: the fallback says why')

  const one = removalSpoken([chg({})], 'denied')
  equal(one, "Claude can't read changes in this session. The before side of mcp.ts lines 40 to 45 was removed from the message.", 'removed: one change')
  equal(removalSpoken([chg({}), chg({}), chg({})], 'denied'), "Claude can't read changes in this session. 3 changes were removed from the message.", 'removed: several')
  const n = (labels: string[], reason: any): any => ({ resourceId: `change:${reason}`, label: 'changes', oldVersion: '', at: 0, reason, removed: labels.map((label, i) => ({ id: `r${i}`, label })) })
  equal(noticeLead(n(['before L40–45'], 'denied')), "Claude can't read changes in this session.", 'notice: denied')
  equal(noticeLead(n(['before L40–45'], 'session')), "Changes can't move to a new session.", 'notice: session')
  equal(removedText(n(['before L40–45', 'diff L3–9 → L3–11'], 'denied')), 'Removed before L40–45 and diff L3–9 → L3–11.', 'notice: two named')
  equal(removedText(n(['a', 'b', 'c'], 'denied')), 'Removed 3 changes.', 'notice: three counted')
  ok(removalSpoken([chg({ side: 'diff', new: undefined })], 'denied').includes('The diff of mcp.ts deleting lines 40 to 45 was removed'), 'removed: a one-sided diff says deleting, not removed')
  equal(pausedText(n(['before L40–45'], 'denied')), "Claude can't read changes in this session, so before L40–45 was removed.", 'paused: denied')
}
