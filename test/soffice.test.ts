// LibreOffice: discovery, the converter driven through a fake soffice script (argv, profile, cache key, queue of one,
// timeout and Stop with cleanup, shared jobs), and the pre-flight facts a conversion needs (magic, encryption, links,
// hidden slides, linked sheets).
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { findSoffice, IMPRESS_PDF, pdfPages, soffices, versionOf, type ConvertAsk } from '../src/main/surfaces/soffice.ts'
import { odpSlides, preflight, pptxSlides } from '../src/main/surfaces/office.ts'
import type { LoState } from '../src/shared/office.ts'
import { ole } from './support/docx-fixtures.mjs'
import { equal, ok } from './support/harness.mjs'

// The stub stands in for child_process everywhere else; these runs need the real one to drive the fake script.
const real = process.getBuiltinModule('node:child_process') as typeof import('node:child_process')
const g = globalThis as { __execFile__?: unknown }
g.__execFile__ = (file: string, args: string[], opts: object, done: (e: unknown, out: string) => void) => real.execFile(file, args, opts, done)

const root = realpathSync(mkdtempSync(join(tmpdir(), 'clui-lo-')))
const reader = (b: Buffer) => async (offset: number, length: number): Promise<Buffer | null> => (offset > b.length ? null : b.subarray(offset, offset + length))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Discovery: the app bundle first; a PATH hit only when it resolves to a Mach-O, so Homebrew's bash wrapper never counts.
{
  const d = join(root, 'find')
  const bin = join(d, 'bin')
  const cask = join(d, 'cask')
  mkdirSync(bin, { recursive: true })
  mkdirSync(cask, { recursive: true })
  writeFileSync(join(cask, 'soffice'), '#!/bin/bash\nexec /Applications/LibreOffice.app/Contents/MacOS/soffice "$@"\n', { mode: 0o755 })
  symlinkSync(join(cask, 'soffice'), join(bin, 'soffice'))
  const none = join(d, 'none', 'soffice')
  equal(await findSoffice(join(d, 'home'), bin, none), null, 'discovery: a bash wrapper on PATH is never taken')
  const mach = join(d, 'macho')
  mkdirSync(mach)
  writeFileSync(join(mach, 'soffice-real'), Buffer.from('cffaedfe07000001', 'hex'), { mode: 0o755 })
  const link = join(d, 'link')
  mkdirSync(link)
  symlinkSync(join(mach, 'soffice-real'), join(link, 'soffice'))
  equal(await findSoffice(join(d, 'home'), `${bin}:${link}`, none), join(mach, 'soffice-real'), 'discovery: a PATH link resolves to the Mach-O it points at')
  const app = join(d, 'App', 'soffice')
  mkdirSync(join(d, 'App'))
  writeFileSync(app, '', { mode: 0o755 })
  equal(await findSoffice(join(d, 'home'), link, app), app, 'discovery: the app bundle comes before PATH')
  equal(versionOf('LibreOffice 26.8.2.2 9dea406ab7695df6325b11b0e19fdca8db4b7276\n'), '26.8.2.2', 'discovery: the version is the second token, never the hash')
  equal(pdfPages(Buffer.from('1 0 obj<</Type/Pages/Count 2/Kids[2 0 R 3 0 R]>>endobj 2 0 obj<</Type /Page>>endobj 3 0 obj<</Type/Page/Parent 1 0 R>>endobj')), 2, 'mismatch: pages are counted from their dictionaries, not the tree')
  equal(versionOf('Error\n'), null, 'discovery: no version, no converter')
}

// A fake soffice: --version answers with FAKE_LO_VERSION; a conversion logs its argv, then behaves per FAKE_LO_MODE.
const fake = join(root, 'soffice')
const log = join(root, 'log')
const pdf = join(root, 'fixture.pdf')
writeFileSync(pdf, '%PDF-1.4\n%fake\n')
writeFileSync(
  fake,
  `#!/bin/bash
for a in "$@"; do [ "$a" = "--version" ] && { echo "LibreOffice \${FAKE_LO_VERSION:-7.6.1.2} deadbeef"; exit 0; }; done
out=""; to=""; prev=""; last=""
for a in "$@"; do [ "$prev" = "--outdir" ] && out="$a"; [ "$prev" = "--convert-to" ] && to="$a"; prev="$a"; last="$a"; done
b=$(basename "$last"); ext="\${to%%:*}"
printf '%s\\n' "start $b $*" >> "${log}"
case "\${FAKE_LO_MODE:-ok}" in
  ok) sleep "\${FAKE_LO_SLEEP:-0}"; cp "${pdf}" "$out/\${b%.*}.$ext";;
  fail) exit 1;;
  nopdf) ;;
  hang) touch "$out/.~lock.$b#" "$out/lu1234.tmp"; exec sleep 30;;
esac
printf '%s\\n' "end $b" >> "${log}"
`,
  { mode: 0o755 }
)
const runs = (): string[] => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('start ')) : [])
const env = (mode: string, extra: Record<string, string> = {}): void => {
  process.env.FAKE_LO_MODE = mode
  delete process.env.FAKE_LO_SLEEP
  Object.assign(process.env, extra)
}
const ask = (path: string, bytes: Buffer, revision: string, more: Partial<ConvertAsk> = {}): ConvertAsk => ({ path, revision, size: bytes.length, read: reader(bytes), to: 'pdf', slides: false, ...more })
const doc = Buffer.from('PK\x03\x04 a document')
const dir = join(root, 'lo')
let lo = soffices({ dir, home: root, seam: fake })
const noop = (): void => {}

{
  env('ok')
  const found = await lo.find()
  equal(found?.version, '7.6.1.2', 'converter: the seam names the soffice to run')
  ok(!existsSync(join(dir, 'profile')), 'converter: --version creates no profile')
  const r = await lo.convert(ask('/w/report.docx', doc, 'r1'), 't1', noop)
  ok(r.ok && r.by === 'LibreOffice 7.6.1.2', `converter: a conversion names its converter (${JSON.stringify(r)})`)
  ok(r.ok && r.version === `sha256:${createHash('sha256').update(doc).digest('hex').slice(0, 32)}`, 'converter: the version hashes the bytes it read')
  ok(r.ok && !!r.file && readFileSync(r.file, 'utf8').startsWith('%PDF'), 'converter: the PDF lands in the cache')
  const argv = runs()[0]?.split(' ').slice(2) ?? []
  ok(/^-env:UserInstallation=file:\/\/\/.+\/lo\/profile$/.test(argv[0]), `converter: Clui's own profile (${argv[0]})`)
  equal(JSON.stringify(argv.slice(1, 8)), JSON.stringify(['--headless', '--norestore', '--nologo', '--nodefault', '--nolockcheck', '--convert-to', 'pdf']), 'converter: argv exactly, no shell')
  ok(argv[8] === '--outdir' && argv[9].startsWith(join(dir, 'jobs')) && argv[10].endsWith('/doc.docx') && argv[10].startsWith('/'), 'converter: an absolute private copy, a fresh outdir')
  const xcu = readFileSync(join(dir, 'profile/user/registrymodifications.xcu'), 'utf8')
  ok(xcu.includes('Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>0<') && xcu.includes('DisableMacrosExecution') && !xcu.includes('SecureURL'), 'converter: the profile is locked down before the first run')
  equal(readdirSync(join(dir, 'jobs')).length, 0, 'converter: the job dir is gone after the run')

  const hit = await lo.convert(ask('/w/report.docx', doc, 'r2'), 't2', noop)
  ok(hit.ok && runs().length === 1, 'cache: the same bytes at a new revision are a hit, with no spawn')
  const other = await lo.convert(ask('/w/report.docx', Buffer.from('PK\x03\x04 a documenu'), 'r3'), 't3', noop)
  ok(other.ok && runs().length === 2, 'cache: same size, different bytes is a miss')
  await lo.convert(ask('/w/report.docx', doc, 'r4', { fresh: true }), 't4', noop)
  equal(runs().length, 3, 'cache: fresh skips the cached derivative')

  lo = soffices({ dir, home: root, seam: fake })
  const restart = await lo.convert(ask('/w/report.docx', doc, 'r5'), 't5', noop)
  ok(restart.ok && runs().length === 3, 'cache: a restart still hits')
  env('ok', { FAKE_LO_VERSION: '7.6.2.1' })
  lo = soffices({ dir, home: root, seam: fake })
  const upgraded = await lo.convert(ask('/w/report.docx', doc, 'r6'), 't6', noop)
  ok(upgraded.ok && upgraded.by === 'LibreOffice 7.6.2.1' && runs().length === 4, 'cache: a new converter version is a miss')
  delete process.env.FAKE_LO_VERSION
  lo = soffices({ dir, home: root, seam: fake })

  const deck = await lo.convert(ask('/w/deck.pptx', doc, 'r7', { slides: true }), 't7', noop)
  ok(deck.ok && runs().length === 5 && runs()[4].includes(IMPRESS_PDF), 'converter: a presentation exports hidden slides, and the filter is part of the key')
  const book = await lo.convert(ask('/w/book.ods', doc, 'r8', { to: 'xlsx' }), 't8', noop)
  ok(book.ok && book.file!.endsWith('.xlsx') && runs()[5].includes('--convert-to xlsx'), 'converter: an .ods converts to XLSX')

  env('fail')
  equal(JSON.stringify(await lo.convert(ask('/w/x.docx', Buffer.from('PK1'), 'f1'), 'f1', noop)), JSON.stringify({ ok: false, why: 'failed' }), 'converter: a non-zero exit is failed')
  env('nopdf')
  equal(JSON.stringify(await lo.convert(ask('/w/x.docx', Buffer.from('PK2'), 'f2'), 'f2', noop)), JSON.stringify({ ok: false, why: 'failed' }), 'converter: exit 0 without the PDF is failed')
  equal(JSON.stringify(await lo.convert({ ...ask('/w/x.docx', Buffer.from('PK3'), 'f3'), read: async () => null }, 'f3', noop)), JSON.stringify({ ok: false, why: 'changed' }), 'converter: a copy that fails to read is changed')
  const gone = soffices({ dir: join(root, 'lo2'), home: root, seam: join(root, 'nope') })
  equal(JSON.stringify(await gone.convert(ask('/w/x.docx', doc, 'm1'), 'm1', noop)), JSON.stringify({ ok: false, why: 'missing' }), 'converter: no soffice is missing')
}

// Queue of one: a second conversion waits, naming the one running, and the two never overlap.
{
  env('ok', { FAKE_LO_SLEEP: '0.4' })
  rmLog()
  const states: LoState[] = []
  const a = lo.convert(ask('/w/first.docx', Buffer.from('PKq1'), 'q1'), 'qa', noop)
  await sleep(50)
  const b = lo.convert(ask('/w/second.docx', Buffer.from('PKq2'), 'q2'), 'qb', (s) => states.push(s))
  const [ra, rb] = await Promise.all([a, b])
  ok(ra.ok && rb.ok, 'queue: both convert')
  ok(states[0]?.t === 'waiting' && states[0].other === 'first.docx', `queue: the second waits, naming the first (${JSON.stringify(states)})`)
  ok(states[1]?.t === 'running', 'queue: then runs')
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ').slice(0, 2).join(' '))
  equal(JSON.stringify(lines), JSON.stringify(['start doc.docx', 'end doc.docx', 'start doc.docx', 'end doc.docx']), 'queue: one at a time')
}

// Timeout and Stop: the process is killed and the job dir, with soffice's lock and temp files, goes.
{
  env('hang')
  const quick = soffices({ dir, home: root, seam: fake, timeoutMs: 400 })
  const t0 = Date.now()
  equal(JSON.stringify(await quick.convert(ask('/w/slow.docx', Buffer.from('PKh1'), 'h1'), 'h1', noop)), JSON.stringify({ ok: false, why: 'timeout' }), 'timeout: a hung run times out')
  ok(Date.now() - t0 < 5000, 'timeout: killed, not waited out')
  equal(readdirSync(join(dir, 'jobs')).length, 0, 'timeout: the lock and temp files go with the job dir')

  const p = lo.convert(ask('/w/shared.docx', Buffer.from('PKh2'), 'h2'), 'tabA', noop)
  const p2 = lo.convert(ask('/w/shared.docx', Buffer.from('PKh2'), 'h2'), 'tabB', noop)
  ok(p === p2, 'jobs: a second tab joins the running job')
  await sleep(300)
  lo.stop('tabA')
  const still = await Promise.race([p.then(() => 'done'), sleep(300).then(() => 'running')])
  equal(still, 'running', 'jobs: Stop on one of two tabs leaves the job running')
  lo.stop('tabB')
  const t1 = Date.now()
  equal(JSON.stringify(await p), JSON.stringify({ ok: false, why: 'stopped' }), 'jobs: the last Stop cancels it')
  ok(Date.now() - t1 < 2000, 'jobs: and kills soffice')
  equal(readdirSync(join(dir, 'jobs')).length, 0, 'jobs: nothing is left behind')

  const blocker = lo.convert(ask('/w/one.docx', Buffer.from('PKh3'), 'h3'), 'b1', noop)
  await sleep(100)
  const waiting = lo.convert(ask('/w/two.docx', Buffer.from('PKh4'), 'h4'), 'b2', noop)
  await sleep(100)
  lo.stop('b2')
  equal(JSON.stringify(await waiting), JSON.stringify({ ok: false, why: 'stopped' }), 'jobs: Stop while waiting leaves the queue')
  lo.stop('b1')
  await blocker
}

function rmLog(): void {
  writeFileSync(log, '')
}

// Pre-flight with LibreOffice: every gate before the converter, and the facts it discloses.
{
  const fly = (name: string, b: Buffer) => preflight(`/w/${name}`, b.length, reader(b), true)
  const zip = async (files: Record<string, string>): Promise<Buffer> => {
    const z = new JSZip()
    for (const [n, c] of Object.entries(files)) z.file(n, c)
    return Buffer.from(await z.generateAsync({ type: 'nodebuffer' }))
  }
  equal((await fly('e.docx', Buffer.alloc(0))).t, 'empty', 'lo flight: empty never converts')
  equal((await fly('g.docx', Buffer.from('garbage bytes, not a zip at all'))).t, 'damaged', 'lo flight: garbage named .docx is damaged, since soffice would convert it')
  equal((await fly('g.rtf', Buffer.from('plain text'))).t, 'damaged', 'lo flight: an RTF without {\\rtf is damaged')
  equal((await fly('t.rtf', Buffer.from('{\\rtf1 {\\deleted x}}'))).t, 'convert', 'lo flight: an RTF with tracked changes converts')
  equal((await fly('l.docx', ole(['EncryptionInfo', 'EncryptedPackage']))).t, 'locked', 'lo flight: encrypted OOXML never reaches soffice')
  equal((await fly('l.ppt', ole(['PowerPoint Document', 'EncryptedSummary']))).t, 'locked', 'lo flight: an encrypted .ppt never reaches soffice')
  const m = await fly('m.doc', ole(['WordDocument', '1Table', 'Macros']))
  ok(m.t === 'convert' && m.facts.macros && !m.facts.links, 'lo flight: a .doc with macros converts, links not claimed')
  const types = '<Types/>'
  const linked = await fly('linked.docx', await zip({ '[Content_Types].xml': types, 'word/document.xml': '<w:document/>', 'word/_rels/document.xml.rels': '<Relationships><Relationship Id="r1" Type="http://x/image" Target="file:///tmp/a.png" TargetMode="External"/></Relationships>' }))
  ok(linked.t === 'convert' && linked.facts.links, 'lo flight: an external image is a link')
  const href = await fly('href.docx', await zip({ '[Content_Types].xml': types, 'word/document.xml': '<w:document/>', 'word/_rels/document.xml.rels': '<Relationships><Relationship Id="r1" Type="http://x/hyperlink" Target="https://a" TargetMode="External"/></Relationships>' }))
  ok(href.t === 'convert' && !href.facts.links, 'lo flight: a hyperlink is not a link')
  const slide = (show?: string): string => `<p:sld${show ? ` show="${show}"` : ''}><p:cSld/></p:sld>`
  const pptx = await zip({
    '[Content_Types].xml': types,
    'ppt/presentation.xml': '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/><p:sldId id="258" r:id="rId4"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId2" Target="slides/slide3.xml"/><Relationship Id="rId3" Target="slides/slide1.xml"/><Relationship Id="rId4" Target="/ppt/slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide1.xml': slide('0'),
    'ppt/slides/slide2.xml': slide(),
    'ppt/slides/slide3.xml': slide('1'),
    'ppt/vbaProject.bin': 'x'
  })
  const deck = await fly('deck.pptm', pptx)
  ok(deck.t === 'convert' && JSON.stringify(deck.facts.slides) === JSON.stringify({ count: 3, hidden: [2] }) && deck.facts.macros, `lo flight: slides in sldIdLst order, hidden by show="0" (${JSON.stringify(deck)})`)
  equal(await pptxSlides(async (n) => (n === 'ppt/presentation.xml' ? '<p:presentation><p:sldIdLst><p:sldId r:id="rX"/></p:sldIdLst></p:presentation>' : null)), null, 'lo flight: a listed slide with no part is unreadable')
  const odp = odpSlides(
    '<office:automatic-styles><style:style style:name="dp2" style:family="drawing-page"><style:drawing-page-properties presentation:visibility="hidden"/></style:style></office:automatic-styles><draw:page draw:name="a" draw:style-name="dp1"/><draw:page draw:name="b" draw:style-name="dp2"/><draw:page draw:name="c" presentation:visibility="hidden"/>'
  )
  equal(JSON.stringify(odp), JSON.stringify({ count: 3, hidden: [2, 3] }), 'lo flight: an .odp hides a slide by its page style or its own attribute')
  const ods = await zip({
    mimetype: 'application/vnd.oasis.opendocument.spreadsheet',
    'content.xml': '<table:table table:name="A"><table:table-row/></table:table><table:table table:name="B"><table:table-source xlink:href="../other.ods"/></table:table>',
    'META-INF/manifest.xml': '<manifest:manifest/>'
  })
  const book = await fly('book.ods', ods)
  ok(book.t === 'convert' && book.facts.linkedSheets === 1 && book.facts.links, 'lo flight: an .ods counts its linked sheets')
  equal((await preflight('/w/book.ods', ods.length, reader(ods), false)).t, 'needs-lo', 'lo flight: an .ods without LibreOffice needs it')
  const lockedOds = await zip({ 'content.xml': '<x/>', 'META-INF/manifest.xml': '<manifest:encryption-data/>' })
  equal((await preflight('/w/book.ods', lockedOds.length, reader(lockedOds), false)).t, 'locked', 'lo flight: an encrypted .ods is locked with or without LibreOffice')
  const odt = await fly('pic.odt', await zip({ 'content.xml': '<draw:frame><draw:image xlink:href="Pictures/a.png"/></draw:frame><draw:image xlink:href="file:///tmp/b.png"/>', 'META-INF/manifest.xml': '' }))
  ok(odt.t === 'convert' && odt.facts.links, 'lo flight: an ODF picture outside the package is a link')
  const own = await fly('own.odt', await zip({ 'content.xml': '<draw:image xlink:href="Pictures/a.png"/><draw:object xlink:href="./Object 1"/>', 'META-INF/manifest.xml': '' }))
  ok(own.t === 'convert' && !own.facts.links, "lo flight: the package's own pictures and objects aren't links")
}

// References into converted pages: the original's path and version, the converter, slides and hidden slides.
{
  const { isRefInput, parseRefs, refKey, refLabel, serializeContext } = await import('../src/shared/context.ts')
  const { spokenRef, shortLabel } = await import('../src/renderer/src/lib/refCopy.ts')
  type Ref = Parameters<typeof refLabel>[0]
  const v = `sha256:${'a'.repeat(32)}` as const
  const slide: Ref = { kind: 'doc', path: '/w/deck.pptx', sourceVersion: v, pages: 30, page: 12, text: { quote: 'Q3 revenue', nth: 0 }, converted: { by: 'LibreOffice 26.8.2.2', unit: 'slide', hidden: true } }
  const page: Ref = { kind: 'doc', path: '/w/report.docx', sourceVersion: v, pages: 10, page: 3, text: { quote: 'Scope', nth: 0 }, converted: { by: 'LibreOffice 26.8.2.2', unit: 'page' } }
  ok(isRefInput(slide) && isRefInput(page), 'ref: converted doc references validate')
  ok(!isRefInput({ ...page, converted: { by: 'LibreOffice 26.8.2.2', unit: 'page', hidden: true } } as Ref), 'ref: only a slide can be hidden')
  ok(!isRefInput({ ...page, converted: { by: 'Word', unit: 'page' } } as Ref), 'ref: by names LibreOffice and its version')
  ok(refKey(page) !== refKey({ ...page, converted: { by: 'LibreOffice 26.9.0.1', unit: 'page' } } as Ref), 'ref: a converter upgrade is a different reference')
  equal(refLabel(slide), 'deck.pptx · slide 12 · text', 'ref: slide vocabulary in the label')
  equal(spokenRef(slide), 'deck.pptx, slide 12, hidden, text "Q3 revenue"', 'ref: a hidden slide is spoken as hidden')
  equal(spokenRef(page), 'report.docx, page 3 as converted, text "Scope"', 'ref: a document page is spoken as converted')
  equal(shortLabel({ ...slide, id: 'r1' } as never), 'text on slide 12', 'ref: notices name the slide')
  const wire = serializeContext([{ version: 1, ref: { ...slide, id: 'r1' } as never }], 'hi', { packetId: null })
  ok(wire.includes("a presentation's slides map one to one, hidden slides included, in the presentation's order.") && wire.includes('"hidden":true') && !wire.includes('/lo/cache'), 'ref: the header explains converted pages, and no derivative path appears')
  const back = parseRefs(wire).refs[0]
  ok(back?.kind === 'current' && back.value.ref.kind === 'doc' && back.value.ref.converted?.unit === 'slide' && back.value.ref.converted.hidden === true, 'ref: converted round-trips through the wire')
  const cell: Ref = { kind: 'sheet', path: '/w/book.ods', sourceVersion: v, range: 'B2', converted: { by: 'LibreOffice 26.8.2.2' } }
  ok(isRefInput(cell), 'ref: a converted .ods range validates')
  ok(serializeContext([{ version: 1, ref: { ...cell, id: 'r1' } as never }], '', { packetId: null }).includes('as LibreOffice recalculated them'), 'ref: an .ods reference says its values are recalculated')
}
