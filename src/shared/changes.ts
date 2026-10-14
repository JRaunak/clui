/** One hunk of a tool result's `structuredPatch`, as the CLI sends it. */
export interface PatchHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
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
