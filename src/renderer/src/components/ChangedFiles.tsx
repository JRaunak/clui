import { useEffect, useId, useState, type CSSProperties } from 'react'
import { useActive, useSession, EMPTY_CHANGES } from '../store'
import type { FileChangeSummary, GitPathStatus, GitUnavailableCause } from '../../../shared/changes'
import { IconChevron, IconFile } from './Icon'

/** Workspace-relative path; a file outside cwd stays absolute. */
function toWorkspaceRelative(cwd: string | null, path: string): string {
  return cwd && path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path
}

const MINUS = '−'
const lines = (n: number): string => `${n} ${n === 1 ? 'line' : 'lines'}`

/** The row's screen-reader description and its pointer tooltip's count line. */
function describe(c: FileChangeSummary): { description: string; countLine: string } {
  const { added, removed, created, approximate } = c
  let fragment: string
  let countLine: string
  if (added === null || removed === null) {
    fragment = 'Claude changed this file. Line counts unavailable'
    countLine = 'Claude: line counts unavailable'
  } else {
    const dropRemoved = created && removed === 0
    const figures = dropRemoved ? `+${added}` : `+${added} ${MINUS}${removed}`
    if (approximate) {
      fragment = `About ${lines(added)} added${dropRemoved ? '' : ` and ${removed} removed`} by Claude, approximate count`
      countLine = `Claude: ${created ? 'new file, ' : ''}about ${figures} lines (approximate)`
    } else if (added === 0 && removed === 0) {
      fragment = "Claude's edits net to no line changes"
      countLine = `Claude: ${figures} lines`
    } else {
      fragment = `Claude added ${lines(added)}${dropRemoved ? '' : ` and removed ${removed}`}`
      countLine = `Claude: ${created ? 'new file, ' : ''}${figures} lines`
    }
    if (created) fragment = `New file. ${fragment}`
  }
  if (c.missingOnDisk) {
    fragment = `File missing on disk. ${fragment}`
    countLine = `File missing on disk. ${countLine}`
  }
  return { description: `${fragment}.`, countLine }
}

function Figure({ n, sign, tone, width, approx }: { n: number | null; sign: string; tone: string; width: string; approx?: boolean }): JSX.Element {
  return (
    <span className={`inline-block text-right ${width} ${n ? tone : 'text-faint'}`}>
      {approx && <span className="text-faint">~</span>}
      {`${sign}${n ?? '?'}`}
    </span>
  )
}

const figureWidth = (n: number | null): number => String(n ?? '?').length + 1

const GIT_KIND: Record<string, string> = { M: 'modified', T: 'type changed', A: 'added', D: 'deleted', R: 'renamed', C: 'copied' }
const GIT_TONE: Record<string, string> = { M: 'text-dim', T: 'text-dim', A: 'text-ok', D: 'text-err', R: 'text-info', C: 'text-info' }
const GIT_CAUSE: Record<GitUnavailableCause, string> = {
  'git-missing': 'Git not found',
  timeout: 'Git took too long to respond',
  untrusted: 'Git does not trust this repository (safe.directory)',
  unreadable: "couldn't read the repository"
}
const GIT_ATTRIBUTION = 'Git shows repository state, which may include changes not made by Claude.'
const POLL_MS = 2000
/** States from a working tree Git did read, which make a failure elsewhere partial. */
const READ_STATES = new Set<GitPathStatus['state']>(['unlisted', 'changed', 'conflict'])

type GitLetters = Extract<GitPathStatus, { x: string }>
const lettered = (g: GitPathStatus | undefined): g is GitLetters => g?.state === 'changed' || g?.state === 'conflict'

/** The row's Git sentence, composed from the staged (X) and unstaged (Y) letters. */
function gitLine(g: GitPathStatus | undefined, rel: (p: string) => string): string | null {
  if (g?.state === 'unavailable') return 'Git: status unavailable'
  if (g?.state === 'conflict') return 'Git: merge conflict'
  if (g?.state !== 'changed') return null
  if (g.x === 'D' && g.recreated) return 'Git: deleted (staged). The path exists again as an untracked file'
  const kind = (c: string): string => {
    const word = GIT_KIND[c] ?? c
    if (c !== 'R' && c !== 'C') return word
    return g.renamedTo ? `${word} to ${rel(g.renamedTo)}` : g.renamedFrom ? `${word} from ${rel(g.renamedFrom)}` : word
  }
  const staged = g.x === '.' ? null : kind(g.x)
  const unstaged = g.y === '.' ? null : kind(g.y)
  if (staged && unstaged) return staged === unstaged ? `Git: ${staged}, staged and unstaged` : `Git: ${staged} (staged), ${unstaged} (unstaged)`
  if (staged) return `Git: ${staged}, staged`
  return unstaged && `Git: ${unstaged}, unstaged`
}

function GitCell({ c, conflict }: { c: string; conflict: boolean }): JSX.Element {
  if (c === '.') return <span className="text-faint">·</span>
  return <span className={conflict ? 'text-err' : (GIT_TONE[c] ?? 'text-dim')}>{c}</span>
}

export function ChangedFiles(): JSX.Element | null {
  const changes = useActive((s) => s?.changes ?? EMPTY_CHANGES)
  const cwd = useActive((s) => s?.cwd ?? null)
  const handleId = useActive((s) => s?.handleId ?? null)
  const gitStatus = useSession((s) => s.gitStatus)
  const refreshGitStatus = useSession((s) => s.refreshGitStatus)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listId = useId()
  const attrId = useId()

  // Git decoration only shows in the expanded tray, so it's read only while that's on screen. The
  // poll catches staging and commits made outside Clui, which no ledger event reports.
  const hasChanges = changes.length > 0
  useEffect(() => {
    if (!open || !handleId || !hasChanges) return
    const tick = (): void => {
      if (document.hasFocus() && !document.hidden) void refreshGitStatus(handleId)
    }
    tick()
    const timer = setInterval(tick, POLL_MS)
    window.addEventListener('focus', tick)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', tick)
    }
  }, [open, handleId, hasChanges, changes, refreshGitStatus])

  if (!hasChanges) return null

  const openFile = async (path: string): Promise<void> => {
    setError(null)
    try {
      await window.clui.openInEditor(path)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // The widest figure sets each column's width, so + and − line up across rows.
  const columns = {
    '--add-ch': `${Math.max(...changes.map((c) => figureWidth(c.added) + (c.approximate ? 1 : 0)))}ch`,
    '--del-ch': `${Math.max(...changes.map((c) => figureWidth(c.removed)))}ch`
  } as CSSProperties

  const rel = (p: string): string => toWorkspaceRelative(cwd, p)
  const gitColumn = changes.some((c) => lettered(gitStatus[c.path]))
  const failed = changes.map((c) => gitStatus[c.path]).find((g) => g?.state === 'unavailable')
  const someRead = changes.some((c) => READ_STATES.has(gitStatus[c.path]?.state ?? 'none'))
  const unavailable = failed?.state === 'unavailable' ? `Git status unavailable${someRead ? ' for some files' : ''}: ${GIT_CAUSE[failed.cause]}` : ''

  return (
    // The composer paints on top as the later sibling; this negative bottom margin tucks the card
    // behind its top edge so it reads as sliding out from under it. It hides while a Gate is in the
    // dock, including the Gate's exit, so it never floats on the dock's full-height frame.
    <div data-ui="changed-files" className="mx-auto -mb-3 w-full max-w-5xl px-11 group-has-[[data-ui=gate]]/dock:hidden">
      <div className="dock-fade-top rounded-t-xl border border-b-0 border-border bg-bg-elev px-4 pb-5 pt-1">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          className="-mx-1 flex h-6 items-center gap-1.5 rounded px-1 text-label text-dim transition-colors hover:text-content"
          onClick={() => setOpen((o) => !o)}
        >
          <IconChevron className={`h-3 w-3 transition-transform duration-fast ease-out ${open ? 'rotate-90' : ''}`} />
          <IconFile className="h-3.5 w-3.5" />
          Changed files
          <span className="rounded-full bg-bg-raised px-1.5 py-0.5 text-badge tabular-nums">{changes.length}</span>
        </button>
        {open && (
          <>
            {gitColumn && (
              <p id={attrId} className="sr-only">
                Git letters describe the repository and may include changes not made by Claude. Line counts are Claude's edits only.
              </p>
            )}
            <ul
              id={listId}
              style={columns}
              aria-describedby={gitColumn ? attrId : undefined}
              className="-mx-1 mt-0.5 flex max-h-48 flex-col overflow-y-auto"
            >
              {changes.map((c) => {
                const name = rel(c.path)
                const cut = name.lastIndexOf('/')
                const dir = cut > 0 ? name.slice(0, cut) : ''
                const base = cut >= 0 ? name.slice(cut + 1) : name
                const { description, countLine } = describe(c)
                const g = gitStatus[c.path]
                const git = gitLine(g, rel)
                const target = g?.state === 'changed' && g.renamedTo ? `→ ${rel(g.renamedTo)}` : null
                const state = c.missingOnDisk ? 'File missing' : c.created ? 'new' : null
                const hideRemoved = c.created && c.removed === 0
                return (
                  <li key={c.path}>
                    <button
                      type="button"
                      className="flex h-6 w-full items-baseline gap-2 rounded px-1 text-left leading-6 transition-colors hover:bg-control-hover"
                      onClick={() => void openFile(c.path)}
                      aria-label={name}
                      aria-description={git ? `${description} ${git}.` : description}
                      title={[c.path, countLine, ...(git ? [git, GIT_ATTRIBUTION] : []), 'Click to open in editor'].join('\n')}
                    >
                      {gitColumn && (
                        <span aria-hidden="true" className="inline-flex w-[2ch] shrink-0 font-mono text-badge">
                          {lettered(g) && (
                            <>
                              <GitCell c={g.x} conflict={g.state === 'conflict'} />
                              <GitCell c={g.y} conflict={g.state === 'conflict'} />
                            </>
                          )}
                        </span>
                      )}
                      <span className={`min-w-0 truncate font-mono text-code ${g?.state === 'conflict' ? 'text-err' : 'text-content'}`}>{base}</span>
                      {/* Rendered even when empty: it takes the row's slack, keeping the state word beside the figures. */}
                      <span aria-hidden="true" className="min-w-0 flex-1 truncate font-mono text-meta text-faint">{target ?? dir}</span>
                      {state && <span aria-hidden="true" className="shrink-0 text-meta text-dim">{state}</span>}
                      <span aria-hidden="true" className="ml-auto flex shrink-0 gap-1.5 text-meta tabular-nums">
                        <Figure n={c.added} sign="+" tone="text-ok" width="w-(--add-ch)" approx={c.approximate} />
                        {hideRemoved ? (
                          <span className="inline-block w-(--del-ch)" />
                        ) : (
                          <Figure n={c.removed} sign={MINUS} tone="text-err" width="w-(--del-ch)" />
                        )}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
            {/* Kept mounted while empty so a cause that appears later is announced. */}
            <p aria-live="polite" className="mt-1 px-1 text-meta text-faint empty:mt-0">
              {unavailable}
            </p>
            {error && <p role="alert" className="mt-1 text-meta text-err">{error}</p>}
          </>
        )}
      </div>
    </div>
  )
}
