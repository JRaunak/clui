import type { ChangeSide, LineRange } from '../../../shared/context'
import type { LineKind } from '../components/surfaces/HunkView'

/** Rows a chip card's preview shows before it sends the user to the surface. */
export const PEEK_ROWS = 20

/** A diff row carries `oldNo`/`newNo`; a file or one-sided row carries `n`. */
export interface PeekRow { kind: LineKind; text: string; n?: number; oldNo?: number; newNo?: number; selected?: boolean }

/** A sent path is cwd-relative when it was inside the session's folder. */
export const absOf = (cwd: string | null, p: string): string => (p.startsWith('/') || !cwd ? p : `${cwd.replace(/\/+$/, '')}/${p}`)

/** A file's lines, the way the File surface numbers them: a trailing newline ends the last line, it doesn't add one. */
export function fileLines(text: string): string[] {
  const ls = text.split('\n')
  if (ls.length > 1 && ls.at(-1) === '') ls.pop()
  return ls
}

/** The lines a file preview shows. A range that fits gets the rest of the rows as context split around it, clamped to
 *  the file; a longer range shows its head. A whole file shows its head. */
export function fileWindow(total: number, lines?: LineRange): LineRange {
  if (!lines) return { start: 1, end: Math.min(total, PEEK_ROWS) }
  const k = lines.end - lines.start + 1
  if (k >= PEEK_ROWS) return { start: lines.start, end: lines.start + PEEK_ROWS - 1 }
  const end = Math.min(total, Math.max(1, lines.start - Math.floor((PEEK_ROWS - k) / 2)) + PEEK_ROWS - 1)
  return { start: Math.max(1, end - PEEK_ROWS + 1), end }
}

/** A change snapshot's rows. A diff slice keeps its `+`/`-`/` ` prefixes, so the numbers walk both sides from the
 *  ref's starts; a one-sided slice is plain lines from that side's start. */
export function changeRows(text: string, side: ChangeSide, old?: LineRange, neu?: LineRange): PeekRow[] {
  const ls = text.split('\n')
  if (side !== 'diff') {
    const from = (side === 'before' ? old : neu)?.start ?? 1
    return ls.map((t, i) => ({ kind: ' ', text: t, n: from + i }))
  }
  let o = old?.start ?? 1
  let n = neu?.start ?? 1
  return ls.map((l) => {
    const c = l[0]
    const kind: LineKind = c === '+' || c === '-' ? c : ' '
    return { kind, text: l.slice(1), ...(c === ' ' || c === '-' ? { oldNo: o++ } : {}), ...(c === ' ' || c === '+' ? { newNo: n++ } : {}) }
  })
}
