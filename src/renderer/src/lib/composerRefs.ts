import { changeLabel, refLabel, type RefInput } from '../../../shared/context'
import type { ChangeRefRequest } from '../../../shared/ipc'
import type { SurfaceTab } from '../../../shared/surfaces'
import { requestOf } from './changeRefs'
import { CHANGE_DENIED_HERE, spokenChange, spokenRef } from './refCopy'
import { tilde } from './tree'

/**
 * Removes an `@` token whose pick became a chip: from the `@` to the first whitespace at or after the caret, so a
 * mid-token caret leaves no fragment. One whitespace of the seam goes, or the one after a token that opened the text.
 */
export function removeToken(text: string, start: number, caret: number): { text: string; caret: number } {
  const rest = text.slice(caret).search(/\s/)
  let before = text.slice(0, start)
  let after = text.slice(rest < 0 ? text.length : caret + rest)
  // A line break after the token is kept, so the space before it goes instead.
  if (/^\s/.test(after) && (!before || /\s$/.test(before))) {
    if (before && after[0] === '\n') before = before.slice(0, -1)
    else after = after.slice(1)
  }
  return { text: before + after, caret: before.length }
}

/** `src/main/browser/`, `./` at the top level. */
const dirOf = (rel: string): string => {
  const i = rel.lastIndexOf('/')
  return i < 0 ? './' : rel.slice(0, i + 1)
}

/** A file row adds `input`; the Diff row carries the selection to mint first, since a change ref only exists once
 *  main snapshots it. */
export type PaneRow = ({ input: RefInput; mint?: undefined } | { mint: ChangeRefRequest; input?: undefined }) & {
  key: string
  label: string
  /** What a query ranks on: the file's path, relative to the session folder or `~`-shortened outside it. */
  rel: string
  hint: string
  aria: string
}

export interface PaneState {
  inDraft: (r: RefInput) => boolean
  /** Whether the draft already holds the ref this selection minted. */
  minted: (req: ChangeRefRequest) => boolean
  changeRead: boolean | null
}

/** The `@` menu's Open in pane rows, newest tab first: per File tab its selection when its revision is known, then
 *  the whole file; an image tab only its whole file; the Diff tab only its selected change, never a whole file. A tab
 *  presenting a past revision of its file is left out. */
export function paneRows(tabs: readonly SurfaceTab[], cwd: string | null, home: string, st: PaneState): PaneRow[] {
  const out: PaneRow[] = []
  const open = tabs
    .filter((t) => ((t.kind === 'file' || t.kind === 'image') && !t.provenance?.creatingEditId) || (t.kind === 'diff' && !!t.selection?.change))
    .sort((a, b) => b.lastViewedAt - a.lastViewedAt)
  for (const t of open) {
    const change = t.kind === 'diff' ? t.selection?.change : undefined
    const path = change?.path ?? t.key
    const rel = cwd && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : tilde(path, home)
    const dir = dirOf(rel)
    const where = dir === './' ? '' : `, in ${dir.slice(0, -1)}`
    if (change) {
      const mint = requestOf(change)
      const [hint, said] =
        st.changeRead === false
          ? [CHANGE_DENIED_HERE, `, ${CHANGE_DENIED_HERE}`]
          : !change.fits
            ? ['Too large to add', ', too large to add']
            : st.minted(mint)
              ? ['In message', ', in message']
              : [`Selected change · ${dir}`, '']
      out.push({ key: `change:${t.id}`, mint, label: changeLabel(path, change.side, change.old, change.new), rel, hint, aria: `${spokenChange(change)}, selected${where}${said}` })
      continue
    }
    const row = (key: string, input: RefInput, hint: string, spoken: string): PaneRow => {
      const attached = st.inDraft(input)
      return { key, input, label: refLabel(input), rel, hint: attached ? 'In message' : hint, aria: `${spoken}${where}${attached ? ', in message' : ''}` }
    }
    const { lines, sourceVersion } = t.selection ?? {}
    if (lines && sourceVersion) {
      const input: RefInput = { kind: 'file', path: t.key, lines, sourceVersion }
      out.push(row(`sel:${t.id}`, input, `Selected · ${dir}`, `${spokenRef(input)}, selected`))
    }
    const whole: RefInput = { kind: 'file', path: t.key }
    out.push(row(`file:${t.id}`, whole, dir, `${spokenRef(whole)}, open in pane`))
  }
  return out
}

/** The `@` text for a path that can't be a chip: workspace-relative when under cwd, else absolute. */
export function toWorkspaceRef(abs: string, cwd: string | null): string {
  if (cwd) {
    const base = cwd.endsWith('/') ? cwd : cwd + '/'
    if (abs === cwd) return abs
    if (abs.startsWith(base)) return abs.slice(base.length)
  }
  return abs
}

/** Pathful dropped items split by what main authorized: chips in drop order, and `@` text for the rest. Main also
 *  refuses paths inside the folder (a symlink, a session in `~`), so `outside` counts only the ones that really are. */
export function routeDrop(paths: readonly string[], kinds: readonly ('file' | 'folder' | null | undefined)[], cwd: string | null): { refs: RefInput[]; mentions: string[]; outside: number } {
  const refs: RefInput[] = []
  const mentions: string[] = []
  let outside = 0
  paths.forEach((path, i) => {
    const kind = kinds[i]
    if (kind) return void refs.push(kind === 'file' ? { kind: 'file', path } : { kind: 'folder', path })
    mentions.push('@' + toWorkspaceRef(path, cwd))
    if (!cwd || (path !== cwd && !path.startsWith(cwd.endsWith('/') ? cwd : `${cwd}/`))) outside++
  })
  return { refs, mentions, outside }
}
