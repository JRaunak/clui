/**
 * Atomic JSON file write: write to a unique temp sibling, then rename over the target.
 *
 * A direct truncating `writeFile` can leave a half-written (or empty) file if the process
 * dies or the write fails mid-flight, and readers then treat the corruption as "no data"
 * and silently reset the user's state. Rename is atomic on the same filesystem, so a
 * reader ever sees either the old file or the fully-written new one, never a partial.
 */
import { mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function atomicWriteFile(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, data, 'utf8')
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}
