// The Markdown Preview's rules: links relative to the document, front matter that keeps line numbers, blocks to lines,
// the 1 MB cut, which tabs preview, and the renderer's exact-file image caps.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { blockFor, docTree, frontMatter, joinSpans, meets, nextChunk, parseSpan, pointAt, previewEnd, PREVIEW_MAX, rowOf, rowWithId, slugger, spanAttr, type DocTree } from '../src/renderer/src/lib/markdownDoc.ts'
import { latestParse, parseHere } from '../src/renderer/src/lib/markdownParse.ts'
import { findRe } from '../src/renderer/src/lib/find.ts'
import { movedLine } from '../src/shared/lines.ts'
import { resolveHref } from '../src/renderer/src/lib/fileLinks.ts'
import { clearNoPreview, hasFind, hasPreview, markNoPreview, presentationOf } from '../src/renderer/src/lib/presentation.ts'
import { createFileAccess } from '../src/main/surfaces/files.ts'
import { createCaps, createImageCaps, imageCapPath, isImagePath } from '../src/main/surfaces/protocol.ts'
import { equal, ok } from './support/harness.mjs'

const same = (a: unknown, b: unknown, m: string): void => equal(JSON.stringify(a), JSON.stringify(b), m)

// Links resolve against the document's folder
{
  const cwd = '/w'
  const base = '/w/docs'
  same(resolveHref('./api.md', cwd, base), { kind: 'file', ref: { rel: 'docs/api.md' } }, 'href: ./ is the document folder')
  same(resolveHref('api.md', cwd, base), { kind: 'file', ref: { rel: 'docs/api.md' } }, 'href: a bare name is the document folder')
  same(resolveHref('../src/x.ts:40', cwd, base), { kind: 'file', ref: { rel: 'src/x.ts', line: 40 } }, 'href: up a folder, with a line')
  same(resolveHref('x.ts#L40', cwd, base), { kind: 'file', ref: { rel: 'docs/x.ts', line: 40 } }, 'href: #L is a line, not an anchor')
  same(resolveHref('api.md#usage', cwd, base), { kind: 'file', ref: { rel: 'docs/api.md', anchor: 'usage' } }, 'href: a fragment is the anchor')
  same(resolveHref('api.md#caf%C3%A9', cwd, base), { kind: 'file', ref: { rel: 'docs/api.md', anchor: 'café' } }, 'href: the anchor is decoded')
  same(resolveHref('../../etc/hosts', cwd, base), { kind: 'outside', path: '/etc/hosts' }, 'href: outside, named by its resolved path')
  same(resolveHref('/w/README.md', cwd, base), { kind: 'file', ref: { rel: 'README.md' } }, 'href: absolute ignores the base')
  same(resolveHref('./api.md', cwd), { kind: 'file', ref: { rel: 'api.md' } }, 'href: without a base, the session folder')
  equal(resolveHref('#usage', cwd, base), null, 'href: a same-file anchor is not a file')
  equal(resolveHref('https://example.com/a.md', cwd, base), null, 'href: web stays web')
}

// Front matter
{
  const text = '---\ntitle: A\ntags: [x]\n---\n# Heading\n\nBody\n'
  const fm = frontMatter(text)!
  equal(fm.lines, 4, 'front matter: four lines with both fences')
  equal(fm.code, 'title: A\ntags: [x]', 'front matter: the inner text')
  equal(fm.body.split('\n')[4], '# Heading', 'front matter: the heading keeps line 5')
  equal(fm.body.split('\n').length, text.split('\n').length, 'front matter: the line count is unchanged')
  equal(frontMatter('---\r\na: 1\r\n---\r\nx')?.code, 'a: 1', 'front matter: CRLF')
  equal(frontMatter('---\n---\nx')?.lines, 2, 'front matter: empty')
  equal(frontMatter('---\na: 1\n---')?.body, '\n\n\n', 'front matter: the closing fence ends the file')
  equal(frontMatter('---\nno close\n'), null, 'front matter: unclosed is just a rule')
  equal(frontMatter('# x\n---\n'), null, 'front matter: only at the top')
}

// Blocks and lines
{
  same(spanAttr({ start: { line: 3 }, end: { line: 9 } }), '3-9', 'span: data-src')
  same(parseSpan('3-9'), { start: 3, end: 9 }, 'span: parsed')
  equal(parseSpan('x'), null, 'span: junk')
  same(joinSpans({ start: 12, end: 14 }, { start: 5, end: 6 }), { start: 5, end: 14 }, 'span: two blocks, lowest start to highest end')
  ok(meets({ start: 3, end: 6 }, { start: 6, end: 9 }) && !meets({ start: 3, end: 5 }, { start: 6, end: 9 }), 'span: meets')
  // A list item 3-6 holding an item at 4, then a paragraph at 8-9.
  const spans = [{ start: 1, end: 1 }, { start: 3, end: 6 }, { start: 4, end: 4 }, { start: 8, end: 9 }]
  equal(blockFor(spans, 4), 2, 'block: the innermost one holding the line')
  equal(blockFor(spans, 5), 1, 'block: the container when no child holds it')
  equal(blockFor(spans, 7), 3, 'block: a line between blocks goes to the next')
  equal(blockFor(spans, 99), 3, 'block: past the end, the last')
  equal(blockFor([], 1), -1, 'block: none')
}

// Heading ids
{
  const slug = slugger()
  equal(slug('Getting Started!'), 'getting-started', 'slug: GitHub style')
  equal(slug('Getting Started'), 'getting-started-1', 'slug: a repeat')
  equal(slug('Getting Started'), 'getting-started-2', 'slug: another')
  equal(slug('getting-started-1'), 'getting-started-1-1', 'slug: an id a repeat already took')
  equal(slug('Café & co_op'), 'café--co_op', 'slug: letters and underscores kept, symbols dropped')
}

// The 1 MB cut
{
  equal(previewEnd('# small\n'), null, 'cut: a small file previews whole')
  const line = 'x'.repeat(99) + '\n'
  const big = line.repeat(Math.ceil((PREVIEW_MAX * 1.2) / line.length))
  const end = previewEnd(big)!
  ok(end > 0 && end <= PREVIEW_MAX && big[end - 1] === '\n', 'cut: at a line break')
  ok(PREVIEW_MAX - end < line.length, 'cut: the last line break before 1 MB')
  // Three bytes a character: the cut counts UTF-8 bytes, not characters.
  const wide = ('€'.repeat(99) + '\n').repeat(4000)
  const w = previewEnd(wide)!
  ok(new TextEncoder().encode(wide.slice(0, w)).length <= PREVIEW_MAX && wide[w - 1] === '\n', 'cut: by bytes')
  equal(previewEnd('x'.repeat(PREVIEW_MAX)), null, 'cut: exactly 1 MB fits')
}

// Which tabs preview
{
  const tab = (key: string, mode?: 'auto' | 'source' | 'preview') => ({ kind: 'file' as const, key, ...(mode ? { mode } : {}) })
  ok(hasPreview('/w/a.md') && hasPreview('/w/A.MARKDOWN') && !hasPreview('/w/a.txt'), 'preview: Markdown has one, plain text none')
  equal(presentationOf(tab('/w/a.md'), false), 'preview', 'preview: a Markdown tab previews')
  markNoPreview('h', '/w/big.md', 'too-large')
  equal(hasFind('h', tab('/w/big.md')), true, 'find: a big file in Source finds')
  equal(presentationOf(tab('/w/big.md', 'preview'), true), 'preview', 'preview: an explicit preview wins over the size')
  equal(hasFind('h', tab('/w/a.md', 'preview')), true, 'find: a Markdown Preview finds')
  equal(hasFind('h', tab('/w/a.html', 'preview')), false, 'find: an HTML Preview does not')
  markNoPreview('h', '/w/p.html', 'denied')
  equal(hasFind('h', tab('/w/p.html')), true, 'preview: a marked page shows Source')
  clearNoPreview('h', '/w/p.html')
  equal(hasFind('h', tab('/w/p.html')), false, 'preview: a cleared mark previews again')
}

// Image caps
{
  ok(isImagePath('/w/a.PNG') && isImagePath('/w/a.svg') && !isImagePath('/w/a.md') && !isImagePath('/w/png'), 'image: by extension')
  ok(imageCapPath('/img.png', '/w/docs/img.png'), 'image path: the file name')
  ok(imageCapPath('/a%20b.png', '/w/a b.png'), 'image path: decoded')
  ok(!imageCapPath('/other.png', '/w/img.png'), 'image path: another name')
  ok(!imageCapPath('/docs/img.png', '/w/docs/img.png'), 'image path: no folders')
  ok(!imageCapPath('/%2e%2e%2fimg.png', '/w/img.png') && !imageCapPath('/.img.png', '/w/.img.png'), 'image path: traversal and dot names')

  const fx = mkdtempSync('/tmp/clui-md-')
  const ws = join(realpathSync(fx), 'ws')
  mkdirSync(join(ws, 'docs'), { recursive: true })
  writeFileSync(join(ws, 'docs', 'img.png'), 'PNG')
  writeFileSync(join(ws, 'docs', 'notes.txt'), 'text')
  writeFileSync(join(fx, 'out.png'), 'OUT')
  symlinkSync(join(ws, 'docs', 'notes.txt'), join(ws, 'docs', 'fake.png'))
  const cwds = new Map([['h1', ws]])
  const fa = createFileAccess({ cwd: (h) => cwds.get(h) ?? null, changedPaths: async () => [] })
  const images = createImageCaps((h, p) => fa.resolveAllowed(h, p, { consumer: 'file', operation: 'read-file' }))
  const get = (url: string, method = 'GET') => images.serve(new Request(url, { method }))

  const caps = await images.mint('h1', 'tab', [join(ws, 'docs', 'img.png'), join(fx, 'out.png'), join(ws, 'docs', 'notes.txt'), join(ws, 'docs', 'gone.png'), join(ws, 'docs', 'fake.png')])
  const url = caps[0].ok ? caps[0].url : ''
  ok(/^clui-file:\/\/[0-9a-f]{32}\/img\.png$/.test(url), 'image cap: an exact host per file')
  same(caps.slice(1), [{ ok: false, outside: true }, { ok: false, outside: false }, { ok: false, outside: false }, { ok: false, outside: false }], 'image cap: outside, not an image, missing, and a symlink are not minted')
  const res = await get(url)
  equal(res.status, 200, 'image cap: served')
  equal(res.headers.get('content-type'), 'image/png', 'image cap: its type')
  equal(res.headers.get('x-content-type-options'), 'nosniff', 'image cap: nosniff')
  equal(await res.text(), 'PNG', 'image cap: the bytes')
  equal((await get(url.replace('img.png', 'notes.txt'))).status, 404, 'image cap: one file only')
  equal((await get(url, 'POST')).status, 405, 'image cap: reads only')

  // HTML view caps and image caps are separate sets on separate sessions: neither answers the other's hosts.
  const web = createCaps((h, p) => fa.resolveAllowed(h, p, { consumer: 'web', operation: 'read-file' }))
  const host = web.issue({ handleId: 'h1', root: join(ws, 'docs'), policy: { artifact: false, remote: false, data: false }, served: new Map() })
  equal((await web.serve(new Request(url))).status, 403, 'image cap: unreachable from an HTML view')
  equal((await get(`clui-file://${host}/img.png`)).status, 403, 'image cap: an HTML view cap is unreachable from the renderer')

  const again = await images.mint('h1', 'tab', [join(ws, 'docs', 'img.png')])
  equal((await get(url)).status, 403, 'image cap: a new revision revokes the earlier caps')
  const next = again[0].ok ? again[0].url : ''
  equal((await get(next)).status, 200, 'image cap: and serves its own')
  const other = await images.mint('h1', 'other-tab', [join(ws, 'docs', 'img.png')])
  images.revoke('h1', 'tab')
  equal((await get(next)).status, 403, 'image cap: revoked when the preview unmounts')
  equal((await get(other[0].ok ? other[0].url : '')).status, 200, 'image cap: another preview keeps its own')

  // A mint that finishes after its preview is gone issues nothing.
  const late = images.mint('h1', 'late', [join(ws, 'docs', 'img.png')])
  images.revoke('h1', 'late')
  same(await late, [{ ok: false, outside: false }], 'image cap: a mint overtaken by a revoke')

  images.dispose('h1')
  equal((await get(other[0].ok ? other[0].url : '')).status, 403, 'image cap: a disposed session holds none')
  const last = await images.mint('h1', 'tab', [join(ws, 'docs', 'img.png')])
  images.clear()
  equal((await get(last[0].ok ? last[0].url : '')).status, 403, 'image cap: window teardown revokes all')
  same(await images.mint('h1', 'tab', 'nope'), [], 'image cap: bad input')
  rmSync(fx, { recursive: true, force: true })
}

// The tree renders in chunks by weight, and a target row is always inside the chunk that reaches for it
{
  equal(nextChunk([3, 3, 3, 3], 0, 5), 2, 'chunk: rows until the budget is reached')
  equal(nextChunk([9, 1], 0, 5), 1, 'chunk: one heavy row still makes a chunk')
  equal(nextChunk([1, 1, 1, 1], 1, 100), 4, 'chunk: the rest fits')
  equal(nextChunk([5, 5, 5, 5], 0, 5, (i) => i < 2), 3, 'chunk: rows already built are free')
  equal(nextChunk([1, 1], 2, 5), 2, 'chunk: none past the end')
  equal(nextChunk([], 0, 5), 0, 'chunk: an empty document')
  // A deep jump renders toward its row a budget at a time, the same chunks every time.
  const w = Array.from({ length: 5000 }, (_, i) => 1 + (i % 7))
  const steps: number[] = []
  for (let s = 0; s <= 4000; ) {
    const to = nextChunk(w, s, 50)
    ok(w.slice(s, to).reduce((a, b) => a + b, 0) < 50 + 7, `reach: chunk ${steps.length} stays near the budget`)
    steps.push((s = to))
  }
  ok(steps.length > 100 && steps.at(-1)! > 4000, 'reach: the target row is reached in many small chunks')
}

// A row's key changes exactly when its render does
{
  const doc = '# Intro\n\nSee [x][r].\n\n[r]: https://a.example\n\nTail.\n'
  const a = docTree(doc)
  const b = docTree(doc.replace('https://a', 'https://b'))
  equal(a.keys.length, a.rows.length, 'key: one per row')
  ok(a.keys[0] === b.keys[0] && a.keys[2] === b.keys[2], 'key: unchanged rows keep theirs')
  ok(a.keys[1] !== b.keys[1], 'key: a row whose reference definition changed gets a new one')
  equal(docTree(doc.replace('# Intro', '# Intro, longer')).keys[1], a.keys[1], 'key: an edit earlier on the page that keeps the lines keeps it')
  ok(docTree('\n' + doc).keys[1] !== a.keys[1], 'key: a row moved to another line gets a new one')
  ok(docTree('# A\n\n# A\n').keys[1] !== docTree('# B\n\n# A\n').keys[1], "key: a heading whose id depends on an earlier one")
}

// Find matches the text as written
{
  const hay = 'İİ Straße, STRASSE and straße'
  const hits = [...hay.matchAll(findRe('straße'))].map((m) => [m.index, m.index + m[0].length])
  same(hits, [[3, 9], [23, 29]], 'find: offsets index the text itself, past a character that lowercases longer')
  ok(hits.every(([s, e]) => hay.slice(s, e).toLowerCase() === 'straße'), 'find: each offset covers its match')
  equal([...'a.b axb'.matchAll(findRe('a.b'))].length, 1, 'find: the query is literal')
  equal([...'ẞ'.matchAll(findRe('ß'))].length, 1, 'find: case-insensitive beyond ASCII')
}

// The parsed tree: top-level blocks only, positions where lines map, ids on headings, rows found by line and id
{
  const t = docTree('# Intro\n\nOne.\n\n- a\n- b\n\n## Intro\n')
  same(t.rows.map((r) => (r.type === 'element' ? r.tagName : r.type)), ['h1', 'p', 'ul', 'h2'], 'tree: whitespace between blocks is dropped')
  same(t.weights, [1, 1, 3, 1], 'tree: weight counts elements')
  const h2 = t.rows[3]
  equal(h2.type === 'element' ? h2.properties.id : null, 'intro-1', 'tree: a repeated heading id is numbered')
  equal(h2.type === 'element' && h2.children[0].type === 'text' ? h2.children[0].position : 'x', undefined, 'tree: text keeps no position')
  equal(rowOf(t.rows, 3), 1, 'row: a line maps to its block')
  equal(rowOf(t.rows, 4), 2, 'row: a line between blocks goes to the next')
  equal(rowOf(t.rows, 99), 3, 'row: past the end, the last')
  equal(rowWithId(t.rows, 'intro-1'), 3, 'row: by heading id')
  equal(rowWithId(docTree('x[^1]\n\n[^1]: n\n').rows, 'user-content-fn-1'), 1, 'row: by an id inside a block')
  equal(rowWithId(t.rows, 'nope'), -1, 'row: no such id')
}

// Claude's row: before the first block it marks, inside a list as an item, and every other row left as it was
{
  const t = docTree('One.\n\n- a\n- b\n\nTwo.\n')
  const p = pointAt(t.rows, { start: 4, end: 4, label: 'L' })
  equal(p?.at, 1, 'point: the row holding the mark')
  const ul = p?.nodes[0]
  ok(!!ul && ul !== t.rows[1] && ul.type === 'element' && ul.children.some((c) => c.type === 'element' && c.tagName === 'li' && c.properties.dataPointed === 'L'), 'point: an item of the list, in a copy')
  ok(t.rows[1].type === 'element' && !t.rows[1].children.some((c) => c.type === 'element' && !!c.properties.dataPointed), 'point: the original row is untouched')
  const top = pointAt(t.rows, { start: 6, end: 6, label: 'L' })
  same(top?.nodes.map((n) => (n.type === 'element' ? n.tagName : n.type)), ['div', 'p'], 'point: a top-level row goes just before the block')
  equal(top?.nodes[1], t.rows[2], 'point: the marked block itself is not copied')
  equal(pointAt(t.rows, { start: 50, end: 60, label: 'L' }), null, 'point: nothing marked')
}

// A superseded parse never lands: a queued one is skipped, and an older answer resolves null
{
  const posted: string[] = []
  const answers: ((t: DocTree) => void)[] = []
  const parse = latestParse((text) => {
    posted.push(text)
    return new Promise((r) => answers.push(r))
  })
  const tree = (n: number): DocTree => ({ rows: [], weights: [n], keys: [] })
  const tick = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0))
  const a = parse('a')
  await tick()
  const b = parse('b')
  const c = parse('c')
  answers[0](tree(1))
  equal(await a, null, 'stale: an answer for a superseded text is dropped')
  equal(await b, null, 'stale: a queued text overtaken before its turn resolves null')
  await tick()
  answers[1](tree(3))
  same(await c, tree(3), 'stale: the newest text gets its tree')
  same(posted, ['a', 'c'], 'stale: the skipped text is never sent to the worker')
  const d = parse('d')
  await tick()
  answers[2](tree(4))
  same(await d, tree(4), 'stale: a lone parse resolves')
}

// A parse left to this thread that throws resolves empty, and the waiters after it still resolve
{
  const got: DocTree[] = []
  parseHere([{ text: 'boom', done: (t) => got.push(t) }, { text: '# ok', done: (t) => got.push(t) }], (t) => {
    if (t === 'boom') throw new Error('boom')
    return docTree(t)
  })
  same(got[0], { rows: [], weights: [], keys: [] }, 'fallback: a throwing parse resolves an empty tree')
  equal(got[1]?.rows.length, 1, 'fallback: the next waiter still gets its tree')
}

// The reader's top line follows its text through an edit
{
  // Two lines inserted at the top: old line 3 is new line 5.
  const map = Int32Array.from([0, 3, 4, 5])
  equal(movedLine(map, 3), 5, 'moved: a surviving line follows its text')
  // Old line 2 was rewritten: it lands just past line 1's new place.
  equal(movedLine(Int32Array.from([0, -1, 4]), 2), 2, 'moved: a changed line sits past the survivor above it')
  equal(movedLine(null, 7), 7, 'moved: no map keeps the number')
  equal(movedLine(Int32Array.from([-1, -1]), 2), 2, 'moved: nothing above survived')
}
