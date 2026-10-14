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
