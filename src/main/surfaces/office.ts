/**
 * Office files before anything renders them: the pre-flight read of a document's package (bounds, encryption,
 * damage, macros and what Clui's Word layout can't show), and Quick Look's first page of the rest. Reads go through
 * the guarded file reads at one stat revision; nothing here parses more than the parts it names.
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CHUNK_MAX } from '../../shared/files'
import { isPresentation, isWord, OFFICE_BYTES_MAX, WORD_XML_MAX, type DamagedAs, type Flight, type Glimpse, type WordFacts, type WordPart } from '../../shared/office'
import { unxml } from '../../shared/sheets'
import { zipEntries, zipPart, type Read, type ZipEntry } from './zip'

const ENTRIES_MAX = 10_000
const UNZIPPED_MAX = 512 * 1024 * 1024
const RATIO_MAX = 200
/** The cap on any part besides document.xml that pre-flight inflates: styles, notes, comments, relationships. */
const PART_MAX = 16 * 1024 * 1024
const OLE = Buffer.from('d0cf11e0a1b11ae1', 'hex')

const damagedAs = (p: string): DamagedAs => (/\.(odt|odp)$/i.test(p) ? 'opendocument' : /\.rtf$/i.test(p) ? 'rtf' : isPresentation(p) ? 'powerpoint' : 'word')

/** The names in an OLE compound file's directory, and a stream's first bytes by name. Null when the header or a
 *  sector chain doesn't hold up. */
async function oleOf(size: number, read: Read): Promise<{ names: string[]; head(name: string, n: number): Promise<Buffer | null> } | null> {
  const h = await read(0, 512)
  if (!h || h.length < 512 || !h.subarray(0, 8).equals(OLE)) return null
  const ssz = 1 << h.readUInt16LE(0x1e)
  if (ssz !== 512 && ssz !== 4096) return null
  const per = ssz / 4
  const sectors = Math.ceil(size / ssz)
  const fat: number[] = []
  for (let i = 0; i < 109; i++) fat.push(h.readUInt32LE(0x4c + i * 4))
  for (let s = h.readUInt32LE(0x44), k = 0; s < sectors && k < sectors; k++) {
    const b = await read((s + 1) * ssz, ssz)
    if (!b || b.length < ssz) return null
    for (let i = 0; i < per - 1; i++) fat.push(b.readUInt32LE(i * 4))
    s = b.readUInt32LE(ssz - 4)
  }
  const fatSectors = fat.slice(0, h.readUInt32LE(0x2c))
  const cache = new Map<number, Buffer>()
  const next = async (s: number): Promise<number> => {
    const at = fatSectors[Math.floor(s / per)]
    if (at === undefined || at >= sectors) return -1
    let b = cache.get(at)
    if (!b) {
      const r = await read((at + 1) * ssz, ssz)
      if (!r || r.length < ssz) return -1
      cache.set(at, (b = r))
    }
    return b.readUInt32LE((s % per) * 4)
  }
  const entries: { name: string; start: number; size: number }[] = []
  for (let s = h.readUInt32LE(0x30), k = 0; s < sectors && k < sectors; k++, s = await next(s)) {
    const b = await read((s + 1) * ssz, ssz)
    if (!b || b.length < ssz) return null
    for (let o = 0; o + 128 <= ssz; o += 128) {
      const len = b.readUInt16LE(o + 0x40)
      if (b[o + 0x42] && len >= 2 && len <= 64) entries.push({ name: b.toString('utf16le', o, o + len - 2), start: b.readUInt32LE(o + 0x74), size: b.readUInt32LE(o + 0x78) })
    }
  }
  if (!entries.length) return null
  const cutoff = h.readUInt32LE(0x38)
  return {
    names: entries.map((e) => e.name),
    async head(name, n) {
      const e = entries.find((x) => x.name === name)
      return e && e.size >= cutoff && e.start < sectors ? read((e.start + 1) * ssz, Math.min(n, ssz)) : null
    }
  }
}

/** A part's XML with what docx-preview never draws taken out: each AlternateContent's Choice, and deleted runs. */
const drawn = (xml: string): string =>
  xml
    .replace(/<mc:AlternateContent\b[^>]*>([\s\S]*?)<\/mc:AlternateContent>/g, (_m, inner: string) => /<mc:Fallback\b[^>]*>([\s\S]*?)<\/mc:Fallback>/.exec(inner)?.[1] ?? '')
    .replace(/<w:del(?:\s[^>]*)?(?<!\/)>[\s\S]*?<\/w:del>/g, '')

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)
  return m ? unxml(m[1]) : null
}
const words = (s: string | null): string | null => {
  const t = s?.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, 1000) : null
}

/** Each picture docx-preview will draw from a part, in order, as its alt text. */
function picturesIn(xml: string): (string | null)[] {
  const out: (string | null)[] = []
  for (const m of xml.matchAll(/<w:drawing>([\s\S]*?)<\/w:drawing>|<w:pict\b[^>]*>([\s\S]*?)<\/w:pict>/g)) {
    if (m[1] !== undefined) {
      if (!/<pic:pic\b/.test(m[1])) continue
      const doc = /<wp:docPr\b[^>]*>/.exec(m[1])?.[0] ?? ''
      out.push(/<adec:decorative\b[^>]*\bval="(1|true)"/.test(m[1]) ? '' : (words(attr(doc, 'descr')) ?? words(attr(doc, 'title'))))
    } else {
      const img = /<v:imagedata\b[^>]*>/.exec(m[2])?.[0]
      if (!img) continue
      const shape = /<v:(shape|rect|roundrect|oval)\b[^>]*>/.exec(m[2])?.[0] ?? ''
      out.push(words(attr(shape, 'alt')) ?? words(attr(img, 'o:title')))
    }
  }
  return out
}

/** Charts and diagrams that draw nothing, counted in a part's XML before its Choices are dropped: one in an
 *  AlternateContent whose Fallback holds a picture shows as that picture. */
function unshown(xml: string): { charts: number; diagrams: number } {
  let charts = 0
  let diagrams = 0
  const count = (s: string): void => {
    charts += (s.match(/<(c|cx):chart\b/g) ?? []).length
    diagrams += (s.match(/<dgm:relIds\b/g) ?? []).length
  }
  count(
    xml.replace(/<mc:AlternateContent\b[^>]*>([\s\S]*?)<\/mc:AlternateContent>/g, (_m, inner: string) => {
      const fb = /<mc:Fallback\b[^>]*>([\s\S]*?)<\/mc:Fallback>/.exec(inner)?.[1] ?? ''
      if (!/<pic:pic\b|<v:imagedata\b/.test(fb)) count(fb)
      return ''
    })
  )
  return { charts, diagrams }
}

/** docx-preview 0.4.1's `escapeClassName`, so a style id maps to the class it puts on a paragraph. */
const styleClass = (id: string): string => `docx_${id.replace(/[ .]+/g, '-').replace(/[&]+/g, 'and').toLowerCase()}`

/** Paragraph styles that are headings, by their class: the first outline level up the basedOn chain, plus Title. Two
 *  ids that collapse to one class with different levels are both left out. */
export function headingMap(styles: string): Record<string, number> {
  const all = new Map<string, { based: string | null; lvl: number | null; title: boolean }>()
  for (const m of styles.matchAll(/<w:style\b([^>]*)>([\s\S]*?)<\/w:style>/g)) {
    if (attr(m[1], 'w:type') !== 'paragraph') continue
    const id = attr(m[1], 'w:styleId')
    if (!id) continue
    const lvl = /<w:outlineLvl\b[^>]*\bw:val="(\d+)"/.exec(m[2])
    all.set(id, { based: attr(/<w:basedOn\b[^>]*>/.exec(m[2])?.[0] ?? '', 'w:val'), lvl: lvl ? Number(lvl[1]) : null, title: attr(/<w:name\b[^>]*>/.exec(m[2])?.[0] ?? '', 'w:val') === 'Title' })
  }
  const out: Record<string, number> = {}
  const clash = new Set<string>()
  for (const [id, s] of all) {
    let level: number | null = s.title ? 1 : null
    for (let cur: typeof s | undefined = s, seen = 0; level === null && cur && seen < 32; cur = cur.based ? all.get(cur.based) : undefined, seen++) {
      if (cur.lvl !== null) level = cur.lvl < 9 ? cur.lvl + 1 : 0
    }
    if (!level) continue
    const c = styleClass(id)
    if (c in out && out[c] !== level) clash.add(c)
    out[c] = level
  }
  for (const c of clash) delete out[c]
  return out
}

/** Word's facts from its parts. `part(name)` is null for a part that isn't there. */
export async function wordFacts(names: string[], part: (name: string) => Promise<string | null>): Promise<WordFacts> {
  const rels = (await part('word/_rels/document.xml.rels')) ?? ''
  const target = (type: string, fallback: string): string => {
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const t = attr(m[0], 'Type')
      const to = attr(m[0], 'Target')
      if (t?.endsWith(`/${type}`) && to && attr(m[0], 'TargetMode') !== 'External') return to.startsWith('/') ? to.slice(1) : `word/${to}`
    }
    return fallback
  }
  const [body, styles, comments, foot, end, fonts] = await Promise.all(
    [
      'word/document.xml',
      target('styles', 'word/styles.xml'),
      target('comments', 'word/comments.xml'),
      target('footnotes', 'word/footnotes.xml'),
      target('endnotes', 'word/endnotes.xml'),
      target('fontTable', 'word/fontTable.xml')
    ].map(async (n) => (await part(n)) ?? '')
  )
  const relParts = await Promise.all(names.filter((n) => /^word\/_rels\/[^/]+\.rels$/.test(n)).map(async (n) => (await part(n)) ?? ''))
  const links = relParts.some((x) => [...x.matchAll(/<Relationship\b[^>]*>/g)].some((m) => attr(m[0], 'TargetMode') === 'External' && !attr(m[0], 'Type')?.endsWith('/hyperlink')))
  const tracked: WordFacts['tracked'] = {}
  const parts: [WordPart, string][] = [
    ['body', body],
    ['footnotes', foot],
    ['endnotes', end]
  ]
  for (const [k, x] of parts) if (/<w:(ins|del|moveFrom|moveTo)\b/.test(x)) tracked[k] = true
  const seen = drawn(body)
  const { charts, diagrams } = unshown(body)
  return {
    macros: names.some((n) => /(^|\/)vbaProject\.bin$/i.test(n)),
    links,
    strict: body.includes('http://purl.oclc.org/ooxml/wordprocessingml/main'),
    tracked,
    comments: (comments.match(/<w:comment\b/g) ?? []).length,
    charts,
    diagrams,
    objects: (seen.match(/<w:object\b/g) ?? []).length,
    fonts: /<w:embed(Regular|Bold|Italic|BoldItalic)\b/.test(fonts),
    headings: headingMap(styles),
    pictures: { body: picturesIn(seen), footnotes: picturesIn(drawn(foot)), endnotes: picturesIn(drawn(end)) },
    notes: [...seen.matchAll(/<w:(footnote|endnote)Reference\b[^>]*>/g)].map((m) => ({ part: m[1] === 'footnote' ? 'footnotes' : 'endnotes', custom: /\bw:customMarkFollows="(1|true|on)"/.test(m[0]) }))
  }
}

/** How large a Word file's `document.xml` is, from the directory alone; null when it can't be read. */
export async function wordXml(size: number, read: Read): Promise<number | null> {
  return (await zipEntries(size, read))?.find((e) => e.name === 'word/document.xml')?.size ?? null
}

/** The pre-flight of one Office file at one revision, from its size and a ranged reader. */
export async function preflight(path: string, size: number, read: Read): Promise<Flight> {
  const as = damagedAs(path)
  if (!size) return { t: 'empty' }
  if (size > OFFICE_BYTES_MAX) return { t: 'too-large', bytes: size }
  const head = await read(0, Math.min(size, 8))
  if (!head) return { t: 'damaged', as }
  if (as === 'rtf') return head.toString('latin1').startsWith('{\\rtf') ? { t: 'glimpse', macros: false } : { t: 'damaged', as }
  const ole = head.subarray(0, 8).equals(OLE) ? await oleOf(size, read) : null
  if (/\.(doc|ppt)$/i.test(path)) {
    if (!ole) return { t: 'damaged', as }
    const ppt = /\.ppt$/i.test(path)
    // A Word 97 file's FIB keeps fEncrypted in its flags word.
    const fib = ppt ? null : await ole.head('WordDocument', 12)
    const locked = ppt ? ole.names.includes('EncryptedSummary') : !!fib && fib.length >= 12 && !!(fib.readUInt16LE(10) & 0x100)
    if (locked || ole.names.includes('EncryptionInfo')) return { t: 'locked' }
    return { t: 'glimpse', macros: ole.names.some((n) => n === 'Macros' || n === '_VBA_PROJECT_CUR') }
  }
  // An encrypted OOXML or ODF package is an OLE container holding the encrypted zip.
  if (ole) return ole.names.includes('EncryptionInfo') ? { t: 'locked' } : { t: 'damaged', as }
  const entries = await zipEntries(size, read)
  if (!entries) return { t: 'damaged', as }
  const byName = new Map<string, ZipEntry>(entries.map((e) => [e.name, e]))
  const names = [...byName.keys()]
  const text = async (n: string, max = PART_MAX): Promise<string | null> => {
    const e = byName.get(n)
    if (!e || e.size > max) return null
    return (await zipPart(e, read))?.toString('utf8') ?? null
  }
  if (as === 'opendocument') {
    if (!byName.has('content.xml')) return { t: 'damaged', as }
    if ((await text('META-INF/manifest.xml'))?.includes('encryption-data')) return { t: 'locked' }
    return { t: 'glimpse', macros: names.some((n) => n.startsWith('Basic/') || n.startsWith('Scripts/')) }
  }
  const main = as === 'powerpoint' ? 'ppt/presentation.xml' : 'word/document.xml'
  if (!byName.has('[Content_Types].xml') || !byName.has(main)) return { t: 'damaged', as }
  const macros = names.some((n) => /(^|\/)vbaProject\.bin$/i.test(n))
  if (!isWord(path)) return { t: 'glimpse', macros }
  const unzipped = entries.reduce((n, e) => n + e.size, 0)
  if (entries.length > ENTRIES_MAX) return { t: 'unpacks', bound: 'entries', n: entries.length }
  if (unzipped > UNZIPPED_MAX) return { t: 'unpacks', bound: 'unzipped', n: unzipped }
  if (entries.some((e) => e.size / Math.max(1, e.compressed) > RATIO_MAX)) return { t: 'unpacks', bound: 'ratio' }
  const xml = byName.get(main)!.size
  if (xml > WORD_XML_MAX) return { t: 'glimpse', macros, xml }
  if ((await text(main, WORD_XML_MAX)) === null) return { t: 'damaged', as }
  return { t: 'word', facts: await wordFacts(names, (n) => text(n)) }
}

/** A PNG's pixel size from its header. */
const pngSize = (b: Buffer): { w: number; h: number } | null =>
  b.length > 24 && b.readUInt32BE(12) === 0x49484452 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null

/**
 * Quick Look's first page of one file revision. `qlmanage -t` runs on a private copy, never the user's path, and only
 * with `-t`: `-p` once crashed on ODT with a dialog on the user's screen. A revision whose thumbnail failed isn't tried
 * again this app session, so a crashing generator can't raise a second dialog.
 */
export function glimpses(dir: string, qlmanage: string, timeoutMs = 5000) {
  const done = new Map<string, Glimpse>()
  const failed = new Set<string>()
  const running = new Map<string, Promise<Glimpse>>()
  const run = async (path: string, size: number, read: Read): Promise<Glimpse> => {
    const job = join(dir, randomUUID())
    const copy = join(job, `copy${extname(path).toLowerCase()}`)
    try {
      await mkdir(job, { recursive: true, mode: 0o700 })
      const parts: Buffer[] = []
      for (let at = 0; at < size; at += CHUNK_MAX) {
        const b = await read(at, Math.min(CHUNK_MAX, size - at))
        if (!b) return { ok: false, why: 'changed' }
        parts.push(b)
      }
      await writeFile(copy, Buffer.concat(parts), { mode: 0o600 })
      const ok = await new Promise<boolean>((res) =>
        execFile(qlmanage, ['-t', '-s', '2000', '-o', job, copy], { timeout: timeoutMs, killSignal: 'SIGKILL' }, (e) => res(!e))
      )
      const png = ok ? await readFile(join(job, `${basename(copy)}.png`)).catch(() => null) : null
      const px = png && pngSize(png)
      return png && px ? { ok: true, url: `data:image/png;base64,${png.toString('base64')}`, ...px } : { ok: false, why: 'failed' }
    } finally {
      await rm(job, { recursive: true, force: true }).catch(() => {})
    }
  }
  return {
    get(path: string, revision: string, size: number, read: Read): Promise<Glimpse> {
      const key = `${path}\0${revision}`
      if (failed.has(key)) return Promise.resolve({ ok: false, why: 'failed' })
      const hit = done.get(key)
      if (hit) return Promise.resolve(hit)
      const live = running.get(key)
      if (live) return live
      const p = run(path, size, read).then((g) => {
        running.delete(key)
        if (!g.ok && g.why === 'failed') failed.add(key)
        else if (g.ok) {
          done.set(key, g)
          // Pictures are a few MB each; a session of glimpses keeps the newest.
          if (done.size > 16) done.delete(done.keys().next().value as string)
        }
        return g
      })
      running.set(key, p)
      return p
    }
  }
}
