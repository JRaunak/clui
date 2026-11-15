// The composer's `@` picks and drops: the token a chip replaces leaves no fragment or double space, the Open in pane
// rows preview the chip they add, and a drop splits into chips and path-only refs the way main classified it.
import { paneRows, removeToken, routeDrop, splitFiles } from '../src/renderer/src/lib/composerRefs.ts'
import { dropText, noticeLead, removalSpoken, removedText, skippedNote } from '../src/renderer/src/lib/refCopy.ts'
import { parseSide } from '../src/renderer/src/lib/side.ts'
import { equal, ok } from './support/harness.mjs'

equal(JSON.stringify(parseSide('/side what is x')), '{"question":"what is x"}', 'side: /side takes the rest as the question')
equal(JSON.stringify(parseSide('/btw what is x')), '{"question":"what is x"}', 'side: /btw is the same')
equal(JSON.stringify(parseSide('/side')), '{"question":""}', 'side: /side alone opens with no question')
equal(JSON.stringify(parseSide('  /side  line one\nline two ')), '{"question":"line one\\nline two"}', 'side: a multi-line question is kept whole')
ok(parseSide('/sidebar x') === null && parseSide('/side-effects') === null && parseSide('see /side x') === null, 'side: a longer name or a mid-text /side does not match')

const cut = (marked: string, start: number): string => {
  const caret = marked.indexOf('|')
  const r = removeToken(marked.replace('|', ''), start, caret)
  return r.text.slice(0, r.caret) + '|' + r.text.slice(r.caret)
}
equal(cut('explain @mana|', 8), 'explain |', 'token: at the end leaves the text before it')
equal(cut('explain @mana| now', 8), 'explain |now', 'token: mid-sentence collapses to one space')
equal(cut('@mana| explain', 0), '|explain', 'token: first in the text drops the space after it')
equal(cut('see @src/ma|nager.ts here', 4), 'see |here', 'token: a mid-token caret leaves no fragment')
equal(cut('@a|', 0), '|', 'token: alone')
equal(cut('fix @a|\nnext', 4), 'fix|\nnext', 'token: a line break after it is kept')

const V = `sha256:${'a'.repeat(32)}` as const
const tab = (key: string, at: number, over: Record<string, unknown> = {}): any => ({ id: `file:${key}`, kind: 'file', key, title: key, openedBy: 'user', mode: 'auto', openedAt: 0, lastViewedAt: at, ...over })
const rows = paneRows(
  [
    tab('/w/src/main/manager.ts', 2, { selection: { lines: { start: 3, end: 5 }, sourceVersion: V } }),
    tab('/w/README.md', 3),
    tab('/w/src/old.ts', 1, { selection: { lines: { start: 1, end: 2 } } }),
    tab('/home/me/notes.md', 0),
    tab('/w/src/x.ts', 9, { provenance: { sessionId: 's', creatingEditId: 'e1' } }),
    { id: 'diff', kind: 'diff', key: '', title: 'Changes', openedBy: 'user', mode: 'auto', openedAt: 0, lastViewedAt: 10 }
  ],
  '/w',
  '/home/me',
  { inDraft: (r) => r.kind === 'file' && r.path === '/w/README.md', minted: () => false, changeRead: null }
)
equal(rows.map((r) => r.key).join(), 'file:file:/w/README.md,sel:file:/w/src/main/manager.ts,file:file:/w/src/main/manager.ts,file:file:/w/src/old.ts,file:file:/home/me/notes.md', 'pane: newest first, selection before its file, no Diff or past-revision tab')
const [readme, sel, whole, old, outside] = rows
ok(sel.input.kind === 'file' && sel.input.lines?.start === 3 && sel.input.sourceVersion === V, 'pane: the selection row adds what the File bar adds')
equal(sel.hint, 'Selected · src/main/', 'pane: selection hint')
equal(sel.aria, 'manager.ts, lines 3 to 5, selected, in src/main', 'pane: selection name')
equal(whole.aria, 'manager.ts, open in pane, in src/main', 'pane: whole-file name')
equal(readme.hint, 'In message', 'pane: an attached file says so in place of its folder')
equal(readme.aria, 'README.md, open in pane, in message', 'pane: a top-level file names no folder')
ok(!rows.some((r) => r.key === 'sel:file:/w/src/old.ts') && old.hint === 'src/', 'pane: a selection without its revision has no row')
equal(outside.rel, '~/notes.md', 'pane: outside the folder ranks on the ~ path')
equal(outside.hint, '~/', 'pane: outside the folder shows the ~ parent')

// The Diff tab offers only its selected change, ranked with the File tabs, and says why a pick would be refused.
{
  const H = 'a'.repeat(32)
  const change = { path: '/w/src/mcp.ts', segmentId: H, revision: H, hunkId: H, side: 'before', rows: { start: 2, end: 3 }, old: { start: 40, end: 45 }, fits: true }
  const diff = (over: Record<string, unknown> = {}): any => ({ id: 'diff', kind: 'diff', key: '', title: 'Claude changes', openedBy: 'user', openedAt: 0, lastViewedAt: 5, selection: { change: { ...change, ...over } } })
  const st = { inDraft: () => false, minted: () => false, changeRead: null }
  const all = paneRows([tab('/w/src/mcp.ts', 6), diff()], '/w', '/home/me', st)
  equal(all.map((r) => r.key).join(), 'file:file:/w/src/mcp.ts,change:diff', 'pane: the Diff row joins the File tabs by last view and leaves the file row')
  const [, row] = all
  ok(!row.input && row.mint?.hunkId === H && row.mint.side === 'before' && row.mint.rows?.end === 3 && !('fits' in row.mint), 'pane: the Diff row mints the selection as main takes it')
  equal(row.label, 'mcp.ts · before L40-45', 'pane: the label carries the side and range')
  equal(row.hint, 'Selected change · src/', 'pane: Diff hint')
  equal(row.aria, 'mcp.ts change, before side, lines 40 to 45, selected, in src', 'pane: Diff name')
  const one = (o: Record<string, unknown>, s = st): any => paneRows([diff(o)], '/w', '/home/me', s)[0]
  equal(one({ fits: false }).hint, 'Too large to add', 'pane: too large')
  equal(one({}, { ...st, minted: () => true }).aria, 'mcp.ts change, before side, lines 40 to 45, selected, in src, in message', 'pane: attached')
  const denied = one({ fits: false }, { ...st, changeRead: false })
  ok(denied.hint === "Claude can't read changes here" && denied.aria.endsWith(", Claude can't read changes here"), 'pane: no change_read wins over size')
  equal(paneRows([{ ...diff(), selection: undefined }], '/w', '/home/me', st).length, 0, 'pane: a Diff tab without a selection has no row')
}

{
  const drop = routeDrop(
    ['/w/a.ts', '/w/src', '/else where/b.ts', '/w/denied', '/w/gone.ts', '/w/unasked.ts'],
    [{ kind: 'file', granted: true }, { kind: 'folder', granted: true }, { kind: 'file', granted: false }, { kind: 'folder', granted: false }, null]
  )
  equal(
    JSON.stringify(drop),
    JSON.stringify([
      { kind: 'file', path: '/w/a.ts' },
      { kind: 'folder', path: '/w/src' },
      { kind: 'path', path: '/else where/b.ts', target: 'file' },
      { kind: 'path', path: '/w/denied', target: 'folder' }
    ]),
    'drop: granted paths become chips, an outside or refused-in-folder path a path ref, in order; nothing for a missing one'
  )
}

{
  const file = (name: string, type: string): File => new File(['x'], name, { type })
  const onDisk = new Map<File, string>()
  const png = file('a.png', 'image/png')
  const src = file('b.ts', 'text/plain')
  const blob = file('pasted.txt', 'text/plain')
  const svg = file('c.svg', 'image/svg+xml')
  const pastedSvg = file('d.svg', 'image/svg+xml')
  onDisk.set(png, '/w/a.png').set(src, '/w/b.ts').set(svg, '/w/c.svg')
  const split = splitFiles([png, src, blob, svg, pastedSvg], (f) => onDisk.get(f) ?? '')
  ok(split.inline.length === 3 && split.inline[0] === png && split.inline[1] === blob && split.inline[2] === pastedSvg, 'split: a supported image inlines even with a path, as does any file with none')
  equal(split.paths.join(), '/w/b.ts,/w/c.svg', 'split: any other file goes by its path, an unsupported image too, as a pick sends it')
}

const f = (path: string): any => ({ kind: 'file', path })
const pr = (path: string): any => ({ kind: 'path', path, target: 'file' })
equal(dropText([f('/w/a.ts')], [], 0), 'Added a.ts to the message.', 'drop text: one chip')
equal(dropText([pr('/x/report.pdf')], [], 0), 'Added report.pdf to the message, path only.', 'drop text: one path ref')
equal(dropText([f('/w/a.ts'), f('/w/b.ts')], [f('/w/c.ts')], 0), 'Added 2 references to the message. 1 was already attached.', 'drop text: chips and a duplicate')
equal(dropText([f('/w/a.ts'), pr('/x/b.pdf')], [], 0), 'Added 2 references to the message. 1 is sent as a path only.', 'drop text: one of several is a path ref')
equal(dropText([pr('/x/a.pdf'), pr('/x/b.pdf'), f('/w/c.ts')], [], 0), 'Added 3 references to the message. 2 are sent as paths only.', 'drop text: several path refs')
equal(dropText([], [f('/w/c.ts')], 0), 'Already attached: c.ts', 'drop text: a lone duplicate names it')
equal(dropText([f('/w/a.ts')], [], 2), `Added a.ts to the message. ${skippedNote(2)}`, 'drop text: the cap')
equal(skippedNote(1), '20 references max. 1 file was not added.', 'drop text: one skipped')

// A page pin's removal reads like a browser pin's, named by the file's basename.
{
  const t = { tag: 'button', role: 'button', name: 'Sign in', text: 'Sign in', selector: 'body > form > button', bbox: { x: 0, y: 0, width: 9, height: 9 }, styles: {}, html: '' }
  const ref = { id: 'r2', kind: 'page', path: '/w/docs/report.html', revision: V, target: t } as const
  equal(removalSpoken([ref, { ...ref, id: 'r3' }], 'changed'), 'report.html changed. 2 elements were removed from the message.', 'page removal: the basename and elements')
  equal(removalSpoken([ref], 'closed'), 'The report.html tab was closed. Button Sign in was removed from the message.', 'page removal: a closed tab')
  const n = { resourceId: 'page:/w/docs/report.html', label: 'report.html', oldVersion: V, at: 0, reason: 'changed' as const, removed: [{ id: 'r2', label: 'a' }, { id: 'r3', label: 'b' }, { id: 'r4', label: 'c' }] }
  ok(noticeLead(n) === 'report.html changed. Pick it again.' && removedText(n) === 'Removed 3 elements.', 'page notice: picked again, counted as elements')
}

// The `/` menu's skill rows come from the live list's non-built-ins, the CLI's scope suffix turned into a scope.
{
  const { resolveSkillCommands, resolveSlashCommands } = await import('../src/renderer/src/lib/slashCommands.ts')
  const live = [
    { name: 'compact', description: 'Free context', builtin: true },
    { name: 'ship', description: 'Ship it (project)', argumentHint: '<msg>' },
    { name: 'ship', description: 'Ship it globally (user)' },
    { name: 'bare', description: ' (user)' },
    { name: 'acme:lint', description: 'Lint', plugin: 'acme' },
    { name: 'odd', description: 'No suffix' }
  ]
  const skills = resolveSkillCommands(live)
  equal(skills.map((s) => `${s.scope}:${s.name}`).join(','), 'project:ship,user:ship,user:bare,plugin:acme:lint,undefined:odd', 'skills: non-built-ins only, scoped')
  equal(skills[0].description, 'Ship it', 'skills: project suffix stripped')
  equal(skills[1].description, 'Ship it globally', 'skills: user suffix stripped')
  equal(skills[2].description, '', 'skills: a suffix-only description empties')
  equal(skills[0].argumentHint, '<msg>', 'skills: arg hint kept')
  equal(skills[3].plugin, 'acme', 'skills: plugin name kept')
  equal(resolveSlashCommands(live).map((c) => c.name).join(','), 'compact', 'skills: built-ins still curate to the allowlist')
}
