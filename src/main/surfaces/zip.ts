/** A zip's central directory and single entries, read by range so nothing else in the archive is read or inflated. */
import { inflateRawSync } from 'node:zlib'

export type Read = (offset: number, length: number) => Promise<Buffer | null>
export interface ZipEntry { name: string; method: number; compressed: number; size: number; at: number }

const EOCD = Buffer.from('504b0506', 'hex')

/** Every entry in the directory, or null for what it can't follow: not a zip, zip64, a damaged directory. */
export async function zipEntries(size: number, read: Read): Promise<ZipEntry[] | null> {
  const from = Math.max(0, size - 22 - 0xffff)
  const tail = await read(from, size - from)
  const e = tail ? tail.lastIndexOf(EOCD) : -1
  if (!tail || e < 0 || e + 22 > tail.length) return null
  const total = tail.readUInt16LE(e + 10)
  const cd = await read(tail.readUInt32LE(e + 16), tail.readUInt32LE(e + 12))
  if (!cd) return null
  const out: ZipEntry[] = []
  let p = 0
  for (; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50; p += 46 + cd.readUInt16LE(p + 28) + cd.readUInt16LE(p + 30) + cd.readUInt16LE(p + 32)) {
    out.push({
      name: cd.toString('utf8', p + 46, p + 46 + cd.readUInt16LE(p + 28)),
      method: cd.readUInt16LE(p + 10),
      compressed: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      at: cd.readUInt32LE(p + 42)
    })
  }
  return out.length === total ? out : null
}

/** One entry's bytes, inflated no further than the size the directory declares. Null when it can't be read. */
export async function zipPart(e: ZipEntry, read: Read): Promise<Buffer | null> {
  if (e.method !== 0 && e.method !== 8) return null
  const local = await read(e.at, 30)
  if (!local || local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) return null
  const raw = await read(e.at + 30 + local.readUInt16LE(26) + local.readUInt16LE(28), e.compressed)
  if (!raw) return null
  if (e.method === 0) return raw.length === e.size ? raw : null
  try {
    return inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size) })
  } catch {
    return null
  }
}
