// The composer's `@` picks and drops: the token a chip replaces leaves no fragment or double space, the Open in pane
// rows preview the chip they add, and a drop splits into chips and @ text the way main authorized it.
import { paneRows, removeToken, routeDrop } from '../src/renderer/src/lib/composerRefs.ts'
import { dropText, skippedNote } from '../src/renderer/src/lib/refCopy.ts'
import { equal, ok } from './support/harness.mjs'

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
  (r) => r.kind === 'file' && r.path === '/w/README.md'
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

const drop = routeDrop(['/w/a.ts', '/w/src', '/elsewhere/b.ts', '/w/denied.ts'], ['file', 'folder', null], '/w')
ok(drop.refs.length === 2 && drop.refs[0].kind === 'file' && drop.refs[1].kind === 'folder', 'drop: authorized paths become chips in order')
equal(drop.mentions.join(' '), '@/elsewhere/b.ts @denied.ts', 'drop: the rest stay @ text, relative under the folder')
equal(drop.outside, 1, 'drop: a refused path inside the folder is not counted as outside')
equal(dropText([], { inside: 1, outside: 0 }, [], 0), '1 file was added as an @ mention.', 'drop text: a refused path inside the folder')

const f = (path: string): any => ({ kind: 'file', path })
equal(dropText([f('/w/a.ts')], { inside: 0, outside: 0 }, [], 0), 'Added a.ts to the message.', 'drop text: one chip')
equal(dropText([f('/w/a.ts'), f('/w/b.ts')], { inside: 0, outside: 2 }, [f('/w/c.ts')], 0), 'Added 2 references to the message. 2 files outside this folder were added as @ mentions. 1 was already attached.', 'drop text: chips, mentions, a duplicate')
equal(dropText([], { inside: 0, outside: 1 }, [], 0), '1 file outside this folder was added as an @ mention.', 'drop text: one mention')
equal(dropText([], { inside: 0, outside: 0 }, [f('/w/c.ts')], 0), 'Already attached: c.ts', 'drop text: a lone duplicate names it')
equal(dropText([f('/w/a.ts')], { inside: 0, outside: 0 }, [], 2), `Added a.ts to the message. ${skippedNote(2)}`, 'drop text: the cap')
equal(skippedNote(1), '20 references max. 1 file was not added.', 'drop text: one skipped')
