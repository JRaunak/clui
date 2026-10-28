import type { ChangeObject } from 'diff'

/** Where each of a line diff's old-side lines sits on its new side when it survives unchanged, else -1. */
export function survivingLines(changes: ChangeObject<string>[], oldLines: number): Int32Array {
  const map = new Int32Array(oldLines).fill(-1)
  let ia = 0
  let ib = 0
  for (const c of changes) {
    if (c.added) ib += c.count
    else if (c.removed) ia += c.count
    else for (let j = 0; j < c.count; j++) map[ia++] = ib++
  }
  return map
}

/** Where old line `n` sits in the new text: itself if it survived, else just past the nearest survivor above it. */
export function movedLine(map: Int32Array | null, n: number): number {
  if (!map) return n
  for (let k = Math.min(n, map.length) - 1; k >= 0; k--) if (map[k] >= 0) return map[k] + 1 + (n - 1 - k)
  return n
}
