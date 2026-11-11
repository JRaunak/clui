export const FACE_COUNT = 12

/** One agent launch in its scope's order. `end` is the point in that order where it let go of its face, null while it
 *  holds it for good (or nobody knows). */
export interface Launch {
  key: string
  at: number
  end: number | null
}

/** Launch order hands out faces, skipping any an earlier launch still holds; with all twelve held it reuses the next in
 *  turn. Deterministic from the launch list, so a relaunch that rebuilds the list gets the same faces back. */
export function assignFaces(launches: readonly Launch[], start = 0, reserved: ReadonlySet<number> = new Set()): Map<string, number> {
  const out = new Map<string, number>()
  let cursor = start % FACE_COUNT
  launches.forEach((l, i) => {
    const held = new Set(reserved)
    for (const p of launches.slice(0, i)) if (p.end === null || p.end > l.at) held.add(out.get(p.key)!)
    let f = cursor
    for (let n = 0; n < FACE_COUNT && held.has(f); n++) f = (f + 1) % FACE_COUNT
    out.set(l.key, f)
    cursor = (f + 1) % FACE_COUNT
  })
  return out
}
