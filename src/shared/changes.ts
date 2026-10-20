import type { ChangeSide, LineRange } from './context'

/** One hunk of a tool result's `structuredPatch`, as the CLI sends it. */
export interface PatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export const CHANGE_LINES_MAX = 400
/** UTF-8 bytes of the text `change_read` would return. */
export const CHANGE_BYTES_MAX = 32 * 1024
/** Change text one message may carry, and what `change_read` returns per handle in a rolling minute: equal, so
 *  Claude can always read everything that was sent. */
export const CHANGE_TEXT_BUDGET = 128 * 1024

/** 1-based indices into `PatchHunk.lines`, inclusive. */
export interface HunkRows { start: number; end: number }

export type ChangeSelection =
  | { ok: true; text: string; old?: LineRange; new?: LineRange; lines: number; bytes: number }
  | { ok: false; reason: 'empty' | 'too-large'; lines: number; bytes: number }

const utf8 = new TextEncoder()

/** The text one side of a hunk slice reads as, numbered as `DiffSurface` numbers its rows. `rows` absent = the whole
 *  hunk. `diff` keeps every row verbatim, `\ No newline` rows included; `before`/`after` drop them. */
export function changeSelection(h: PatchHunk, side: ChangeSide, rows?: HunkRows): ChangeSelection {
  const { start, end } = rows ?? { start: 1, end: h.lines.length }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || start > end || end > h.lines.length) return { ok: false, reason: 'empty', lines: 0, bytes: 0 }
  const out: string[] = []
  let old: LineRange | undefined
  let neu: LineRange | undefined
  let o = h.oldStart
  let n = h.newStart
  h.lines.forEach((l, i) => {
    const c = l[0]
    const before = c === ' ' || c === '-'
    const after = c === ' ' || c === '+'
    if (i + 1 >= start && i + 1 <= end) {
      if (before) old = { start: old?.start ?? o, end: o }
      if (after) neu = { start: neu?.start ?? n, end: n }
      if (side === 'diff') out.push(l)
      else if (side === 'before' ? before : after) out.push(l.slice(1))
    }
    if (before) o++
    if (after) n++
  })
  const text = out.join('\n')
  const lines = out.length
  const bytes = utf8.encode(text).length
  if (!(side === 'before' ? old : side === 'after' ? neu : old ?? neu)) return { ok: false, reason: 'empty', lines, bytes }
  if (lines > CHANGE_LINES_MAX || bytes > CHANGE_BYTES_MAX) return { ok: false, reason: 'too-large', lines, bytes }
  return { ok: true, text, ...(old ? { old } : {}), ...(neu ? { new: neu } : {}), lines, bytes }
}

/**
 * What Claude changed in one file, from the main-side ledger. Counts are Claude's lines only;
 * null means the evidence can't support a number, never zero.
 */
export interface FileChangeSummary {
  path: string
  added: number | null
  removed: number | null
  created: boolean
  missingOnDisk: boolean
  approximate: boolean
  /** Every segment still holds its before and after text or its edits' own hunks, so a diff can be shown. */
  diffAvailable: boolean
  /** The latest segment holds its whole before and after, so it can open as a diff in the editor. */
  snapshot: boolean
  segments: number
  editIds: string[]
}

/** One hunk of a Claude changes diff, identified by its exact bytes in one segment revision. */
export interface DiffHunk extends PatchHunk {
  id: string
  segmentId: string
  revision: string
  /** 1-based lines its added lines (or its removal's spot) occupy in the file now, when all of them survive. */
  current?: { start: number; end: number }
}

/**
 * One segment of a file's diff. `full` diffs the segment's first before against its last after;
 * `patch` shows each edit's own hunks, numbered as the file stood at that edit; `none` has nothing
 * recorded to show.
 */
export interface DiffSegment {
  id: string
  revision: string
  mode: 'full' | 'patch' | 'none'
  /** One group in full mode; in patch mode, one per edit that has hunks; none in none mode. */
  groups: DiffHunk[][]
  /** The file was changed outside Claude just before this segment. */
  outsideBefore: boolean
  /** Both texts are held, so the segment can open as a diff in the editor. */
  snapshot: boolean
}

export interface FileDiff {
  path: string
  segments: DiffSegment[]
  /** The file on disk differs from Claude's last version of it. */
  changedSince: boolean
  /** Hunks past the size cap were left out. */
  truncated: boolean
}

/**
 * Where Claude's changes to a file survive in its current text, per Claude changes hunk. Lines are
 * 1-based in the text whose `revision` (readText's) they were projected onto. `created` marks a
 * file Claude wrote whole and nobody has changed since; `unavailable` means the record can't
 * attribute current lines safely, so none are marked.
 */
export interface ChangeMarks {
  revision: string
  state: 'marked' | 'created' | 'unavailable'
  hunks: { id: string; bars: [number, number][]; wedge?: { line: number; count: number } }[]
}

export interface DiffRequest {
  path: string
  segmentId?: string
}

export interface ChangesEvent {
  handleId: string
  summaries: FileChangeSummary[]
}

/** Why Git couldn't be read for a row's working tree. */
export type GitUnavailableCause = 'git-missing' | 'timeout' | 'untrusted' | 'unreadable'

/**
 * Git's view of one Changed Files path. It describes the repository, so it can include changes
 * not made by Claude, and it never feeds the ledger's counts. `x`/`y` are porcelain v2's index
 * and worktree letters, `.` for unchanged.
 */
export type GitPathStatus =
  | { state: 'none' }
  /** Git read the tree and has no record for the path: tracked and clean, untracked, or ignored. */
  | { state: 'unlisted' }
  | { state: 'unavailable'; cause: GitUnavailableCause }
  | { state: 'conflict'; x: string; y: string }
  | {
      state: 'changed'
      x: string
      y: string
      /** Absolute path of the rename/copy pair's other side, whichever side the ledger path is. */
      renamedTo?: string
      renamedFrom?: string
      /** A staged deletion whose path exists again on disk, untracked. */
      recreated?: boolean
    }

/** Keyed by the ledger's absolute path; every candidate has an entry. */
export type ChangeGitStatus = Record<string, GitPathStatus>
