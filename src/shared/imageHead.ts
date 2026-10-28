// What the image surface learns from a file before anything decodes it: the format its magic bytes name, the pixel
// size its header states, and whether its bytes reach the format's end. Main reads it; the renderer decides from it.

export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'avif' | 'svg'

export interface ImageHead {
  /** Null when the bytes are none of the shown formats, whatever the name says. */
  format: ImageFormat | null
  /** Pixels as shown, after EXIF orientation. Absent for SVG, which Chromium lays out itself. */
  w?: number
  h?: number
  /** EXIF orientation 2 to 8, absent when it's 1 or missing. JPEG only. */
  orientation?: number
  /** The file can animate: GIF, APNG, animated WebP, an AVIF sequence. ImageDecoder has the last word. */
  animated: boolean
  /** The bytes reach the format's end marker. JPEG and SVG have none to check, so they always do. */
  complete: boolean
}

export type ByteReader = (offset: number, length: number) => Promise<Uint8Array>

/** Read once up front; every format's size field sits inside it except a JPEG's after big APP segments. */
export const HEAD_BYTES = 64 * 1024
/** The most pixels Clui decodes. A downscaled decode of a 48 MP PNG still allocated it at full size (258 MB over
 *  idle, measured in Electron 43), so bigger ones aren't shown reduced either. */
export const MAX_PIXELS = 40_000_000
const WALK_MAX = 4096

const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n))
const be16 = (b: Uint8Array, at: number): number => (b[at] << 8) | b[at + 1]
const be32 = (b: Uint8Array, at: number): number => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0
const le16 = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8)
const le24 = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16)
const le32 = (b: Uint8Array, at: number): number => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0
const starts = (b: Uint8Array, sig: number[]): boolean => b.length >= sig.length && sig.every((v, i) => b[i] === v)

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])
const SNIFF = 4096

/** The text opens with an `<svg` element after an optional prolog, comments and doctype. A linear scan: a regex with
 *  nested repeats backtracks exponentially on a run of empty comments, and this runs in main. */
export function isSvgText(text: string): boolean {
  const t = text.slice(0, SNIFF)
  let i = 0
  const skip = (): void => {
    while (i < t.length && /\s/.test(t[i])) i++
  }
  skip()
  if (t.startsWith('<?xml', i)) {
    const end = t.indexOf('?>', i)
    if (end < 0) return false
    i = end + 2
  }
  for (;;) {
    skip()
    if (t.startsWith('<!--', i)) {
      const end = t.indexOf('-->', i + 4)
      if (end < 0) return false
      i = end + 3
    } else if (t.slice(i, i + 9).toUpperCase() === '<!DOCTYPE') {
      const open = t.indexOf('[', i)
      const close = t.indexOf('>', i)
      if (close < 0) return false
      // An internal subset ends at `]>`; a plain doctype at its first `>`.
      const end = open >= 0 && open < close ? t.indexOf(']>', open) : close - 1
      if (end < 0) return false
      i = end + 2
    } else break
  }
  return /^<svg[\s>/]/i.test(t.slice(i, i + 5))
}

/** EXIF orientation from an APP1 segment's body, or 1. */
export function exifOrientation(seg: Uint8Array): number {
  if (ascii(seg, 0, 6) !== 'Exif\0\0') return 1
  const t = seg.subarray(6)
  const le = ascii(t, 0, 2) === 'II'
  if (!le && ascii(t, 0, 2) !== 'MM') return 1
  const u16 = (at: number): number => (le ? le16(t, at) : be16(t, at))
  const u32 = (at: number): number => (le ? le32(t, at) : be32(t, at))
  const ifd = u32(4)
  if (ifd + 2 > t.length) return 1
  const n = u16(ifd)
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12
    if (e + 12 > t.length) return 1
    if (u16(e) === 0x0112) {
      const v = u16(e + 8)
      return v >= 1 && v <= 8 ? v : 1
    }
  }
  return 1
}

async function png(read: ByteReader, head: Uint8Array, size: number): Promise<ImageHead> {
  let animated = false
  // Chunks up to the first IDAT: an acTL before it makes the file an APNG.
  for (let off = 8, n = 0; off + 8 <= size && n < WALK_MAX; n++) {
    const c = off + 8 <= head.length ? head.subarray(off, off + 8) : await read(off, 8)
    const type = ascii(c, 4, 4)
    if (type === 'acTL') animated = true
    if (type === 'IDAT' || type === 'IEND') break
    off += 12 + be32(c, 0)
  }
  const tail = await read(Math.max(0, size - 64), Math.min(64, size))
  return { format: 'png', w: be32(head, 16), h: be32(head, 20), animated, complete: ascii(tail, 0, tail.length).includes('IEND') }
}

async function jpeg(read: ByteReader, head: Uint8Array, size: number): Promise<ImageHead> {
  let orientation = 1
  let w: number | undefined
  let h: number | undefined
  for (let off = 2, n = 0; off + 4 <= size && n < WALK_MAX && w === undefined; n++) {
    const m = off + 4 <= head.length ? head.subarray(off, off + 4) : await read(off, 4)
    if (m[0] !== 0xff) break
    const marker = m[1]
    // Fill bytes before a marker.
    if (marker === 0xff) {
      off++
      continue
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      off += 2
      continue
    }
    if (marker === 0xda || marker === 0xd9) break
    const len = be16(m, 2)
    if (SOF.has(marker)) {
      const f = await read(off + 4, 5)
      h = be16(f, 1)
      w = be16(f, 3)
    } else if (marker === 0xe1 && orientation === 1) {
      orientation = exifOrientation(await read(off + 4, Math.max(0, len - 2)))
    }
    off += 2 + len
  }
  const turned = orientation >= 5
  return {
    format: 'jpeg',
    ...(w !== undefined && h !== undefined ? { w: turned ? h : w, h: turned ? w : h } : {}),
    ...(orientation !== 1 ? { orientation } : {}),
    animated: false,
    complete: true
  }
}

function webp(head: Uint8Array, size: number): ImageHead {
  const complete = le32(head, 4) + 8 <= size
  const chunk = ascii(head, 12, 4)
  if (chunk === 'VP8X') return { format: 'webp', w: 1 + le24(head, 24), h: 1 + le24(head, 27), animated: !!(head[20] & 0x02), complete }
  if (chunk === 'VP8L') {
    const b = head.subarray(21, 25)
    return { format: 'webp', w: 1 + (b[0] | ((b[1] & 0x3f) << 8)), h: 1 + ((b[1] >> 6) | (b[2] << 2) | ((b[3] & 0x0f) << 10)), animated: false, complete }
  }
  return { format: 'webp', w: le16(head, 26) & 0x3fff, h: le16(head, 28) & 0x3fff, animated: false, complete }
}

async function avif(read: ByteReader, head: Uint8Array, size: number, brands: string[]): Promise<ImageHead> {
  // The largest `ispe` is the primary image's; an alpha plane or a thumbnail is never bigger.
  let w = 0
  let h = 0
  for (let i = head.indexOf(0x69); i >= 0 && i + 16 <= head.length; i = head.indexOf(0x69, i + 1)) {
    if (ascii(head, i, 4) !== 'ispe') continue
    const iw = be32(head, i + 8)
    const ih = be32(head, i + 12)
    if (iw * ih > w * h) [w, h] = [iw, ih]
  }
  // A top-level box that runs past the end is a cut file.
  let complete = true
  for (let off = 0, n = 0; off < size && n < WALK_MAX; n++) {
    if (off + 8 > size) {
      complete = false
      break
    }
    const b = off + 16 <= head.length ? head.subarray(off, off + 16) : await read(off, Math.min(16, size - off))
    let len = be32(b, 0)
    if (len === 1) len = b.length >= 16 ? be32(b, 8) * 2 ** 32 + be32(b, 12) : Infinity
    if (len === 0) break
    if (len < 8 || off + len > size) {
      complete = false
      break
    }
    off += len
  }
  return { format: 'avif', ...(w && h ? { w, h } : {}), animated: brands.includes('avis'), complete }
}

/** The head of a file of `size` bytes, from its first HEAD_BYTES; `read` fetches anything past them. */
export async function readImageHead(head: Uint8Array, size: number, read: ByteReader): Promise<ImageHead> {
  const none: ImageHead = { format: null, animated: false, complete: true }
  if (starts(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) && head.length >= 24 && ascii(head, 12, 4) === 'IHDR') return png(read, head, size)
  if (starts(head, [0xff, 0xd8, 0xff])) return jpeg(read, head, size)
  if ((ascii(head, 0, 6) === 'GIF87a' || ascii(head, 0, 6) === 'GIF89a') && head.length >= 10) {
    const tail = await read(Math.max(0, size - 16), Math.min(16, size))
    return { format: 'gif', w: le16(head, 6), h: le16(head, 8), animated: true, complete: tail.includes(0x3b) }
  }
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP' && head.length >= 30) return webp(head, size)
  if (ascii(head, 4, 4) === 'ftyp') {
    const box = Math.min(be32(head, 0), head.length)
    const brands = [ascii(head, 8, 4), ...Array.from({ length: Math.max(0, (box - 16) / 4) }, (_, i) => ascii(head, 16 + i * 4, 4))]
    return brands.includes('avif') || brands.includes('avis') ? avif(read, head, size, brands) : none
  }
  // The decoder drops a BOM.
  return isSvgText(new TextDecoder('utf-8').decode(head.subarray(0, SNIFF))) ? { format: 'svg', animated: false, complete: true } : none
}

/** Too many pixels to decode, by the header alone. */
export const tooLarge = (h: ImageHead): boolean => h.w !== undefined && h.h !== undefined && h.w * h.h > MAX_PIXELS
