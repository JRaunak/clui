import { dirname, isAbsolute, resolve } from 'node:path'

/** Where a folder dialog opens: the nearest folder that exists at or above the one asked for, since a suggested
 *  folder like ~/.clui may not be made yet. `fallback` is only for a caller that asked for nothing. */
export async function nearestDir(asked: string, fallback: string, isDir: (p: string) => Promise<boolean>): Promise<string | undefined> {
  if (!asked || !isAbsolute(asked)) return fallback && isAbsolute(fallback) && (await isDir(fallback)) ? fallback : undefined
  for (let d = resolve(asked); ; d = dirname(d)) {
    if (await isDir(d)) return d
    if (dirname(d) === d) return undefined
  }
}
