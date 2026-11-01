// Office: kinds, main's pre-flight over generated Word packages (bounds, encryption, damage, macros, the facts the
// Word view discloses, headings, picture descriptions, note marks), the Word text model, and the docx reference.
import { headingMap, preflight, wordXml } from '../src/main/surfaces/office.ts'
import { kindForPath } from '../src/shared/surfaces.ts'
import { WORD_XML_MAX } from '../src/shared/office.ts'
import { docxTail, isRefInput, parseRefs, refKey, refLabel, resourceOf, serializeContext, type RefInput } from '../src/shared/context.ts'
import { addedText, removalSpoken, shortLabel, spokenRef } from '../src/renderer/src/lib/refCopy.ts'
import { clip40, flatten, foldCase, foldMarks, locateIn, lowerRoman, matchesIn, megabytes, noteNumbers, occurrences, quoteIn, unpackDetail } from '../src/renderer/src/lib/docxView.ts'
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
  equal((await fly('ok.rtf', Buffer.from('{\\rtf1\\ansi hello}'))).t, 'glimpse', 'flight: an RTF glimpses')
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
