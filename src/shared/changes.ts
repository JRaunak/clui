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
  /** Every segment's before and after text is still held, so a diff can be shown. */
  diffAvailable: boolean
  segments: number
  editIds: string[]
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
