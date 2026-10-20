import { changeSelection, type ChangeSelection, type DiffHunk, type HunkRows, type PatchHunk } from '../../../shared/changes'
import type { ChangeSide } from '../../../shared/context'
import type { ChangeRefRequest } from '../../../shared/ipc'
import type { SurfaceSelection } from '../../../shared/surfaces'
import { CHANGE_DENIED, tooLargeText } from './refCopy'

export type DiffSelection = NonNullable<SurfaceSelection['change']>

/** Main's own idempotence key, so the same selection finds the same ref here. */
const requestKey = (r: Pick<ChangeRefRequest, 'revision' | 'hunkId' | 'side' | 'rows'>): string =>
  [r.revision, r.hunkId, r.side, r.rows ? `${r.rows.start}-${r.rows.end}` : ''].join('\0')

/** Per handle, each ref this renderer minted and the request behind it. A chip from a relaunch has none. */
const minted = new Map<string, Map<string, ChangeRefRequest>>()

export function recordMint(handleId: string, changeRef: string, req: ChangeRefRequest): void {
  const m = minted.get(handleId) ?? new Map<string, ChangeRefRequest>()
  m.set(changeRef, req)
  minted.set(handleId, m)
}

export function mintedRef(handleId: string, req: ChangeRefRequest): string | null {
  const key = requestKey(req)
  for (const [ref, r] of minted.get(handleId) ?? []) if (requestKey(r) === key) return ref
  return null
}

export const mintedRequest = (handleId: string, changeRef: string): ChangeRefRequest | null => minted.get(handleId)?.get(changeRef) ?? null

/** A range over every shown line is the whole hunk, so the same text selected two ways mints one ref. A trailing
 *  `\ No newline` row is never shown, so it can't hold a range back. */
export const normalRows = (h: PatchHunk, rows?: HunkRows): HunkRows | undefined =>
  !rows || (rows.start === 1 && h.lines.slice(rows.end).every((l) => l[0] === '\\')) ? undefined : rows

/** Rendered rows in range: `\ No newline` rows aren't shown, so they aren't counted. */
export function rowCount(h: PatchHunk, rows?: HunkRows): number {
  const { start, end } = rows ?? { start: 1, end: h.lines.length }
  return h.lines.slice(start - 1, end).filter((l) => l[0] !== '\\').length
}

export function sideEmpty(h: PatchHunk, side: ChangeSide, rows?: HunkRows): boolean {
  const c = changeSelection(h, side, rows)
  return !c.ok && c.reason === 'empty'
}

/** The Diff tab's selection for `rows` of `h`. A side with no lines in the range falls back to diff, and says so. */
export function diffSelection(path: string, h: DiffHunk, want: ChangeSide, rows?: HunkRows): { sel: DiffSelection; fellFrom?: ChangeSide } {
  const r = normalRows(h, rows)
  const side = want !== 'diff' && sideEmpty(h, want, r) ? 'diff' : want
  const c = changeSelection(h, side, r)
  const sel: DiffSelection = {
    path,
    segmentId: h.segmentId,
    revision: h.revision,
    hunkId: h.id,
    side,
    ...(r ? { rows: r } : {}),
    ...(c.old ? { old: c.old } : {}),
    ...(c.new ? { new: c.new } : {}),
    fits: c.ok
  }
  return side === want ? { sel } : { sel, fellFrom: want }
}

export const requestOf = (s: DiffSelection): ChangeRefRequest => ({
  path: s.path,
  segmentId: s.segmentId,
  revision: s.revision,
  hunkId: s.hunkId,
  side: s.side,
  ...(s.rows ? { rows: s.rows } : {})
})

/** Why the bar can't add, in its order of precedence; undefined when it can. `null` changeRead is before init:
 *  mint decides. */
export function changeBlocked(changeRead: boolean | null, c: ChangeSelection): string | undefined {
  if (changeRead === false) return CHANGE_DENIED
  if (!c.ok && c.reason === 'too-large') return tooLargeText(c.lines, c.bytes)
  return undefined
}
