// Word fixtures for the pre-flight's tests and the docx probe: raw WordprocessingML zipped with JSZip, so every case is
// one Clui wrote, never one Word saved (spec 14 §15, Decided 3).
import fs from 'node:fs'
import path from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import JSZip from 'jszip'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS = `xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:adec="http://schemas.microsoft.com/office/drawing/2017/decorative" mc:Ignorable="wps"`
const RT = (t) => `http://schemas.openxmlformats.org/officeDocument/2006/relationships/${t}`

/** A PNG of one flat colour: small, valid, deterministic. */
export function png(w, h, rgb = [40, 120, 200]) {
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())])
  const raw = Buffer.concat(Array.from({ length: h }, () => row))
  const chunk = (t, d) => {
    const l = Buffer.alloc(4)
    l.writeUInt32BE(d.length)
    const td = Buffer.concat([Buffer.from(t), d])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([l, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

const WORDS = 'the contractor shall deliver all work products described in this statement within the agreed schedule and budget subject to acceptance by the client project manager who will review each milestone'.split(' ')
let wi = 0
const text = (n) => Array.from({ length: n }, () => WORDS[wi++ % WORDS.length]).join(' ')
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
export const run = (t, rpr = '') => `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/>${rpr}<w:sz w:val="22"/></w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`
export const para = (t = `${text(25)} ${text(30)}`) => `<w:p><w:pPr><w:spacing w:after="160"/></w:pPr>${run(t)}</w:p>`
export const styled = (style, t) => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr>${run(t)}</w:p>`
export const pbreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
const sectPr = (hdr = true) => `<w:sectPr>${hdr ? '<w:headerReference w:type="default" r:id="rIdH"/><w:footerReference w:type="default" r:id="rIdF"/>' : ''}<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`
export const sectionBreak = (hdr = true) => `<w:p><w:pPr>${sectPr(hdr)}</w:pPr></w:p>`
const inline = (inner, id, docPr = '') => `<w:drawing><wp:inline><wp:extent cx="1905000" cy="1270000"/><wp:docPr id="${id}" name="Picture ${id}"${docPr}/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">${inner}</a:graphicData></a:graphic></wp:inline></w:drawing>`
const pic = (rid, link = false) =>
  `<pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="p"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip ${link ? 'r:link' : 'r:embed'}="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1905000" cy="1270000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`
export const picture = (rid, id, docPr = '', link = false) => `<w:p><w:r>${inline(pic(rid, link), id, docPr)}</w:r></w:p>`

const STYLES = (extra = '') =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${[1, 2, 3]
    .map((l) => `<w:style w:type="paragraph" w:styleId="Heading${l}"><w:name w:val="heading ${l}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="${l - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${36 - l * 4}"/></w:rPr></w:style>`)
    .join('')}<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:sz w:val="56"/></w:rPr></w:style>${extra}</w:styles>`

/** A .docx package. `parts` adds or replaces any part. */
export function docx({ body, rels = [], parts = {}, styles = STYLES(), strict = false, docm = false, hdr = true, notes = null, comments = 0, fonts = false }) {
  const z = new JSZip()
  const ov = (p, t) => `<Override PartName="/${p}" ContentType="application/vnd.openxmlformats-officedocument.${t}"/>`
  const main = docm ? 'application/vnd.ms-word.document.macroEnabled.main+xml' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
  z.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="${main}"/>${ov('word/styles.xml', 'wordprocessingml.styles+xml')}</Types>`
  )
  const rt = strict ? (t) => `http://purl.oclc.org/ooxml/officeDocument/relationships/${t}` : RT
  z.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rt('officeDocument')}" Target="word/document.xml"/></Relationships>`)
  const all = [
    `<Relationship Id="rIdS" Type="${rt('styles')}" Target="styles.xml"/>`,
    ...(hdr ? [`<Relationship Id="rIdH" Type="${rt('header')}" Target="header1.xml"/>`, `<Relationship Id="rIdF" Type="${rt('footer')}" Target="footer1.xml"/>`] : []),
    ...(notes ? [`<Relationship Id="rIdFn" Type="${rt('footnotes')}" Target="footnotes.xml"/>`, `<Relationship Id="rIdEn" Type="${rt('endnotes')}" Target="endnotes.xml"/>`] : []),
    ...(comments ? [`<Relationship Id="rIdCm" Type="${rt('comments')}" Target="comments.xml"/>`] : []),
    ...(fonts ? [`<Relationship Id="rIdFt" Type="${rt('fontTable')}" Target="fontTable.xml"/>`] : []),
    ...rels
  ]
  z.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${all.join('')}</Relationships>`)
  let doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}${strict ? ' w:conformance="strict"' : ''}><w:body>${body}${sectPr(hdr)}</w:body></w:document>`
  let sx = styles
  if (strict) {
    doc = doc.replace(W, 'http://purl.oclc.org/ooxml/wordprocessingml/main').replace(R, 'http://purl.oclc.org/ooxml/officeDocument/relationships')
    sx = sx.replace(W, 'http://purl.oclc.org/ooxml/wordprocessingml/main')
  }
  z.file('word/document.xml', doc)
  z.file('word/styles.xml', sx)
  if (hdr) {
    z.file('word/header1.xml', `<?xml version="1.0"?><w:hdr ${NS}><w:p>${run('HEADER-TEXT Statement of work')}</w:p></w:hdr>`)
    z.file('word/footer1.xml', `<?xml version="1.0"?><w:ftr ${NS}><w:p>${run('FOOTER-TEXT Confidential')}</w:p></w:ftr>`)
  }
  if (notes) for (const [part, tag] of [['footnotes', 'footnote'], ['endnotes', 'endnote']]) z.file(`word/${part}.xml`, `<?xml version="1.0"?><w:${part} ${NS}><w:${tag} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${tag}><w:${tag} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${tag}>${notes[part]}</w:${part}>`)
  if (comments) z.file('word/comments.xml', `<?xml version="1.0"?><w:comments ${NS}>${Array.from({ length: comments }, (_, i) => `<w:comment w:id="${i}" w:author="A"><w:p>${run(`comment ${i}`)}</w:p></w:comment>`).join('')}</w:comments>`)
  if (fonts) z.file('word/fontTable.xml', `<?xml version="1.0"?><w:fonts ${NS}><w:font w:name="Lato"><w:embedRegular r:id="rIdE1" w:fontKey="{00000000-0000-0000-0000-000000000000}"/></w:font></w:fonts>`)
  if (docm) z.file('word/vbaProject.bin', Buffer.alloc(2048, 7))
  for (const [p, c] of Object.entries(parts)) z.file(p, c)
  return z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

const note = (tag, id, t, custom = '') => `<w:${tag} w:id="${id}"><w:p>${custom ? run(custom) : `<w:r><w:${tag}Ref/></w:r>`}${run(` ${t}`)}</w:p></w:${tag}>`
const ref = (tag, id, rpr = '', custom = false) => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:${tag}Reference w:id="${id}"${custom ? ' w:customMarkFollows="1"' : ''}/></w:r>`

/** A minimal OLE compound file whose directory names `streams`: an encrypted OOXML package, or a .doc or .ppt. `fib`
 *  writes a WordDocument stream's first sector with fEncrypted set. */
export function ole(streams, { fib = false } = {}) {
  const S = 512
  const sectors = fib ? 3 : 2
  const b = Buffer.alloc(S * (sectors + 1))
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(b, 0)
  b.writeUInt16LE(0x3e, 0x18)
  b.writeUInt16LE(3, 0x1a)
  b.writeUInt16LE(0xfffe, 0x1c)
  b.writeUInt16LE(9, 0x1e)
  b.writeUInt16LE(6, 0x20)
  b.writeUInt32LE(1, 0x2c)
  b.writeUInt32LE(1, 0x30)
  b.writeUInt32LE(4096, 0x38)
  b.writeUInt32LE(0xfffffffe, 0x3c)
  b.writeUInt32LE(0xfffffffe, 0x44)
  b.fill(0xff, 0x4c, 512)
  b.writeUInt32LE(0, 0x4c)
  const fat = S
  b.fill(0xff, fat, fat + S)
  b.writeUInt32LE(0xfffffffd, fat)
  b.writeUInt32LE(0xfffffffe, fat + 4)
  if (fib) b.writeUInt32LE(0xfffffffe, fat + 8)
  const dir = 2 * S
  const entry = (k, name, type, start = 0xfffffffe, size = 0) => {
    const o = dir + k * 128
    b.write(name, o, 'utf16le')
    b.writeUInt16LE((name.length + 1) * 2, o + 0x40)
    b[o + 0x42] = type
    b.writeUInt32LE(0xffffffff, o + 0x44)
    b.writeUInt32LE(0xffffffff, o + 0x48)
    b.writeUInt32LE(0xffffffff, o + 0x4c)
    b.writeUInt32LE(start, o + 0x74)
    b.writeUInt32LE(size, o + 0x78)
  }
  entry(0, 'Root Entry', 5)
  streams.forEach((n, i) => entry(i + 1, n, 2, n === 'WordDocument' && fib ? 2 : 0xfffffffe, n === 'WordDocument' && fib ? 4096 : 0))
  if (fib) b.writeUInt16LE(0x0100, 3 * S + 10)
  return b
}

/** The fixtures spec 14 §15.17 names, by file name. */
export async function fixtures() {
  const out = {}
  // Headings: a style based on Heading 2, a look-alike with no outline level, a direct outline level, Title; three sections.
  const extra = `<w:style w:type="paragraph" w:styleId="ClauseHeading"><w:name w:val="Clause Heading"/><w:basedOn w:val="Heading2"/></w:style><w:style w:type="paragraph" w:styleId="LooksLikeHeading"><w:name w:val="Looks Like Heading"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>`
  {
    let b = styled('Title', 'Plain document title')
    for (let s = 0; s < 3; s++) {
      b += styled('Heading1', `Scope of work ${s + 1}`) + para() + para() + styled('Heading2', `Deliverables ${s + 1}`) + para()
      if (s === 1) {
        b += styled('ClauseHeading', 'Clause heading based on two') + para('Clause body names the unique phrase alpha bravo charlie.')
        b += styled('LooksLikeHeading', 'Bold look-alike line') + `<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr>${run('Direct outline paragraph')}</w:p>`
      }
      b += para('Repeat phrase delta echo.') + (s < 2 ? sectionBreak() : '')
    }
    out['plain.docx'] = await docx({ body: b, styles: STYLES(extra) })
  }
  {
    const rows = Array.from({ length: 150 }, (_, r) => `<w:tr>${['a', 'b', 'c'].map((c) => `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr><w:p>${run(`row ${r} ${c} rate`)}</w:p></w:tc>`).join('')}</w:tr>`)
    const tbl = (from) => `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="000000"/><w:bottom w:val="single" w:sz="4" w:color="000000"/><w:insideH w:val="single" w:sz="4" w:color="000000"/><w:insideV w:val="single" w:sz="4" w:color="000000"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>${from}</w:tbl>`
    out['table.docx'] = await docx({ body: styled('Heading1', 'Rates') + para() + tbl(rows.slice(0, 75).join('')) + pbreak + tbl(rows.slice(75).join('')) + para() })
  }
  {
    // One table wider than any pane, one that fits, so only the first scrolls and takes a tab stop.
    const cells = (n, w, t) => `<w:tr>${Array.from({ length: n }, (_, c) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr><w:p>${run(`${t} ${c}`)}</w:p></w:tc>`).join('')}</w:tr>`
    const grid = (n, w) => `<w:tblGrid>${`<w:gridCol w:w="${w}"/>`.repeat(n)}</w:tblGrid>`
    const tbl = (n, w, t) => `<w:tbl><w:tblPr><w:tblW w:w="${n * w}" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="000000"/><w:bottom w:val="single" w:sz="4" w:color="000000"/><w:insideH w:val="single" w:sz="4" w:color="000000"/><w:insideV w:val="single" w:sz="4" w:color="000000"/></w:tblBorders></w:tblPr>${grid(n, w)}${cells(n, w, t)}${cells(n, w, t)}</w:tbl>`
    out['wide.docx'] = await docx({ body: styled('Heading1', 'Wide table') + para('Before the wide table.') + tbl(8, 2400, 'WIDE cell') + para('Between the tables.') + tbl(2, 1500, 'NARROW cell') + para('After the tables.') })
  }
  // A landscape section before the document's portrait one, so Pages has a box narrower than the widest.
  out['mixed.docx'] = await docx({ body: styled('Heading1', 'Landscape section') + para() + '<w:p><w:pPr><w:sectPr><w:pgSz w:w="15840" w:h="12240" w:orient="landscape"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:pPr></w:p>' + styled('Heading1', 'Portrait section') + para() })
  out['splitp.docx'] = await docx({ body: para() + `<w:p>${run('MIDBR-before ')}<w:r><w:t>tail-a</w:t><w:br w:type="page"/><w:t>MIDBR-after</w:t></w:r></w:p>` + para() + para('Last paragraph after the split.') })
  out['notes.docx'] = await docx({
    notes: { footnotes: note('footnote', 1, 'FOOT note one text') + note('footnote', 2, 'FOOT note two text') + note('footnote', 3, 'FOOT custom note', '*') + note('footnote', 4, 'FOOT note four text'), endnotes: note('endnote', 1, 'END note one text') },
    body:
      styled('Heading1', 'Notes heading') +
      `<w:p>${run('Body with a footnote')}${ref('footnote', 1, '<w:vertAlign w:val="superscript"/>')}${run(' then another')}${ref('footnote', 2)}${run(' and a custom')}${ref('footnote', 3, '', true)}${run('*')}${run(' and an endnote')}${ref('endnote', 1)}${run(' after.')}</w:p>` +
      para() +
      pbreak +
      `<w:p>${run('A later page with its own footnote')}${ref('footnote', 4)}${run(' here.')}</w:p>`
  })
  out['tracked.docx'] = await docx({ body: `<w:p>${run('Kept text ')}<w:ins w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z">${run('INSERTED-TEXT ')}</w:ins><w:del w:id="2" w:author="A" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>DELETED-TEXT </w:delText></w:r></w:del>${run('end.')}</w:p>`, comments: 3 })
  out['comments.docx'] = await docx({ body: para('Three comments sit on this document.'), comments: 3 })
  {
    const logo = { 'word/media/logo.png': png(60, 40), 'word/media/fallback.png': png(120, 80, [200, 60, 40]) }
    const chart = `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="5486400" cy="3200400"/><wp:docPr id="20" name="Chart"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rIdC"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
    const chartFallback = `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="cx1"><w:drawing><wp:inline><wp:extent cx="5486400" cy="3200400"/><wp:docPr id="21" name="Chart 2"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/drawing/2014/chartex"><cx:chart xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex" r:id="rIdC"/></a:graphicData></a:graphic></wp:inline></w:drawing></mc:Choice><mc:Fallback>${inline(pic('rIdFb'), 22, ' descr="Chart fallback picture"')}</mc:Fallback></mc:AlternateContent></w:r></w:p>`
    const diagram = `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="5486400" cy="3200400"/><wp:docPr id="23" name="Diagram"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram"><dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" r:dm="rIdD" r:lo="rIdD" r:qs="rIdD" r:cs="rIdD"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`
    const object = `<w:p><w:r><w:object><v:shape id="_x0000_i1025" style="width:90pt;height:60pt"><v:imagedata r:id="rIdP" o:title=""/></v:shape><o:OLEObject Type="Embed" ProgID="Excel.Sheet.12" ShapeID="_x0000_i1025" r:id="rIdO"/></w:object></w:r></w:p>`
    const body =
      para('Pictures follow.') +
      picture('rIdP', 1, ' descr="Company logo"') +
      picture('rIdP', 2, ' title="Logo title only"') +
      picture('rIdP', 3) +
      `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="1905000" cy="1270000"/><wp:docPr id="4" name="Decor"><a:extLst><a:ext uri="{C183D7F6-B498-43B3-948B-1728B52AA6E4}"><adec:decorative val="1"/></a:ext></a:extLst></wp:docPr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">${pic('rIdP')}</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>` +
      picture('rIdX', 5, ' descr="Linked picture"', true) +
      chart +
      chartFallback +
      diagram +
      object
    out['media.docx'] = await docx({
      body,
      fonts: true,
      rels: [
        `<Relationship Id="rIdP" Type="${RT('image')}" Target="media/logo.png"/>`,
        `<Relationship Id="rIdFb" Type="${RT('image')}" Target="media/fallback.png"/>`,
        `<Relationship Id="rIdX" Type="${RT('image')}" Target="https://example.com/linked.png" TargetMode="External"/>`,
        `<Relationship Id="rIdC" Type="${RT('chart')}" Target="charts/chart1.xml"/>`,
        `<Relationship Id="rIdD" Type="${RT('diagramData')}" Target="diagrams/data1.xml"/>`,
        `<Relationship Id="rIdO" Type="${RT('package')}" Target="embeddings/sheet.xlsx"/>`
      ],
      parts: {
        ...logo,
        'word/charts/chart1.xml': '<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"/>',
        'word/diagrams/data1.xml': '<?xml version="1.0"?><dgm:dataModel xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"/>',
        'word/embeddings/sheet.xlsx': Buffer.alloc(100, 1),
        'word/header1.xml': `<?xml version="1.0"?><w:hdr ${NS}><w:p>${run('HEADER-TEXT with a picture')}</w:p>${picture('rIdHp', 30, ' descr="Header logo"')}</w:hdr>`,
        'word/_rels/header1.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdHp" Type="${RT('image')}" Target="media/logo.png"/></Relationships>`
      }
    })
  }
  out['links.docx'] = await docx({
    body:
      `<w:p><w:hyperlink w:anchor="target">${run('bookmark link')}</w:hyperlink> <w:hyperlink r:id="rIdL1">${run('http link')}</w:hyperlink> <w:hyperlink r:id="rIdL2">${run('mailto link')}</w:hyperlink> <w:hyperlink r:id="rIdL3">${run('file link')}</w:hyperlink> <w:hyperlink r:id="rIdL4">${run('JS-LINK')}</w:hyperlink></w:p>` +
      Array.from({ length: 30 }, () => para()).join('') +
      pbreak +
      Array.from({ length: 30 }, () => para()).join('') +
      `<w:p><w:bookmarkStart w:id="0" w:name="target"/>${run('Bookmark target')}<w:bookmarkEnd w:id="0"/></w:p>` +
      Array.from({ length: 30 }, () => para()).join(''),
    rels: ['https://example.com/', 'mailto:a@example.com', 'file:///etc/hosts', 'javascript:document.title="PWNED"'].map((t, i) => `<Relationship Id="rIdL${i + 1}" Type="${RT('hyperlink')}" Target="${esc(t)}" TargetMode="External"/>`)
  })
  {
    const evil = `<w:style w:type="paragraph" w:styleId="Evil{}*{display:none}x"><w:name w:val="Evil"/></w:style><w:style w:type="character" w:styleId="Fnt"><w:name w:val="Fnt"/><w:rPr><w:rFonts w:ascii="Arial;}:host{position:fixed!important;inset:0!important;background:lime!important}x{"/><w:color w:val="FF0000;}:host{outline:50px solid blue!important}p{background-image:url(https://example.com/bg.png)}x{"/></w:rPr></w:style>`
    out['hostile.docx'] = await docx({
      styles: STYLES(evil),
      body:
        `<w:p><w:pPr><w:pStyle w:val="Evil{}*{display:none}x"/></w:pPr>${run('evil style para')}</w:p><w:p><w:r><w:rPr><w:rStyle w:val="Fnt"/></w:rPr><w:t>font run HOSTILE-TEXT</w:t></w:r></w:p>` +
        picture('rIdX1', 1) +
        picture('rIdX2', 2) +
        `<w:p><w:r><w:pict><v:shape style="width:10pt;height:10pt"><v:imagedata r:id="rIdX1"/></v:shape></w:pict></w:r></w:p>` +
        `<w:p><w:fldSimple w:instr=' INCLUDEPICTURE "https://example.com/inc.png" \\d '>${run('fld')}</w:fldSimple></w:p>` +
        `<w:altChunk r:id="rIdAlt"/><w:p><w:hyperlink r:id="rIdJs">${run('JS-LINK')}</w:hyperlink></w:p>`,
      rels: [
        `<Relationship Id="rIdX1" Type="${RT('image')}" Target="https://example.com/ext.png" TargetMode="External"/>`,
        `<Relationship Id="rIdX2" Type="${RT('image')}" Target="file:///etc/hosts" TargetMode="External"/>`,
        `<Relationship Id="rIdAlt" Type="${RT('aFChunk')}" Target="afchunk.html"/>`,
        `<Relationship Id="rIdJs" Type="${RT('hyperlink')}" Target="javascript:document.title='PWNED'" TargetMode="External"/>`
      ],
      parts: { 'word/afchunk.html': '<html><body><script>top.document.title="PWNED"</script><img src="https://example.com/alt.png">ALTCHUNK</body></html>' }
    })
  }
  out['linked.docx'] = await docx({
    body: `<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> INCLUDETEXT "/tmp/secret.txt" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${run('included')}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>` + picture('rIdLk', 1, '', true),
    rels: [`<Relationship Id="rIdLk" Type="${RT('image')}" Target="file:///tmp/secret.png" TargetMode="External"/>`]
  })
  out['macro.docm'] = await docx({ docm: true, body: styled('Heading1', 'Macro document') + para() })
  out['strict.docx'] = await docx({ strict: true, hdr: false, body: styled('Heading1', 'Strict heading') + para() })
  out['gdocs.docx'] = await docx({ hdr: false, body: [0, 1, 2].map((p) => styled('Heading1', `Docs ${p}`) + para() + para() + (p < 2 ? pbreak : '')).join('') })
  out['quote.docx'] = await docx({ body: para(Array.from({ length: 230 }, (_, i) => `word${String(i).padStart(4, '0')}`).join(' ').slice(0, 2001)) })
  out['long.docx'] = await sized(1_000_001)
  out['capped.docx'] = await sized(999_000)
  {
    const z = new JSZip()
    const base = await JSZip.loadAsync(await docx({ body: para() }))
    for (const [n, f] of Object.entries(base.files)) if (!f.dir) z.file(n, await f.async('nodebuffer'))
    z.file('word/media/zeros.bin', Buffer.alloc(8 * 1024 * 1024))
    out['bomb.docx'] = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } })
  }
  out['locked.docx'] = ole(['EncryptionInfo', 'EncryptedPackage'])
  out['locked.doc'] = ole(['WordDocument', '1Table'], { fib: true })
  out['macro.doc'] = ole(['WordDocument', '1Table', 'Macros'])
  out['broken.docx'] = out['plain.docx'].subarray(0, Math.floor(out['plain.docx'].length / 2))
  out['empty.docx'] = Buffer.alloc(0)
  out['notzip.docx'] = Buffer.from('PK this is not a zip')
  out['broken.rtf'] = Buffer.from('plain text pretending')
  return out
}

/** A document whose `document.xml` is exactly `bytes` long, in segments of about 8 KB. */
async function sized(bytes) {
  const head = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>`
  const tail = `${sectPr()}</w:body></w:document>`
  const segs = []
  let k = 0
  let n = head.length + tail.length
  while (n < bytes - 12_000) {
    const s = styled('Heading1', `Segment ${k + 1} heading`) + Array.from({ length: 14 }, () => para()).join('') + para(`Marker segment ${k + 1} words.`) + pbreak
    segs.push(s)
    n += s.length
    k++
  }
  const body = segs.join('')
  // The last paragraph's run takes up the remaining bytes exactly.
  const pad = bytes - (head + body + `<w:p>${run('')}</w:p>` + tail).length
  const xml = head + body + `<w:p>${run('z'.repeat(pad))}</w:p>` + tail
  if (Buffer.byteLength(xml) !== bytes) throw new Error(`sized ${bytes}: got ${Buffer.byteLength(xml)}`)
  const base = await JSZip.loadAsync(await docx({ body: para() }))
  base.file('word/document.xml', xml)
  return base.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

export async function writeAll(dir) {
  fs.mkdirSync(dir, { recursive: true })
  for (const [n, b] of Object.entries(await fixtures())) fs.writeFileSync(path.join(dir, n), b)
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1])) && process.argv[2]) await writeAll(process.argv[2])
