// Boundary: which transcript paths become file links (Markdown hrefs, inline code, tool inputs), the edit line a tool
// card opens at, and the editor arguments a line becomes.
import { equal, ok } from './support/harness.mjs'

const { isLocalHref, lineReaches, listedIn, openFileLabel, resolveCode, resolveHref, splitLineSuffix, toolPathIn, workspaceOf } = await import('../src/renderer/src/lib/fileLinks.ts')
const { editLine } = await import('../src/main/surfaces/diff.ts')
const { editorArgs } = await import('../src/main/ide/open.ts')
const { editorLineStyle } = await import('../src/shared/settings.ts')

const cwd = '/tmp/ws'
const ws = workspaceOf(['src/store.ts', 'src/main/index.ts', 'README.md', 'a b.md', 'store.ts.bak'])
const href = (h: string): string => JSON.stringify(resolveHref(h, cwd))
const code = (t: string): string => JSON.stringify(resolveCode(t, cwd, ws))

// Hrefs: relative, dotted, absolute inside, file://, line and range suffixes, fragments and encoding.
equal(href('src/store.ts'), '{"kind":"file","ref":{"rel":"src/store.ts"}}', 'href: relative path')
equal(href('./src/store.ts:42'), '{"kind":"file","ref":{"rel":"src/store.ts","line":42}}', 'href: ./ and :line')
equal(href('src/store.ts:42:7'), '{"kind":"file","ref":{"rel":"src/store.ts","line":42}}', 'href: :line:col keeps the line')
equal(href('src/store.ts#L142-L158'), '{"kind":"file","ref":{"rel":"src/store.ts","line":142,"endLine":158}}', 'href: #L range')
equal(href('src/store.ts#L142'), '{"kind":"file","ref":{"rel":"src/store.ts","line":142}}', 'href: #L line')
equal(href('/tmp/ws/src/store.ts'), '{"kind":"file","ref":{"rel":"src/store.ts"}}', 'href: absolute inside cwd')
equal(href('file:///tmp/ws/src/store.ts:3'), '{"kind":"file","ref":{"rel":"src/store.ts","line":3}}', 'href: file:// inside cwd')
equal(href('file://localhost/tmp/ws/a%20b.md'), '{"kind":"file","ref":{"rel":"a b.md"}}', 'href: file://localhost, percent-decoded')
equal(href('docs/guide.md#install'), '{"kind":"file","ref":{"rel":"docs/guide.md"}}', 'href: a non-line fragment is dropped')
equal(href('file:///etc/passwd'), '{"kind":"outside","path":"/etc/passwd"}', 'href: file:// outside cwd is outside')
equal(href('../secrets.txt'), '{"kind":"outside","path":"../secrets.txt"}', 'href: .. above cwd is outside')
equal(href('%2e%2e/%2e%2e/etc/passwd'), '{"kind":"outside","path":"../../etc/passwd"}', 'href: encoded traversal is outside')
equal(href('/tmp/ws/../other/x.ts'), '{"kind":"outside","path":"/tmp/ws/../other/x.ts"}', 'href: absolute climbing out is outside')
equal(href('/tmp/wsx/a.ts'), '{"kind":"outside","path":"/tmp/wsx/a.ts"}', 'href: a sibling with the same prefix is outside')
for (const h of ['https://example.com/a.ts', 'mailto:a@b.c', '#section', 'javascript:alert(1)', 'java%73cript:alert(1)', 'file://evil.host/tmp/ws/a', 'file://', '//cdn/x.js', '?q=1', './', '%E0%A4%A'])
  equal(resolveHref(h, cwd), null, `href: ${h} keeps the existing handling`)

// What survives react-markdown's URL transform.
ok(isLocalHref('file:///tmp/ws/a.ts') && isLocalHref('src/a.ts:12') && isLocalHref('a.ts:12:3') && isLocalHref('src/a.ts:12#x'), 'transform: file: and path:line hrefs are kept')
ok(!isLocalHref('javascript:1') && !isLocalHref('javascript:alert(1)') && !isLocalHref('data:text/html,x') && !isLocalHref('vbscript:1'), 'transform: bare-word schemes are not')

// Inline code: exact set membership, never a basename guess.
equal(code('src/store.ts'), '{"rel":"src/store.ts"}', 'code: exact path')
equal(code('./src/store.ts'), '{"rel":"src/store.ts"}', 'code: ./ prefix')
equal(code('src/store.ts:12'), '{"rel":"src/store.ts","line":12}', 'code: :line suffix')
equal(code('src/store.ts#L3-L9'), '{"rel":"src/store.ts","line":3,"endLine":9}', 'code: #L range')
equal(code('/tmp/ws/src/main/index.ts'), '{"rel":"src/main/index.ts"}', 'code: absolute inside cwd')
equal(code('src/main/'), '{"rel":"src/main"}', 'code: a folder with a slash')
equal(code('src/main'), '{"rel":"src/main"}', 'code: a nested folder')
equal(code('README.md'), '{"rel":"README.md"}', 'code: a root file')
for (const t of ['store.ts', 'index.ts', 'src', 'a/b', '1/2', 'v1.2.3', '2026/10/14', 'host:8080', 'src/store', '/etc/hosts', '/tmp/ws/../ws/src/store.ts', 'src/store.ts:0', 'src/nope.ts:4'])
  equal(resolveCode(t, cwd, ws), null, `code: ${t} is not a link`)
equal(JSON.stringify(splitLineSuffix('a.ts:0')), '{"path":"a.ts:0"}', 'suffix: line 0 is not a line')
equal(JSON.stringify(splitLineSuffix('a.ts#L9-L4')), '{"path":"a.ts","line":9}', 'suffix: a backwards range keeps its start')

// An href links once listed only when the folder has it; before the listing arrives it links optimistically.
ok(listedIn(ws, 'src/store.ts') && listedIn(ws, 'src/main') && !listedIn(ws, 'src/nope.ts') && !listedIn(ws, 'store.ts') && listedIn(null, 'src/nope.ts'), 'href: membership once listed')

// The tool card's name promises a line only where the click lands on it.
equal(openFileLabel('a.ts', 12, 'clui', 'vim'), 'Open a.ts at line 12', 'label: Clui always takes the line')
equal(openFileLabel('a.ts', 12, 'editor', 'code'), 'Open a.ts at line 12', 'label: code takes the line')
equal(openFileLabel('a.ts', 12, 'editor', 'vim'), 'Open a.ts', 'label: vim gets no line')
equal(openFileLabel('a.ts', undefined, 'clui', 'code'), 'Open a.ts', 'label: no line')
ok(lineReaches('editor', 'subl') && !lineReaches('editor', 'nano'), 'label: line reach by editor')

// Tool inputs.
equal(toolPathIn({ file_path: '/tmp/ws/src/store.ts' }, cwd), '/tmp/ws/src/store.ts', 'tool: file_path inside cwd')
equal(toolPathIn({ file_path: '/tmp/other/x.ts' }, cwd), null, 'tool: outside cwd')
equal(toolPathIn({ file_path: '/tmp/ws/src/x.ts' }, null), null, 'tool: no cwd')
equal(toolPathIn({ path: '/tmp/ws/a' }, cwd), null, 'tool: no file_path')

// The edit line: the first non-context line of the edit's own first hunk, as numbered after it.
const segs = [
  { id: 's1', revision: 'r', editIds: ['t1', 't2'], patches: [[{ oldStart: 10, oldLines: 7, newStart: 10, newLines: 8, lines: [' a', ' b', ' c', '-x', '+y', '+z', ' d'] }], null], provenBreak: false, created: false },
  { id: 's2', revision: 'r', editIds: ['t3'], patches: [[{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+a', '+b'] }]], provenBreak: false, created: true }
]
equal(editLine(segs, 't1'), 13, 'editLine: newStart plus leading context')
equal(editLine(segs, 't2'), null, 'editLine: an edit without hunks has no line')
equal(editLine(segs, 't3'), 1, 'editLine: a hunk with no context')
equal(editLine(segs, 'nope'), null, 'editLine: an unknown edit')

// A line reaches only an editor that takes one.
equal(JSON.stringify(editorArgs('code', '/a/b.ts', 12)), '["-g","/a/b.ts:12:1"]', 'editor: code takes -g')
equal(JSON.stringify(editorArgs('/usr/local/bin/cursor --reuse-window', '/a/b.ts', 3)), '["-g","/a/b.ts:3:1"]', 'editor: a path and flags still name cursor')
equal(JSON.stringify(editorArgs('subl', '/a/b.ts', 12)), '["/a/b.ts:12:1"]', 'editor: subl takes a suffix')
equal(JSON.stringify(editorArgs('vim', '/a/b.ts', 12)), '["/a/b.ts"]', 'editor: vim gets the file alone')
equal(JSON.stringify(editorArgs('code', '/a/b.ts')), '["/a/b.ts"]', 'editor: no line, no flag')
ok(editorLineStyle('zed') === 'suffix' && editorLineStyle('windsurf') === 'goto' && editorLineStyle('nano') === null, 'editor: line styles')
