// Office: kinds, main's pre-flight over generated Word packages (bounds, encryption, damage, macros, the facts the
// Word view discloses, headings, picture descriptions, note marks), the Word text model, and the docx reference.
import { converted, converts, headingMap, preflight, rtfDeleted, sliceHtml, unreadable, wordXml, type Conversion } from '../src/main/surfaces/office.ts'
import { kindForPath } from '../src/shared/surfaces.ts'
import { isConvertedText, laysOut, TEXT_HTML_MAX, WORD_XML_MAX, type Flight } from '../src/shared/office.ts'
import { docxTail, isRefInput, parseRefs, refKey, refLabel, resourceOf, serializeContext, type RefInput } from '../src/shared/context.ts'
import { addedText, removalSpoken, shortLabel, spokenRef } from '../src/renderer/src/lib/refCopy.ts'
import { clip40, flatten, foldCase, foldMarks, locateIn, lowerRoman, matchesIn, megabytes, noteNumbers, occurrences, quoteIn, TEXT_CFG, textCss, textSegments, unconvertedFact, unpackDetail } from '../src/renderer/src/lib/docxView.ts'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import { docx, fixtures, ole, para, styled } from './support/docx-fixtures.mjs'
import { equal, ok } from './support/harness.mjs'

const reader = (b: Buffer) => async (offset: number, length: number): Promise<Buffer | null> => (offset > b.length ? null : b.subarray(offset, offset + length))
const fly = (name: string, b: Buffer) => preflight(`/w/${name}`, b.length, reader(b))
const fx = await fixtures()

// Kinds: every Office extension is a doc tab; .key stays a file; .ods a sheet.
{
  for (const e of ['docx', 'docm', 'doc', 'odt', 'rtf', 'pptx', 'pptm', 'ppt', 'odp', 'pdf']) equal(kindForPath(`/a/b.${e}`), 'doc', `kind: .${e} is doc`)
  equal(kindForPath('/a/server.key'), 'file', 'kind: .key stays a file')
  equal(kindForPath('/a/book.ods'), 'sheet', 'kind: .ods is a sheet')
  equal(kindForPath('/a/t.dotx'), 'file', 'kind: templates stay files')
}

// Pre-flight states.
{
  equal((await fly('empty.docx', fx['empty.docx'])).t, 'empty', 'flight: empty')
  equal((await fly('locked.docx', fx['locked.docx'])).t, 'locked', 'flight: an OLE package with EncryptionInfo is password protected')
  equal((await fly('locked.doc', fx['locked.doc'])).t, 'locked', 'flight: a .doc with fEncrypted is password protected')
  const m = await fly('macro.doc', fx['macro.doc'])
  ok(m.t === 'glimpse' && m.macros, 'flight: a .doc with a Macros storage glimpses with macros')
  const broken = await fly('broken.docx', fx['broken.docx'])
  ok(broken.t === 'damaged' && broken.as === 'word', 'flight: a truncated zip is a damaged Word document')
  equal((await fly('notzip.docx', fx['notzip.docx'])).t, 'damaged', 'flight: not a zip is damaged')
  const rtf = await fly('broken.rtf', fx['broken.rtf'])
  ok(rtf.t === 'damaged' && rtf.as === 'rtf', 'flight: an RTF without {\\rtf is damaged')
  const huge = await preflight('/w/huge.docx', 101 * 1024 * 1024, async () => null)
  ok(huge.t === 'too-large' && huge.bytes === 101 * 1024 * 1024, 'flight: over 100 MB is too large before any read')
  equal(JSON.stringify(await fly('bomb.docx', fx['bomb.docx'])), JSON.stringify({ t: 'unpacks', bound: 'ratio' }), 'flight: an entry over 200:1 is refused, saying which bound')
  const many = await JSZip.loadAsync(await docx({ body: para() }))
  for (let i = 0; i < 10_001; i++) many.file(`x/${i}`, '')
  const m1 = await fly('many.docx', await many.generateAsync({ type: 'nodebuffer' }))
  ok(m1.t === 'unpacks' && m1.bound === 'entries' && m1.n > 10_000, 'flight: over 10,000 entries is refused with the count')
  // One entry's unpacked size in the central directory set to 600 MiB: the bound reads the directory, never the data.
  const big = await JSZip.loadAsync(await docx({ body: para() }))
  big.file('word/media/big.bin', 'x'.repeat(1000))
  const zb = Buffer.from(await big.generateAsync({ type: 'nodebuffer', compression: 'STORE' }))
  for (let at = zb.indexOf(Buffer.from([0x50, 0x4b, 1, 2])); at >= 0; at = zb.indexOf(Buffer.from([0x50, 0x4b, 1, 2]), at + 4))
    if (zb.toString('utf8', at + 46, at + 46 + zb.readUInt16LE(at + 28)) === 'word/media/big.bin') zb.writeUInt32LE(600 * 1024 * 1024, at + 24), zb.writeUInt32LE(600 * 1024 * 1024, at + 20)
  const u1 = await fly('unzipped.docx', zb)
  ok(u1.t === 'unpacks' && u1.bound === 'unzipped' && u1.n > 600 * 1024 * 1024, `flight: over 512 MB unpacked is refused with the size (${JSON.stringify(u1)})`)
  const long = await fly('long.docx', fx['long.docx'])
  ok(long.t === 'glimpse' && long.xml === 1_000_001, 'flight: document.xml one byte over the cap glimpses with its size')
  equal((await fly('capped.docx', fx['capped.docx'])).t, 'word', 'flight: document.xml under the cap lays out')
  equal(await wordXml(fx['long.docx'].length, reader(fx['long.docx'])), WORD_XML_MAX + 1, 'flight: the size comes from the directory')
  const pptx = await fly('deck.pptx', await docx({ body: para() }))
  equal(pptx.t, 'damaged', 'flight: a .pptx with no presentation part is damaged')
}

// Word facts.
{
  const facts = async (name: string) => {
    const f = await fly(name, fx[name])
    if (f.t !== 'word') throw new Error(`${name} did not lay out: ${f.t}`)
    return f.facts
  }
  const plain = await facts('plain.docx')
  equal(plain.headings.docx_heading1, 1, 'facts: Heading 1 is level 1')
  equal(plain.headings.docx_clauseheading, 2, 'facts: a style based on Heading 2 is level 2')
  equal(plain.headings.docx_title, 1, 'facts: Title is 1')
  equal(plain.headings.docx_lookslikeheading, undefined, 'facts: a look-alike with no outline level is no heading')
  ok(!plain.macros && !plain.links && !plain.strict && !plain.comments, 'facts: plain discloses nothing extra')
  const media = await facts('media.docx')
  equal(media.charts, 1, 'facts: a chart with a fallback picture is not counted')
  equal(media.diagrams, 1, 'facts: SmartArt counts')
  equal(media.objects, 1, 'facts: the embedded object counts')
  ok(media.fonts, 'facts: embedded fonts')
  ok(media.links, 'facts: a linked picture is a link')
  equal(JSON.stringify(media.pictures.body), JSON.stringify(['Company logo', 'Logo title only', null, '', 'Linked picture', 'Chart fallback picture']), 'facts: picture alts by order, the fallback walked')
  const tracked = await facts('tracked.docx')
  ok(tracked.tracked.body && !tracked.tracked.footnotes, 'facts: tracked changes per part')
  equal(tracked.comments, 3, 'facts: three comments')
  ok((await facts('strict.docx')).strict, 'facts: Strict detected')
  ok(!(await facts('gdocs.docx')).strict, 'facts: a transitional file is not Strict')
  ok((await facts('macro.docm')).macros, 'facts: vbaProject.bin is macros')
  const notes = await facts('notes.docx')
  equal(JSON.stringify(notes.notes), JSON.stringify([{ part: 'footnotes', custom: false }, { part: 'footnotes', custom: false }, { part: 'footnotes', custom: true }, { part: 'endnotes', custom: false }, { part: 'footnotes', custom: false }]), 'facts: note references in order')
  ok((await facts('linked.docx')).links, 'facts: INCLUDETEXT and a linked picture are links')
  const clash = headingMap('<w:style w:type="paragraph" w:styleId="A.B"><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="A B"><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>')
  equal(clash['docx_a-b'], undefined, 'facts: two ids that collapse to one class with different levels are left out')
  const deleted = await fly('d.docx', await docx({ body: `<w:p><w:del w:id="1" w:author="A"><w:r><w:footnoteReference w:id="1"/></w:r></w:del></w:p>` + styled('Heading1', 'x') }))
  ok(deleted.t === 'word' && !deleted.facts.notes.length, 'facts: a deleted note reference is not drawn, so not listed')
  ok(ole(['EncryptionInfo']).length > 0, 'fixtures: OLE builds')
}

// The Word text model.
{
  const f = flatten([{ text: '  Scope  of\twork ' }, { text: 'Scope of work again' }, { text: '' }, { text: 'Café scope' }])
  equal(f.text, 'Scope of work Scope of work again Café scope', 'text: paragraphs collapsed and joined by one space')
  const q = quoteIn(f, { i: 1, off: 0 }, { i: 1, off: 13 })
  ok(!!q && q.text === 'Scope of work' && q.nth === 1 && q.first === 1 && q.last === 1, 'text: nth counts across the whole part')
  const at = locateIn(f, 'Scope of work', 1)
  ok(!!at && at.a.i === 1 && at.a.off === 0 && at.b.off === 13, 'text: the nth occurrence back to raw positions')
  equal(matchesIn(f, 'SCOPE', foldCase).length, 3, 'text: matching ignores case')
  equal(matchesIn(f, 'cafe', foldCase).length, 0, "text: Claude's matching keeps accents")
  equal(matchesIn(f, 'cafe', foldMarks).length, 1, 'find: ignores accents')
  equal(matchesIn(f, 'of   work', foldCase).length, 2, 'text: matching collapses spacing')
  equal(occurrences(f, 'again'), 1, 'text: occurrences')
  const span = quoteIn(f, { i: 0, off: 9 }, { i: 1, off: 5 })
  ok(!!span && span.text === 'of work Scope' && span.first === 0 && span.last === 1, 'text: a quote across paragraphs')
  const cut = locateIn(flatten([{ text: 'aaa bbb ccc ddd' }]), 'aaa [...] ddd', 0)
  ok(!!cut && cut.b.off === 15, 'text: an elided quote matches its start and end')
  equal(megabytes(1_000_001), '1.1', 'text: one byte over reads 1.1 MB')
  equal(megabytes(2_340_000), '2.4', 'text: MB rounds up')
  equal(clip40('a'.repeat(41)), `${'a'.repeat(40)}…`, 'text: 40 characters then …')
}

// The docx reference.
{
  const r: RefInput = { kind: 'docx', path: '/w/report.docx', sourceVersion: `sha256:${'a'.repeat(32)}`, part: 'body', blocks: { start: 3, end: 4 }, text: { quote: 'Scope of work', nth: 1 }, heading: 'Scope of work 1', tracked: true }
  ok(isRefInput(r), 'ref: a docx reference validates')
  ok(!isRefInput({ ...r, part: 'header' }), 'ref: a part outside body and notes is refused')
  ok(!isRefInput({ ...r, part: 'footnotes' }), 'ref: a heading is body only')
  equal(refLabel(r), 'report.docx · text under "Scope of work 1"', 'ref: label under a heading')
  equal(docxTail({ part: 'footnotes' }), 'footnote text', 'ref: a footnote')
  equal(refLabel({ ...r, heading: undefined }), 'report.docx · text', 'ref: label with no heading')
  equal(resourceOf({ ...r, id: 'r1' }), 'doc:/w/report.docx', "ref: shares the converted view's resource")
  ok(refKey(r) !== refKey({ ...r, text: { quote: 'Scope of work', nth: 0 } }), 'ref: nth is part of the key')
  equal(spokenRef(r), 'report.docx, text under Scope of work 1, "Scope of work"', 'ref: spoken')
  equal(shortLabel({ ...r, id: 'r1' }), 'under "Scope of work 1"', 'ref: short label')
  equal(addedText(r), 'Added text from report.docx to the message.', 'ref: added')
  ok(removalSpoken([{ ...r, id: 'r1' }], 'changed').startsWith('report.docx changed. Text under Scope of work 1 was'), 'ref: removal spoken')
  const wire = serializeContext([{ version: 1, ref: { ...r, id: 'r1' } }], 'hi', { packetId: null })
  ok(wire.includes("A Word reference quotes text from Clui's own layout of a .docx"), 'ref: the context header carries the Word sentence')
  const back = parseRefs(wire).refs[0]
  ok(back?.kind === 'current' && back.value.ref.kind === 'docx' && back.value.ref.text.nth === 1 && back.value.ref.tracked === true, 'ref: round-trips through the wire')
}

// Note numbers and the zip-bound copy.
{
  equal(JSON.stringify(noteNumbers([{ part: 'footnotes', custom: false }, { part: 'footnotes', custom: true }, { part: 'endnotes', custom: false }, { part: 'footnotes', custom: false }, { part: 'endnotes', custom: false }])), JSON.stringify([1, null, 1, 2, 2]), 'notes: footnotes run on across lists, endnotes count apart, a custom mark takes no number')
  equal(['i', 'ii', 'iv', 'ix', 'xiv', 'xl', 'mcmxcix'].join(), [1, 2, 4, 9, 14, 40, 1999].map(lowerRoman).join(), 'notes: endnote marks are lower roman')
  equal(unpackDetail({ bound: 'entries', n: 12_345 }), 'It has 12,345 internal parts, and Clui opens documents with up to 10,000.', 'unpacks: entries, with separators')
  equal(unpackDetail({ bound: 'unzipped', n: 512 * 1024 * 1024 + 1 }), 'It unpacks to 512.1 MB. Clui opens documents that unpack to 512 MB or less.', 'unpacks: just over the bound never reads 512.0')
  equal(unpackDetail({ bound: 'unzipped', n: 2000 * 1024 * 1024 }), 'It unpacks to 2,000.0 MB. Clui opens documents that unpack to 512 MB or less.', 'unpacks: thousands separators in MB')
  equal(unpackDetail({ bound: 'ratio' }), 'Part of it expands to over 200 times its saved size when unpacked, more than Clui opens.', 'unpacks: ratio')
}

// Converted text: routing, the pre-flight of .odt and .rtf, and what textutil's output becomes. textutil itself never
// runs here: the child_process stub stands in for it.
const lux = (n: string): Buffer => readFileSync(new URL(`./fixtures/textutil/${n}`, import.meta.url))
const odt = async (mimetype: string, content = '<office:document-content><office:body><office:text><text:p>Hi</text:p></office:text></office:body></office:document-content>'): Promise<Buffer> => {
  const z = new JSZip()
  z.file('mimetype', mimetype, { compression: 'STORE' })
  z.file('content.xml', content)
  z.file('META-INF/manifest.xml', '<manifest:manifest/>')
  return Buffer.from(await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
}
{
  for (const p of ['/a/r.docx', '/a/r.docm', '/a/n.odt', '/a/n.RTF']) ok(laysOut(p), `route: ${p} lays out`)
  for (const p of ['/a/r.doc', '/a/d.odp', '/a/d.pptx', '/a/s.ods']) ok(!laysOut(p), `route: ${p} does not lay out`)
  ok(isConvertedText('/a/n.odt') && !isConvertedText('/a/r.docx'), 'route: only .odt and .rtf convert')
  const t = await fly('notes.odt', lux('t.odt'))
  ok(t.t === 'text' && t.facts.as === 'opendocument' && !t.facts.tracked && !t.facts.macros, `route: a text .odt converts (${JSON.stringify(t)})`)
  const tr = await fly('tracked.odt', lux('tr.odt'))
  ok(tr.t === 'text' && tr.facts.tracked, 'route: an .odt with a changed region converts, tracked as accepted')
  equal(JSON.stringify(await fly('sheet.odt', await odt('application/vnd.oasis.opendocument.spreadsheet'))), JSON.stringify({ t: 'glimpse', macros: false }), 'route: an .odt with a spreadsheet mimetype glimpses')
  equal((await fly('deck.odp', await odt('application/vnd.oasis.opendocument.text'))).t, 'glimpse', 'route: a presentation never converts, whatever its mimetype')
  const bomb = await fly('bomb.odt', await odt('application/vnd.oasis.opendocument.text', `<x>${' '.repeat(2_000_000)}</x>`))
  ok(bomb.t === 'unpacks' && bomb.bound === 'ratio', 'route: an .odt over 200:1 is refused before textutil could inflate it')
}

// The \deleted gate: an .rtf with tracked changes glimpses, since textutil shows deleted text as ordinary text.
{
  equal(JSON.stringify(await fly('tr.rtf', lux('tr.rtf'))), JSON.stringify({ t: 'glimpse', macros: false, convert: { why: 'tracked' } }), 'rtf: \\deleted glimpses with its reason')
  equal(JSON.stringify(await fly('ok.rtf', Buffer.from('{\\rtf1\\ansi hello}'))), JSON.stringify({ t: 'text', facts: { as: 'rtf', macros: false, tracked: false } }), 'rtf: a clean RTF converts')
  equal((await fly('w.rtf', Buffer.from('{\\rtf1 \\deletedfoo x}'))).t, 'text', 'rtf: a longer control word is not \\deleted')
  const pad = Buffer.from(`{\\rtf1 ${'x'.repeat(60)}\\deleted y}`)
  equal(await rtfDeleted(pad.length, reader(pad), 64), true, 'rtf: a control word split across two reads is found')
  equal(await rtfDeleted(pad.length, async () => null, 64), null, 'rtf: a failed read is no answer')
  equal((await fly('lit.rtf', Buffer.from(String.raw`{\rtf1 \\deleted x}`))).t, 'text', 'rtf: an escaped backslash before deleted is text')
  equal(JSON.stringify(await fly('esc.rtf', Buffer.from(String.raw`{\rtf1 \\\deleted x}`))), JSON.stringify({ t: 'glimpse', macros: false, convert: { why: 'tracked' } }), 'rtf: an escaped backslash then \\deleted is tracked')
  const cut = Buffer.from(String.raw`{\rtf1 ${'x'.repeat(40)}\\deleted ${'x'.repeat(30)}}`)
  equal(await rtfDeleted(cut.length, reader(cut), 64), false, 'rtf: literal text split before its second backslash is not tracked')
  const tail = Buffer.from(String.raw`{\rtf1 ${'x'.repeat(49)}\deletedfoo ${'x'.repeat(30)}}`)
  equal(await rtfDeleted(tail.length, reader(tail), 64), false, 'rtf: a longer word cut after deleted is not tracked')
  equal((await preflight('/w/x.rtf', pad.length, async (o: number, l: number) => (o === 0 && l === 8 ? pad.subarray(0, 8) : null))).t, 'damaged', 'rtf: a read that fails mid-scan is damaged')
}

// The converter: argv, the private copy, and an outcome read from the output alone.
{
  const dir = mkdtempSync(join(tmpdir(), 'clui-convert-'))
  const calls: { file: string; args: string[]; cwd: string; copy: Buffer }[] = []
  let act: (out: string) => { killed?: true; code?: string } | null = () => null
  const g = globalThis as { __execFile__?: unknown }
  g.__execFile__ = (file: string, args: string[], opts: { cwd: string; timeout: number; killSignal: string }, done: (e: unknown) => void) => {
    calls.push({ file, args, cwd: opts.cwd, copy: readFileSync(args[8]) })
    const e = act(args[7])
    queueMicrotask(() => done(e))
  }
  const html = lux('t.odt.html')
  const c = converts(dir, '/usr/bin/textutil')
  const doc = lux('t.odt')
  const get = (rev: string, b = doc): Promise<Conversion> => c.get('/w/notes.odt', rev, b.length, reader(b))
  act = (out) => (writeFileSync(out, html), null)
  const good = await get('r1')
  ok(good.ok && good.blocks.length === 7 && good.css.includes('p.p1'), `convert: the writer's output becomes css and blocks (${JSON.stringify(good).slice(0, 80)})`)
  const [first] = calls
  equal(first.file, '/usr/bin/textutil', 'convert: textutil by absolute path')
  equal(JSON.stringify(first.args.slice(0, 7)), JSON.stringify(['-convert', 'html', '-noload', '-nostore', '-prefixspaces', '2', '-output']), 'convert: argv exactly, and never -excludedelements')
  ok(first.args[7] === join(first.cwd, 'out.html') && first.args[8] === join(first.cwd, 'copy.odt') && first.cwd.startsWith(dir), 'convert: copy and output in the job dir, which is the cwd')
  ok(first.copy.equals(doc), 'convert: textutil reads a private copy of the bytes at the revision')
  equal(readdirSync(dir).length, 0, 'convert: the job dir is gone after the run')
  ok((await get('r1')) === good && calls.length === 1, 'convert: a revision converts once')
  act = () => ({ code: 'EXIT' })
  equal(JSON.stringify(await get('r2')), JSON.stringify({ ok: false, why: 'failed' }), 'convert: no output is failed, whatever the exit')
  act = (out) => (writeFileSync(out, html), { code: 'EXIT' })
  ok((await get('r3')).ok, 'convert: the exit code is ignored when there is output')
  act = (out) => (writeFileSync(out, ''), null)
  equal(JSON.stringify(await get('r4')), JSON.stringify({ ok: false, why: 'failed' }), 'convert: an empty output is failed')
  const n = calls.length
  equal(JSON.stringify(await get('r4')), JSON.stringify({ ok: false, why: 'failed' }), 'convert: a failed revision stays failed')
  equal(calls.length, n, 'convert: and is not tried again')
  act = (out) => (writeFileSync(out, Buffer.alloc(TEXT_HTML_MAX + 1, 32)), null)
  equal(JSON.stringify(await get('r5')), JSON.stringify({ ok: false, why: 'too-long', bytes: TEXT_HTML_MAX + 1 }), 'convert: over the cap is too long, with its size')
  act = () => ({ killed: true })
  equal(JSON.stringify(await get('r6')), JSON.stringify({ ok: false, why: 'timeout' }), 'convert: killed by the timeout')
  act = () => ({ code: 'ENOENT' })
  equal(JSON.stringify(await get('r7')), JSON.stringify({ ok: false, why: 'missing' }), 'convert: no textutil')
  act = (out) => (writeFileSync(out, '<html><body>\n<p>&nbsp; </p>\n</body></html>'), null)
  equal(JSON.stringify(await get('r8')), JSON.stringify({ ok: false, why: 'no-text' }), 'convert: nothing but spaces is no text')
  equal(JSON.stringify(await c.get('/w/notes.odt', 'r9', doc.length, async () => null)), JSON.stringify({ ok: false, why: 'changed' }), 'convert: a copy that fails to read is changed')
  act = (out) => (writeFileSync(out, html), null)
  const before = calls.length
  const [a1, a2] = await Promise.all([get('r10'), get('r10')])
  ok(a1 === a2 && calls.length === before + 1, 'convert: two asks while running share one run')
  ok(!existsSync(join(dir, 'copy.odt')) && readdirSync(dir).length === 0, 'convert: nothing is left behind')
  delete g.__execFile__

  const f: Extract<Flight, { t: 'text' }> = { t: 'text', facts: { as: 'rtf', macros: true, tracked: false } }
  equal(JSON.stringify(converted(f, { ok: false, why: 'failed' })), JSON.stringify({ t: 'damaged', as: 'rtf', converting: true }), 'flight: failed is Couldn\'t convert')
  equal(JSON.stringify(converted(f, { ok: false, why: 'too-long', bytes: 9 })), JSON.stringify({ t: 'glimpse', macros: true, convert: { why: 'too-long', bytes: 9 } }), 'flight: too long glimpses with its size')
  equal(JSON.stringify(converted(f, { ok: false, why: 'missing' })), JSON.stringify({ t: 'glimpse', macros: true }), 'flight: no textutil is the plain glimpse')
  equal(converted(f, { ok: false, why: 'changed' }), null, 'flight: changed has no flight')
  equal(converted(f, { ok: true, css: '', blocks: ['<p>x</p>'] }), f, 'flight: a conversion keeps the text flight')
}

// Slicing, the sheet rebuild, segments and the sanitizer's allowlist.
{
  const sl = sliceHtml(lux('t.odt.html').toString('utf8'))
  ok(typeof sl !== 'string' && sl.blocks[0] === '<p class="p1">Scope of work</p>' && sl.blocks.every((b) => b.startsWith('<p ')), 'slice: one block per top-level element')
  equal(sliceHtml('<html><head></head></html>'), 'failed', 'slice: no body is failed')
  equal(JSON.stringify(sliceHtml('<body>\n<ul class="ul1">\n  <li class="li1">a</li>\n  <ul class="ul2">\n    <li class="li2">b</li>\n  </ul>\n</ul>\n<p>c</p>\n</body>')), JSON.stringify({ css: '', blocks: ['<ul class="ul1">\n  <li class="li1">a</li>\n  <ul class="ul2">\n    <li class="li2">b</li>\n  </ul>\n</ul>', '<p>c</p>'] }), 'slice: indented children stay with their top-level element')
  const css = textCss([
    { selector: 'p.p1', decls: [['margin-top', '0px'], ['font-size', '12.0px'], ['font-family', '"x12px"'], ['position', 'fixed'], ['background-image', 'url("https://e.x/a.png")'], ['background-color', 'url(https://e.x)'], ['border-image-source', 'none'], ['color', 'rgb(0, 0, 0)'], ['text-indent', '-18.0px']] },
    { selector: ':host', decls: [['color', 'red']] },
    { selector: 'p', decls: [['color', 'red']] },
    { selector: 'p.p1 a', decls: [['color', 'red']] },
    { selector: 'div.d1', decls: [['color', 'red']] },
    { selector: 'li.li12', decls: [['list-style-type', 'disc'], ['content', '"x"']] },
    { selector: 'td.td1', decls: [['position', 'absolute']] }
  ])
  equal(css, 'p.p1 { margin-top: 0pt; font-size: 12.0pt; font-family: "x12px"; color: rgb(0, 0, 0); text-indent: -18.0pt }\nli.li12 { list-style-type: disc }', 'sheet: class rules only, safe properties only, no url(, px as pt')
  ok(!css.includes('url(') && !css.includes(':host') && !css.includes('position'), 'sheet: nothing that loads or escapes')
  const segs = textSegments([...Array.from({ length: 40 }, () => '<p class="p1">x</p>'), '<ul class="ul1">\n  <li class="li1">a</li>\n  <li class="li1">b</li>\n</ul>'])
  ok(segs.length === 2 && segs[0].h === 40 * 22 && segs[1].h === 2 * 22, 'segments: 40 blocks each, sized by paragraphs and list items')
  for (const tag of ['img', 'svg', 'style', 'math', 'script', 'iframe', 'object', 'embed', 'link', 'video', 'audio', 'source', 'picture', 'form', 'input', 'image'])
    ok(!TEXT_CFG.ALLOWED_TAGS.includes(tag), `sanitize: no ${tag}`)
  for (const at of ['style', 'src', 'srcset', 'id', 'xlink:href', 'background']) ok(!TEXT_CFG.ALLOWED_ATTR.includes(at), `sanitize: no ${at} attribute`)
  ok(!TEXT_CFG.ALLOW_DATA_ATTR && !TEXT_CFG.ALLOW_ARIA_ATTR && TEXT_CFG.RETURN_DOM_FRAGMENT, 'sanitize: no data or aria attributes, a fragment back')
  equal(unconvertedFact({ why: 'tracked' }), "It has tracked changes, and Clui's view would show deleted text as if it were still there.", 'glimpse: tracked .rtf reason')
  equal(unconvertedFact({ why: 'too-long', bytes: TEXT_HTML_MAX + 1 }), 'Clui lays out converted documents with up to 1 MB of text and formatting, and this one has 1.1 MB.', 'glimpse: too long rounds up')
}

// The converted reference.
{
  const r: RefInput = { kind: 'docx', path: '/w/notes.odt', sourceVersion: `sha256:${'b'.repeat(32)}`, part: 'body', blocks: { start: 2, end: 2 }, text: { quote: 'Scope', nth: 0 }, tracked: true, via: 'textutil' }
  ok(isRefInput(r), 'via: a converted reference validates')
  ok(!isRefInput({ ...r, via: 'soffice' } as unknown as RefInput), 'via: only textutil')
  equal(refLabel(r), 'notes.odt · text', 'via: label')
  equal(spokenRef(r), 'notes.odt, text, "Scope"', 'via: spoken')
  const wire = serializeContext([{ version: 1, ref: { ...r, id: 'r1' } }], 'hi', { packetId: null })
  ok(wire.includes('A Word reference with via textutil quotes an .odt or .rtf file as macOS converted it'), 'via: the header explains the conversion')
  const back = parseRefs(wire).refs[0]
  ok(back?.kind === 'current' && back.value.ref.kind === 'docx' && back.value.ref.via === 'textutil', 'via: round-trips through the wire')
  ok(!serializeContext([{ version: 1, ref: { ...r, via: undefined, id: 'r1' } }], 'hi', { packetId: null }).includes('via textutil'), 'via: a .docx reference has no conversion sentence')
}

// Quick Look's dark first pages: a page whose edge is dark and whose brightest pixels don't stand off it is unreadable.
{
  const page = (bg: number, ink: number): Uint8Array => {
    const w = 100
    const h = 140
    const px = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = x > 10 && x < 90 && y > 10 && y < 130 && y % 6 < 2 ? ink : bg
        px.set([v, v, v, 255], (y * w + x) * 4)
      }
    }
    return px
  }
  ok(unreadable(page(30, 0), 100, 140, 2), 'glimpse: a dark page with black text is unreadable')
  ok(!unreadable(page(255, 0), 100, 140, 2), 'glimpse: a white page is readable')
  ok(!unreadable(page(30, 255), 100, 140, 2), 'glimpse: a dark cover with white text is readable')
  ok(!unreadable(page(128, 0), 100, 140, 2), 'glimpse: a mid-grey page with black text is readable')
}
