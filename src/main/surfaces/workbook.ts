// Reads an .xlsx or .xlsm into the compact book the sheet grid draws: display text from SSF (exceljs's own `.text` is
// wrong for formatted numbers and dates), styles resolved to Clui's subset, merges, freezes, hidden bands and what
// isn't shown. Runs in the sheet worker process; nothing here evaluates a formula, follows a link or runs a macro.
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { SSF } from 'xlsx'
import { CELL_CEILING, K, unxml, type Book, type BookFailure, type BookSheet, type Border, type CellStyle, type SheetGaps } from '../../shared/sheets'

function offsetsOf(text: string[], n: number): Uint32Array {
  const at = new Uint32Array(n + 1)
  for (let j = 0; j < n; j++) at[j + 1] = at[j] + text[j].length
  return at
}

// What every part claims to inflate to, checked after the cell ceiling so a genuinely huge workbook still hears its
// count. The 1.4M-cell benchmark unzips to 57 MB; this much XML for at most 2M cells is no workbook the worker's heap
// could hold.
export const UNZIPPED_MAX = 512 * 1024 * 1024

const OLE = Buffer.from('d0cf11e0a1b11ae1', 'hex')
const ZIP = Buffer.from('504b0304', 'hex')

/** What the bytes are before anything parses them: an OLE container is a legacy .xls, or an encrypted workbook when it
 *  holds an EncryptionInfo stream. */
export function classify(b: Uint8Array): BookFailure | null {
  const buf = Buffer.from(b.buffer, b.byteOffset, b.byteLength)
  if (buf.subarray(0, 8).equals(OLE)) return buf.includes(Buffer.from('EncryptionInfo', 'utf16le')) ? { t: 'encrypted' } : { t: 'old' }
  return buf.subarray(0, 4).equals(ZIP) ? null : { t: 'damaged' }
}

const attr = (tag: string, name: string): string | undefined => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]
const read = async (zip: JSZip, name: string): Promise<string> => (await zip.file(name)?.async('string')) ?? ''
const joinPath = (from: string, target: string): string => {
  if (target.startsWith('/')) return target.slice(1)
  const parts = from.split('/').slice(0, -1)
  for (const p of target.split('/')) p === '..' ? parts.pop() : p !== '.' && parts.push(p)
  return parts.join('/')
}
async function rels(zip: JSZip, part: string): Promise<{ type: string; target: string }[]> {
  const at = part.lastIndexOf('/')
  const xml = await read(zip, `${part.slice(0, at)}/_rels/${part.slice(at + 1)}.rels`)
  return [...xml.matchAll(/<Relationship\b[^>]*>/g)].map((m) => ({ type: attr(m[0], 'Type') ?? '', target: joinPath(part, unxml(attr(m[0], 'Target') ?? '')) }))
}

// JSZip streams a part as it inflates, though its typings leave the method out.
type Streamed = { on(e: string, fn: (x: never) => void): Streamed; pause(): void; resume(): Streamed }
const streamOf = (f: JSZip.JSZipObject): Streamed => (f as unknown as { internalStream(t: 'string'): Streamed }).internalStream('string')

/** The worksheet XML before `<sheetData>`, where `<dimension>` lives; the rest is never inflated here. */
function head(f: JSZip.JSZipObject): Promise<string> {
  return new Promise((res, rej) => {
    let acc = ''
    const s = streamOf(f)
    s.on('data', (d: string) => {
      acc += d
      if (/<sheetData[\s>/]/.test(acc) || acc.length > 1 << 20) {
        s.pause()
        res(acc)
      }
    })
      .on('error', rej)
      .on('end', () => res(acc))
      .resume()
  })
}
/** Cells in a worksheet with no `<dimension>`, counted by streaming its XML. */
function countCells(f: JSZip.JSZipObject): Promise<number> {
  return new Promise((res, rej) => {
    let n = 0
    let carry = ''
    streamOf(f)
      .on('data', (d: string) => {
        const s = carry + d
        n += s.match(/<c[\s>]/g)?.length ?? 0
        carry = s.slice(-2).includes('<') ? s.slice(s.lastIndexOf('<')) : ''
        if (carry) n -= carry.match(/<c[\s>]/g)?.length ?? 0
      })
      .on('error', rej)
      .on('end', () => res(n))
      .resume()
  })
}
const A1 = /^\$?([A-Z]{1,3})\$?(\d+)$/
function cellRef(s: string): { r: number; c: number } | null {
  const m = A1.exec(s.toUpperCase())
  if (!m) return null
  let c = 0
  for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64
  return { r: Number(m[2]) - 1, c: c - 1 }
}
const rangeRef = (s: string): { r0: number; c0: number; r1: number; c1: number } | null => {
  const [a, b = a] = s.split(':')
  const x = cellRef(a)
  const y = cellRef(b)
  return x && y ? { r0: Math.min(x.r, y.r), c0: Math.min(x.c, y.c), r1: Math.max(x.r, y.r), c1: Math.max(x.c, y.c) } : null
}

interface Part {
  name: string
  part: string
  cells: number
  gaps: Pick<SheetGaps, 'charts' | 'images' | 'shapes' | 'pivots' | 'notes' | 'slicers' | 'controls'>
}
/** Sheet names in workbook order with their parts, sizes from `<dimension>` or a count of the cells, and the parts Clui
 *  doesn't draw. */
async function inspect(zip: JSZip): Promise<{ parts: Part[]; macros: boolean; links: boolean; recalc: boolean; font: { name?: string; size?: number } }> {
  const wbXml = await read(zip, 'xl/workbook.xml')
  const relXml = await read(zip, 'xl/_rels/workbook.xml.rels')
  const byId = new Map([...relXml.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], 'Id'), joinPath('xl/workbook.xml', unxml(attr(m[0], 'Target') ?? ''))]))
  const parts: Part[] = []
  for (const m of wbXml.matchAll(/<sheet\b[^>]*>/g)) {
    const part = byId.get(attr(m[0], 'r:id')) ?? ''
    const f = zip.file(part)
    if (!f) continue
    const top = await head(f)
    const dim = /<dimension\b[^>]*ref="([^"]+)"/.exec(top)?.[1]
    const r = dim ? rangeRef(dim) : null
    const cells = r ? (r.r1 - r.r0 + 1) * (r.c1 - r.c0 + 1) : await countCells(f)
    const gaps = { charts: 0, images: 0, shapes: 0, pivots: 0, notes: false, slicers: false, controls: false }
    for (const x of await rels(zip, part)) {
      const t = x.type.slice(x.type.lastIndexOf('/') + 1)
      if (t === 'pivotTable') gaps.pivots++
      else if (t === 'comments' || t === 'threadedComment') gaps.notes = true
      else if (t === 'slicer' || t === 'timeline') gaps.slicers = true
      else if (t === 'ctrlProp') gaps.controls = true
      else if (t === 'drawing') {
        gaps.charts += (await rels(zip, x.target)).filter((d) => d.type.endsWith('/chart') || d.type.endsWith('/chartEx')).length
        const xml = await read(zip, x.target)
        gaps.images += (xml.match(/<xdr:pic\b/g) ?? []).length
        gaps.shapes += (xml.match(/<xdr:sp\b/g) ?? []).length
      }
    }
    parts.push({ name: unxml(attr(m[0], 'name') ?? ''), part, cells, gaps })
  }
  const styles = await read(zip, 'xl/styles.xml')
  const f0 = /<font\b[^>]*>([\s\S]*?)<\/font>/.exec(/<fonts\b[\s\S]*?<\/fonts>/.exec(styles)?.[0] ?? '')?.[1] ?? ''
  const size = Number(/<sz\b[^>]*val="([^"]+)"/.exec(f0)?.[1])
  const name = /<name\b[^>]*val="([^"]+)"/.exec(f0)?.[1]
  return {
    parts,
    macros: !!zip.file('xl/vbaProject.bin'),
    // exceljs reads no calcPr, so the flag comes from the XML.
    recalc: /<calcPr\b[^>]*\bfullCalcOnLoad="(1|true)"/.test(wbXml),
    links: Object.keys(zip.files).some((n) => n.startsWith('xl/externalLinks/') && !zip.files[n].dir),
    font: { ...(name ? { name: unxml(name) } : {}), ...(size ? { size } : {}) }
  }
}

// The legacy indexed palette; 64 and 65 are the system's foreground and background, so they read as "auto".
const INDEXED = (
  '000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF ' +
  '800000 008000 000080 808000 800080 008080 C0C0C0 808080 9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF ' +
  '000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF 00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 ' +
  '3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 003366 339966 003300 333300 993300 993366 333399 333333'
).split(' ')
const NAMED: Record<string, string> = { black: '000000', blue: '0000FF', cyan: '00FFFF', green: '00FF00', magenta: 'FF00FF', red: 'FF0000', white: 'FFFFFF', yellow: 'FFFF00' }

/** The theme's colours in the order cells index them: lt1, dk1, lt2, dk2 (Excel swaps each pair), accents, links. */
function themeColours(xml: string): string[] {
  const scheme = /<a:clrScheme\b[\s\S]*?<\/a:clrScheme>/.exec(xml)?.[0] ?? ''
  const pick = (tag: string): string => {
    const m = new RegExp(`<a:${tag}>([\\s\\S]*?)</a:${tag}>`).exec(scheme)?.[1] ?? ''
    return (/srgbClr val="([0-9A-Fa-f]{6})"/.exec(m)?.[1] ?? /lastClr="([0-9A-Fa-f]{6})"/.exec(m)?.[1] ?? '000000').toUpperCase()
  }
  const [dk1, lt1, dk2, lt2] = ['dk1', 'lt1', 'dk2', 'lt2'].map(pick)
  return [lt1, dk1, lt2, dk2, ...['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'].map(pick)]
}
/** Excel's tint: lightness moved toward black or white in HLS. */
function tinted(hex: string, tint: number): string {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let l = (max + min) / 2
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h % 6) + 6) % 6 % 2 - 1))
  const m = l - c / 2
  const hh = ((h % 6) + 6) % 6
  const [rr, gg, bb] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x]
  return [rr, gg, bb].map((v) => Math.round(Math.min(1, Math.max(0, v + m)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()
}
type XColor = { argb?: string; theme?: number; tint?: number; indexed?: number } | undefined
function colourOf(c: XColor, theme: string[]): string | undefined {
  if (!c) return undefined
  let hex: string | undefined
  if (typeof c.argb === 'string' && /^[0-9A-Fa-f]{6,8}$/.test(c.argb)) hex = c.argb.slice(-6).toUpperCase()
  else if (typeof c.theme === 'number') hex = theme[c.theme]
  else if (typeof c.indexed === 'number') hex = INDEXED[c.indexed]
  if (!hex) return undefined
  return `#${(c.tint ? tinted(hex, c.tint) : hex).toLowerCase()}`
}

const BORDER: Record<string, Border> = { thin: 1, hair: 1, dotted: 2, dashed: 3, dashDot: 3, dashDotDot: 3, medium: 4, thick: 4, mediumDashed: 4, mediumDashDot: 4, mediumDashDotDot: 4, slantDashDot: 4, double: 5 }
const H: Record<string, CellStyle['h']> = { left: 'left', center: 'center', centerContinuous: 'center', right: 'right', justify: 'justify', distributed: 'justify', fill: 'left' }
const V: Record<string, CellStyle['v']> = { top: 'top', middle: 'middle', center: 'middle', justify: 'top', distributed: 'top', bottom: 'bottom' }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type XStyle = any
function styleOf(st: XStyle, theme: string[]): CellStyle {
  const out: CellStyle = {}
  const fill = st.fill
  if (fill?.type === 'pattern' && fill.pattern && fill.pattern !== 'none') {
    const c = colourOf(fill.fgColor ?? fill.bgColor, theme)
    if (c) out.fill = c
  } else if (fill?.type === 'gradient') {
    const c = colourOf(fill.stops?.[0]?.color, theme)
    if (c) out.fill = c
  }
  const font = st.font
  if (font) {
    const ink = colourOf(font.color, theme)
    if (ink) out.ink = ink
    if (font.bold) out.b = true
    if (font.italic) out.i = true
    if (font.underline) out.u = font.underline === 'double' || font.underline === 'doubleAccounting' ? 2 : 1
    if (font.strike) out.s = true
  }
  const al = st.alignment
  if (al) {
    if (H[al.horizontal]) out.h = H[al.horizontal]
    if (V[al.vertical] && al.vertical !== 'bottom') out.v = V[al.vertical]
    if (al.indent > 0) out.indent = Math.min(15, al.indent)
    if (al.wrapText) out.wrap = true
  }
  const bd = st.border
  if (bd) {
    const sides = [bd.top, bd.right, bd.bottom, bd.left].map((x) => BORDER[x?.style] ?? 0) as [Border, Border, Border, Border]
    if (sides.some(Boolean)) out.bd = sides
  }
  return out
}

/** The colour a format section names for this number: `[Red]`, `[Color 10]`; conditions like `[<0]` pick the section. */
export function formatColour(fmt: string, v: number): string | undefined {
  if (!fmt.includes('[')) return undefined
  const sections: string[] = []
  let cur = ''
  let q = false
  let br = false
  for (const ch of fmt) {
    if (ch === '"' && !br) q = !q
    else if (!q && ch === '[') br = true
    else if (!q && ch === ']') br = false
    if (ch === ';' && !q && !br) {
      sections.push(cur)
      cur = ''
    } else cur += ch
  }
  sections.push(cur)
  const cond = (s: string): ((x: number) => boolean) | null => {
    const m = /\[(<=|>=|<>|<|>|=)(-?[\d.]+)\]/.exec(s)
    if (!m) return null
    const n = Number(m[2])
    return { '<': (x: number) => x < n, '>': (x: number) => x > n, '=': (x: number) => x === n, '<=': (x: number) => x <= n, '>=': (x: number) => x >= n, '<>': (x: number) => x !== n }[m[1]]!
  }
  let pick: string | undefined
  if (sections.some((s) => cond(s))) pick = sections.find((s, i) => (cond(s) ?? (() => i === sections.length - 1 || i === 2))(v)) ?? sections.at(-1)
  else pick = sections.length === 1 ? sections[0] : v > 0 || (v === 0 && sections.length < 3) ? sections[0] : v < 0 ? sections[1] : sections[2]
  const m = /\[(Black|Blue|Cyan|Green|Magenta|Red|White|Yellow|Colou?r\s*(\d+))\]/i.exec(pick ?? '')
  if (!m) return undefined
  const hex = m[2] ? INDEXED[Number(m[2]) + 7] : NAMED[m[1].toLowerCase()]
  return hex && `#${hex.toLowerCase()}`
}

const EPOCH_1900 = Date.UTC(1899, 11, 30)
const EPOCH_1904 = Date.UTC(1904, 0, 1)
const DAY = 86_400_000
export const serialOf = (d: Date, date1904: boolean): number => (d.getTime() - (date1904 ? EPOCH_1904 : EPOCH_1900)) / DAY

function display(fmt: string | number | undefined, v: number, date1904: boolean): string {
  if ((fmt === undefined || fmt === 'General') && Number.isInteger(v) && Math.abs(v) < 1e11) return String(v)
  try {
    return SSF.format(fmt ?? 'General', v, { date1904 })
  } catch {
    return String(v)
  }
}

/** A column `w` characters wide in px, by Excel's formula; no width is the 8.43-character default. */
export const colPx = (w: number | undefined): number => (w === undefined ? 64 : Math.trunc(((256 * w + Math.trunc(128 / 7)) / 256) * 7))
/** A row `pt` points tall, never under 20 px. */
export const rowPx = (pt: number): number => Math.max(20, Math.round((pt * 4) / 3))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type XRule = any
type CfOut = { fill?: string; ink?: string; b?: true; bar?: { f: number; color: string } }

function cfThreshold(cfvo: { type: string; value?: unknown } | undefined, sorted: number[]): number | null {
  if (!cfvo || !sorted.length) return null
  const lo = sorted[0]
  const hi = sorted[sorted.length - 1]
  const n = Number(cfvo.value)
  switch (cfvo.type) {
    case 'min':
      return lo
    case 'max':
      return hi
    // Excel's Automatic bar runs from zero, so a row of positives keeps a visible lowest bar.
    case 'autoMin':
      return Math.min(0, lo)
    case 'autoMax':
      return Math.max(0, hi)
    case 'num':
      return Number.isFinite(n) ? n : null
    case 'percent':
      return Number.isFinite(n) ? lo + ((hi - lo) * n) / 100 : null
    case 'percentile': {
      if (!Number.isFinite(n)) return null
      const i = ((sorted.length - 1) * n) / 100
      const a = Math.floor(i)
      return sorted[a] + (sorted[Math.min(sorted.length - 1, a + 1)] - sorted[a]) * (i - a)
    }
    default:
      return null
  }
}
const mix = (a: string, b: string, t: number): string =>
  `#${[1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - t) + parseInt(b.slice(i, i + 2), 16) * t).toString(16).padStart(2, '0')).join('')}`
const CELL_IS: Record<string, (v: number, a: number, b: number) => boolean> = {
  equal: (v, a) => v === a,
  notEqual: (v, a) => v !== a,
  greaterThan: (v, a) => v > a,
  lessThan: (v, a) => v < a,
  greaterThanOrEqual: (v, a) => v >= a,
  lessThanOrEqual: (v, a) => v <= a,
  between: (v, a, b) => v >= Math.min(a, b) && v <= Math.max(a, b),
  notBetween: (v, a, b) => v < Math.min(a, b) || v > Math.max(a, b)
}
const literal = (f: unknown): number => (typeof f === 'string' && /^\s*-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i.test(f) ? Number(f) : NaN)

/** A rule Clui draws, as a function of a cell's value, or null for one it doesn't. */
function cfRule(rule: XRule, values: number[], theme: string[]): ((v: number) => CfOut | null) | null {
  if (rule.type === 'cellIs') {
    const op = CELL_IS[rule.operator]
    const [a, b] = (rule.formulae ?? []).map(literal)
    if (!op || Number.isNaN(a) || (/etween/.test(rule.operator) && Number.isNaN(b))) return null
    const st = rule.style ?? {}
    const fillC = st.fill?.type === 'pattern' ? colourOf(st.fill.bgColor ?? st.fill.fgColor, theme) : undefined
    const out: CfOut = { ...(fillC ? { fill: fillC } : {}), ...(colourOf(st.font?.color, theme) ? { ink: colourOf(st.font?.color, theme) } : {}), ...(st.font?.bold ? { b: true as const } : {}) }
    return (v) => (op(v, a, b) ? out : null)
  }
  const sorted = [...values].sort((x, y) => x - y)
  if (rule.type === 'colorScale') {
    const ts = (rule.cfvo ?? []).map((c: { type: string; value?: unknown }) => cfThreshold(c, sorted))
    const cs = (rule.color ?? []).map((c: XColor) => colourOf(c, theme))
    if (ts.length < 2 || ts.length !== cs.length || ts.some((t: number | null) => t === null) || cs.some((c: string | undefined) => !c)) return null
    return (v) => {
      if (v <= ts[0]) return { fill: cs[0] }
      for (let i = 1; i < ts.length; i++) if (v <= ts[i]) return { fill: mix(cs[i - 1], cs[i], ts[i] === ts[i - 1] ? 1 : (v - ts[i - 1]) / (ts[i] - ts[i - 1])) }
      return { fill: cs.at(-1) }
    }
  }
  if (rule.type === 'dataBar') {
    const [lo, hi] = [cfThreshold(rule.cfvo?.[0], sorted), cfThreshold(rule.cfvo?.[1], sorted)]
    const color = colourOf(rule.color, theme)
    if (lo === null || hi === null || !color) return null
    const min = typeof rule.minLength === 'number' ? rule.minLength / 100 : 0.1
    const max = typeof rule.maxLength === 'number' ? rule.maxLength / 100 : 0.9
    return (v) => {
      const t = hi === lo ? 1 : Math.min(1, Math.max(0, (v - lo) / (hi - lo)))
      return { bar: { f: Math.round((min + t * (max - min)) * 100) / 100, color } }
    }
  }
  return null
}

/** Reads a workbook's bytes into a book, or says why not. `onProgress` hears the fraction of worksheet XML parsed. */
export async function readWorkbook(bytes: Uint8Array, onProgress: (f: number) => void = () => {}): Promise<Book | BookFailure> {
  const bad = classify(bytes)
  if (bad) return bad
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let zip: JSZip
  let info: Awaited<ReturnType<typeof inspect>>
  try {
    zip = await JSZip.loadAsync(buf)
    info = await inspect(zip)
  } catch {
    return { t: 'damaged' }
  }
  const predicted = info.parts.reduce((n, p) => n + p.cells, 0)
  if (predicted > CELL_CEILING) return { t: 'too-many', cells: predicted }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const unzipped = Object.values(zip.files).reduce((n, f) => n + (((f as any)._data?.uncompressedSize as number) ?? 0), 0)
  if (unzipped > UNZIPPED_MAX) return { t: 'damaged' }

  // exceljs inflates each part to a string and streams it to its parser; counting that stream gives the progress, and
  // the sparkline groups exceljs drops are spotted in passing.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sizes = info.parts.map((p) => ((zip.file(p.part) as any)?._data?.uncompressedSize as number) ?? 0)
  const total = Math.max(1, sizes.reduce((a, b) => a + b, 0))
  let seen = 0
  let lastSaid = -1
  const sparks = new Set<string>()
  const wb = new ExcelJS.Workbook()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const x = wb.xlsx as any
  const parseSheet = x._processWorksheetEntry.bind(x)
  // ponytail: wraps a private exceljs 4.4.0 method for progress; pinned, and a version bump re-checks it.
  x._processWorksheetEntry = async (stream: AsyncIterable<string> & NodeJS.ReadableStream, model: unknown, sheetNo: string, options: unknown, path: string) => {
    const counted = new PassThrough({ objectMode: true })
    let tail = ''
    void (async () => {
      for await (const chunk of stream as AsyncIterable<string>) {
        seen += chunk.length
        if ((tail + chunk).includes('sparklineGroup')) sparks.add(path)
        tail = chunk.slice(-16)
        const f = Math.floor((seen / total) * 100)
        if (f !== lastSaid) onProgress(Math.min(1, (lastSaid = f) / 100))
        // Paced by the parser, so the count is what it has read rather than what's queued for it.
        if (!counted.write(chunk)) await once(counted, 'drain')
      }
      counted.end()
    })()
    return parseSheet(counted, model, sheetNo, options, path)
  }
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer)
  } catch {
    return { t: 'damaged' }
  }
  const date1904 = !!wb.properties?.date1904
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const theme = themeColours(((wb as any)._themes?.theme1 as string) ?? '')
  const styles: CellStyle[] = []
  const styleKeys = new Map<string, number>()
  const intern = (s: CellStyle): number => {
    const k = JSON.stringify(s)
    let id = styleKeys.get(k)
    if (id === undefined) {
      id = styles.push(s)
      styleKeys.set(k, id)
    }
    return id
  }
  const byObject = new WeakMap<object, number>()
  const baseStyle = (st: XStyle): number => {
    if (!st || (!st.fill && !st.font && !st.border && !st.alignment)) return 0
    let id = byObject.get(st)
    if (id === undefined) {
      const s = styleOf(st, theme)
      id = Object.keys(s).length ? intern(s) : 0
      byObject.set(st, id)
    }
    return id
  }
  const withInk = new Map<string, number>()
  const inked = (base: number, ink: string): number => {
    const k = `${base}|${ink}`
    let id = withInk.get(k)
    if (id === undefined) withInk.set(k, (id = intern({ ...(base ? styles[base - 1] : {}), ink })))
    return id
  }

  const ordered = [...wb.worksheets].sort((a, b) => (a as unknown as { orderNo: number }).orderNo - (b as unknown as { orderNo: number }).orderNo)
  const sheets: BookSheet[] = []
  for (const ws of ordered) {
    const part = info.parts.find((p) => p.name === ws.name)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = ws as any
    // ponytail: reads exceljs 4.4.0's row and cell arrays directly, the only way to see styled empty cells without
    // creating every cell; pinned like the progress hook.
    const rowsArr: (undefined | { number: number; height?: number; hidden?: boolean; _cells: (undefined | XStyle)[] })[] = w._rows ?? []
    const merges = Object.values((w._merges ?? {}) as Record<string, { model: { top: number; left: number; bottom: number; right: number } }>).map((m) => m.model)
    let maxR = -1
    let maxC = -1
    let n = 0
    for (const row of rowsArr) {
      if (!row) continue
      for (const cell of row._cells) if (cell) n++
    }
    const rowNo = new Uint32Array(n)
    const col = new Uint32Array(n)
    const style = new Uint32Array(n)
    const kind = new Uint8Array(n)
    const num = new Float64Array(n).fill(NaN)
    const text: string[] = new Array(n)
    const formula = new Map<number, string>()
    const link = new Map<number, string>()
    let uncalculated = 0
    let fonts = false
    let i = 0
    const put = (r: number, c: number, k: number, t: string, s: number): number => {
      rowNo[i] = r
      col[i] = c
      kind[i] = k
      text[i] = t
      style[i] = s
      if (r > maxR) maxR = r
      if (c > maxC) maxC = c
      return i++
    }
    const dates = new Map<string, string>()
    const textOf = (v: unknown): string =>
      typeof v === 'string' ? v : v && typeof v === 'object' && Array.isArray((v as { richText?: unknown }).richText) ? (v as { richText: { text: string }[] }).richText.map((t) => t.text).join('') : v == null ? '' : String(v)
    /** A value's kind and display text under a number format: what the cell shows, and its number. */
    const shown = (v: unknown, fmt: string | undefined): { k: number; t: string; n: number } => {
      if (typeof v === 'number') return { k: K.number, t: display(fmt, v, date1904), n: v }
      if (v instanceof Date) {
        const s = serialOf(v, date1904)
        // Format 14 is Excel's short date, what a date with no format of its own shows. Dates in a column repeat, so
        // each format and serial is formatted once.
        const key = `${fmt}\0${s}`
        let t = dates.get(key)
        if (t === undefined) dates.set(key, (t = display(fmt && fmt !== 'General' ? fmt : 14, s, date1904)))
        return { k: K.date, t, n: s }
      }
      if (typeof v === 'boolean') return { k: K.bool, t: v ? 'TRUE' : 'FALSE', n: NaN }
      if (v && typeof v === 'object' && 'error' in v) return { k: K.error, t: String((v as { error: unknown }).error), n: NaN }
      return { k: K.text, t: textOf(v), n: NaN }
    }
    for (const row of rowsArr) {
      if (!row) continue
      const r = row.number - 1
      for (const cell of row._cells) {
        if (!cell) continue
        const t = cell.type as number
        if (t === ExcelJS.ValueType.Merge) continue
        const st = cell.style
        const sid = baseStyle(st)
        const f = st?.font
        if (f && ((f.name && info.font.name && f.name !== info.font.name) || (f.size && info.font.size && f.size !== info.font.size))) fonts = true
        const c = (cell.col as number) - 1
        const fmt: string | undefined = typeof st?.numFmt === 'string' ? st.numFmt : undefined
        const v = cell.value
        if (t === ExcelJS.ValueType.Null) {
          if (sid && (styles[sid - 1].fill || styles[sid - 1].bd)) put(r, c, K.empty, '', sid)
          continue
        }
        if (t === ExcelJS.ValueType.Formula) {
          const fv = v as { formula?: string; result?: unknown; shareType?: string }
          const body = `=${cell.formula ?? fv.formula ?? ''}`
          const ftext = fv.shareType === 'array' ? `{${body}}` : body
          if (fv.result === undefined) {
            uncalculated++
            formula.set(put(r, c, K.text | K.uncalculated, ftext, sid), ftext)
            continue
          }
          const s = shown(fv.result, fmt)
          const at = put(r, c, s.k | K.cached, s.t, sid)
          num[at] = s.n
          formula.set(at, ftext)
          const ink = typeof fv.result === 'number' && fmt ? formatColour(fmt, fv.result) : undefined
          if (ink) style[at] = inked(sid, ink)
          continue
        }
        if (t === ExcelJS.ValueType.Hyperlink) {
          const hv = v as { text?: unknown; hyperlink?: string }
          const at = put(r, c, K.text, textOf(hv.text), sid)
          if (hv.hyperlink) link.set(at, hv.hyperlink)
          continue
        }
        const s = shown(v, fmt)
        const at = put(r, c, s.k, s.t, sid)
        num[at] = s.n
        const ink = typeof v === 'number' && fmt ? formatColour(fmt, v) : undefined
        if (ink) style[at] = inked(sid, ink)
      }
    }
    n = i
    for (const m of merges) {
      maxR = Math.max(maxR, m.bottom - 1)
      maxC = Math.max(maxC, m.right - 1)
    }
    const rows = maxR + 1
    const cols = maxC + 1
    const rowStart = new Uint32Array(rows + 1)
    for (let j = 0; j < n; j++) rowStart[rowNo[j] + 1]++
    for (let r = 0; r < rows; r++) rowStart[r + 1] += rowStart[r]
    // exceljs keeps rows in order and a row's cells by column, so the arrays are already row-major.

    // Conditional formatting: rules in priority order, a property set by a higher rule kept, stopIfTrue ending a cell.
    let cfUnsupported = false
    const cfBlocks = (w.conditionalFormattings ?? []) as { ref: string; rules: XRule[] }[]
    if (cfBlocks.length && rows) {
      const ruleList: { rule: XRule; cells: number[] }[] = []
      for (const b of cfBlocks) {
        const cells: number[] = []
        for (const part of String(b.ref).split(/\s+/)) {
          const rr = rangeRef(part)
          if (!rr) continue
          for (let r = rr.r0; r <= Math.min(rr.r1, rows - 1); r++)
            for (let j = rowStart[r]; j < rowStart[r + 1]; j++) if (col[j] >= rr.c0 && col[j] <= rr.c1 && Number.isFinite(num[j])) cells.push(j)
        }
        for (const rule of b.rules ?? []) ruleList.push({ rule, cells })
      }
      ruleList.sort((a, b) => (a.rule.priority ?? 0) - (b.rule.priority ?? 0))
      const out = new Map<number, CfOut>()
      const stopped = new Set<number>()
      for (const { rule, cells } of ruleList) {
        const fn = cfRule(rule, cells.map((j) => num[j]), theme)
        if (!fn) {
          cfUnsupported = true
          continue
        }
        for (const j of cells) {
          if (stopped.has(j)) continue
          const got = fn(num[j])
          if (!got) continue
          out.set(j, { ...got, ...out.get(j) })
          if (rule.stopIfTrue) stopped.add(j)
        }
      }
      const cfKeys = new Map<string, number>()
      for (const [j, o] of out) {
        const k = `${style[j]}|${JSON.stringify(o)}`
        let id = cfKeys.get(k)
        if (id === undefined) cfKeys.set(k, (id = intern({ ...(style[j] ? styles[style[j] - 1] : {}), ...o })))
        style[j] = id
      }
    }

    const view = (w.views?.[0] ?? {}) as { state?: string; xSplit?: number; ySplit?: number; topLeftCell?: string; showGridLines?: boolean }
    const frozen = view.state === 'frozen' ? { rows: Math.min(rows, Math.max(0, view.ySplit ?? 0)), cols: Math.min(cols, Math.max(0, view.xSplit ?? 0)) } : { rows: 0, cols: 0 }
    const top = view.state === 'frozen' && view.topLeftCell ? cellRef(view.topLeftCell) : null
    const defPt = Number(w.properties?.defaultRowHeight) || 15
    let heights: Float32Array | null = null
    const hiddenRows: number[] = []
    for (const row of rowsArr) {
      if (!row || row.number > rows) continue
      if (row.hidden) hiddenRows.push(row.number - 1)
      if (typeof row.height === 'number' && rowPx(row.height) !== rowPx(defPt)) (heights ??= new Float32Array(rows).fill(rowPx(defPt)))[row.number - 1] = rowPx(row.height)
    }
    if (!heights && rowPx(defPt) !== 20) heights = new Float32Array(rows).fill(rowPx(defPt))
    const defW = typeof w.properties?.defaultColWidth === 'number' ? colPx(w.properties.defaultColWidth) : 64
    const widths = new Float32Array(cols).fill(defW)
    const hiddenCols: number[] = []
    const columns = (w._columns ?? []) as ({ width?: number; hidden?: boolean } | undefined)[]
    for (let c = 0; c < cols; c++) {
      const cdef = columns[c]
      if (!cdef) continue
      if (typeof cdef.width === 'number') widths[c] = colPx(cdef.width)
      if (cdef.hidden) hiddenCols.push(c)
    }
    const flat = new Int32Array(merges.length * 4)
    const edges = new Uint32Array(merges.length * 2)
    merges.forEach((m, j) => {
      flat.set([m.top - 1, m.left - 1, m.bottom - 1, m.right - 1], j * 4)
      edges.set([baseStyle(rowsArr[m.top - 1]?._cells[m.right - 1]?.style), baseStyle(rowsArr[m.bottom - 1]?._cells[m.left - 1]?.style)], j * 2)
    })
    const dv = w.dataValidations?.model
    sheets.push({
      name: ws.name,
      hidden: ws.state !== 'visible',
      geo: {
        rows,
        cols,
        frozen,
        ...(top && top.r < rows && top.c < cols ? { top } : {}),
        gridlines: view.showGridLines !== false,
        heights,
        widths,
        hiddenRows: Int32Array.from(hiddenRows),
        hiddenCols: Int32Array.from(hiddenCols),
        merges: flat,
        mergeEdges: edges,
        gaps: {
          ...(part?.gaps ?? { charts: 0, images: 0, shapes: 0, pivots: 0, notes: false, slicers: false, controls: false }),
          uncalculated,
          cf: cfUnsupported,
          validation: !!dv && Object.keys(dv).length > 0,
          sparklines: !!part && sparks.has(part.part),
          fonts
        }
      },
      rowStart,
      col: col.slice(0, n),
      style: style.slice(0, n),
      kind: kind.slice(0, n),
      num: num.slice(0, n),
      text: text.join(''),
      textAt: offsetsOf(text, n),
      formula,
      link
    })
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const active = Number((wb as any).views?.[0]?.activeTab) || 0
  return {
    facts: {
      sheets: sheets.map((s) => ({ name: s.name, hidden: s.hidden, rows: s.geo.rows, cols: s.geo.cols })),
      styles,
      macros: info.macros,
      links: info.links,
      recalc: info.recalc,
      active: Math.min(Math.max(0, active), Math.max(0, sheets.length - 1))
    },
    date1904,
    sheets
  }
}
