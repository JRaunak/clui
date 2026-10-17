import { useEffect, useMemo, type MouseEvent } from 'react'
import { create } from 'zustand'
import type { FileLinkTarget, LinkTarget } from '../../../shared/settings'
import { activeSlice, useActive, useSession } from '../store'
import { openEditor } from '../components/surfaces/FileSurface'
import { revealInTree } from '../components/surfaces/TreeSurface'
import { lineReaches, workspaceOf, type FileRef, type Workspace } from './fileLinks'
import { requestSurfaceFocus } from './surfaceFocus'
import { viaOf, type Via } from './motion'
import { urlSpans } from './urlSpans'

/** Neutral, not accent: accent text fails body contrast on the light card, and accent is kept scarce. */
export const LINK =
  'rounded-sm text-content underline decoration-[var(--color-dim)] underline-offset-2 pointer-fine:hover:decoration-[var(--color-content)]'

/** The link settings, mirrored so a link's title can name where it opens without reading settings per render.
 *  `editor` is there because whether a line reaches the editor depends on which one it is. */
export const useLinkTarget = create<{ target: LinkTarget; file: FileLinkTarget; editor: string }>(() => ({ target: 'clui', file: 'clui', editor: 'code' }))
void window.clui.getSettings().then(
  ({ values }) => useLinkTarget.setState({ target: values.linkTarget, file: values.fileLinkTarget, editor: values.editorCommand || 'code' }),
  () => {}
)

export const LINK_MOD = window.clui.isMac ? '⌘' : 'Ctrl'
const isWeb = (href: string): boolean => /^https?:\/\//i.test(href)
let announceSeq = 0

/** Where a plain click goes, and the modifier for the other way when there is one. */
export function linkTitle(href: string, hasBrowser: boolean, target: LinkTarget): string {
  if (!hasBrowser || !isWeb(href)) return 'Opens in your default browser.'
  return target === 'clui'
    ? `Opens in Clui's browser. ${LINK_MOD}-click for default browser.`
    : `Opens in your default browser. ${LINK_MOD}-click for Clui's browser.`
}

/** A web link goes to a new tab of this session's browser, so Claude's tab is never taken; anything else, or a
 *  session without the browser, goes to the default browser. The modifier flips it for one click. */
export async function openLink(href: string, invert: boolean): Promise<void> {
  const s = useSession.getState()
  const active = activeSlice(s)
  const inClui = !!active?.browser && isWeb(href) && (useLinkTarget.getState().target === 'clui') !== invert
  if (!active || !inClui) return void window.clui.openExternal(href)
  try {
    const tab = await window.clui.browserNewTab(active.handleId)
    await window.clui.browserNavigate(active.handleId, tab, href)
  } catch {
    return void window.clui.openExternal(href)
  }
  if (!active.paneOpen) s.setPane(active.surfacePaneFull ? 'full' : 'half')
  useSession.setState({ browserAnnounce: `Opened in Clui's browser${'\u200b'.repeat(++announceSeq % 2)}` })
}

/** Click and keyboard handlers for an anchor that routes through openLink. A middle click would open an Electron window. */
export function linkHandlers(href: string): { onClick: (e: MouseEvent) => void; onAuxClick: (e: MouseEvent) => void } {
  return {
    onClick: (e) => {
      e.preventDefault()
      void openLink(href, e.metaKey || e.ctrlKey)
    },
    onAuxClick: (e) => e.preventDefault()
  }
}

/** Each session's workspace file list as sets, so a path in the transcript is one lookup. Loaded on first use. */
const useWorkspaces = create<{ sets: Record<string, Workspace> }>(() => ({ sets: {} }))
const listing = new Set<string>()

function loadWorkspace(handleId: string, again = false): void {
  if (listing.has(handleId) || (!again && useWorkspaces.getState().sets[handleId])) return
  listing.add(handleId)
  const put = (ws: Workspace): void => {
    listing.delete(handleId)
    if (useSession.getState().sessions[handleId]) useWorkspaces.setState((m) => ({ sets: { ...m.sets, [handleId]: ws } }))
  }
  // A folder that can't be listed links nothing, and isn't asked again on every render.
  window.clui.listWorkspaceFiles(handleId).then(
    (r) => put(workspaceOf(r.files)),
    () => put(workspaceOf([]))
  )
}

// A file Claude creates links once the ledger reports it; anything made outside Clui, once the window is next focused.
useSession.subscribe((s, prev) => {
  if (s.sessions === prev.sessions) return
  const { sets } = useWorkspaces.getState()
  for (const id in sets) {
    const cur = s.sessions[id]
    if (!cur) {
      useWorkspaces.setState((m) => {
        const { [id]: _gone, ...rest } = m.sets
        return { sets: rest }
      })
      continue
    }
    if (cur.changes === prev.sessions[id]?.changes) continue
    const root = `${cur.cwd}/`
    if (cur.changes.some((c) => !c.missingOnDisk && c.path.startsWith(root) && !sets[id].files.has(c.path.slice(root.length)))) loadWorkspace(id, true)
  }
})
window.addEventListener('focus', () => {
  for (const id in useWorkspaces.getState().sets) loadWorkspace(id, true)
})

/** Where file links in one message resolve. */
export interface LinkRoot {
  handleId: string
  cwd: string
  ws: Workspace | null
}

/** The active session's link root while `on`. A Quick session has no folder of its own to point into. */
export function useLinkRoot(on: boolean): LinkRoot | null {
  const handleId = useActive((s) => (on && s?.cwd && !s.ephemeral ? s.handleId : null))
  const cwd = useActive((s) => s?.cwd ?? '')
  const ws = useWorkspaces((m) => (handleId ? m.sets[handleId] : undefined)) ?? null
  useEffect(() => {
    if (handleId) loadWorkspace(handleId)
  }, [handleId])
  return useMemo(() => (handleId ? { handleId, cwd, ws } : null), [handleId, cwd, ws])
}

const linesOf = (at: Pick<FileRef, 'line' | 'endLine'>): string =>
  !at.line ? '' : at.endLine ? ` at lines ${at.line} to ${at.endLine}` : ` at line ${at.line}`

/** Where a plain click on a file link goes and what the modifier does instead. An editor that can't take a line
 *  is never promised one. */
export function fileLinkTitle(rel: string, at: Pick<FileRef, 'line' | 'endLine'>, dir: boolean, target: FileLinkTarget, editor: string): string {
  if (dir) {
    return target === 'clui'
      ? `Shows ${rel} in the file tree. ${LINK_MOD}-click to open it in your editor.`
      : `Opens ${rel} in your editor. ${LINK_MOD}-click to show it in the file tree.`
  }
  const lines = linesOf(at)
  if (target === 'clui') return `Opens ${rel}${lines} in Clui. ${LINK_MOD}-click to open in your editor.`
  if (!at.line || lineReaches(target, editor)) return `Opens ${rel}${at.line ? ` at line ${at.line}` : ''} in your editor. ${LINK_MOD}-click to open in Clui.`
  return `Opens ${rel} in your editor. ${LINK_MOD}-click to open${lines} in Clui.`
}

/** A file link's open: the File surface (or the tree for a folder) under the setting, the editor with ⌘. ⌃-click
 *  is the macOS context-menu gesture, so only ⌘ inverts. */
export function openFileLink(handleId: string, path: string, at: Pick<FileRef, 'line' | 'endLine'>, dir: boolean, e: MouseEvent): void {
  e.preventDefault()
  if ((useLinkTarget.getState().file === 'clui') === e.metaKey) return void openEditor(handleId, path, dir ? undefined : at.line)
  openFileAt(handleId, path, at, dir, viaOf(e))
}

/** Whether `rel` is a folder in the session's listed workspace, for a path that doesn't say so with a slash. */
export const listedDir = (handleId: string, rel: string): boolean => !!useWorkspaces.getState().sets[handleId]?.dirs.has(rel)

/** A file in the File surface, or a folder revealed in the tree. */
export function openFileAt(handleId: string, path: string, at: Pick<FileRef, 'line' | 'endLine'>, dir: boolean, via: Via): void {
  const st = useSession.getState()
  if (dir) {
    const cwd = st.sessions[handleId]?.cwd ?? path
    requestSurfaceFocus('tree', via)
    st.openSurface(handleId, { kind: 'tree', key: '', title: cwd.slice(cwd.lastIndexOf('/') + 1) || cwd }, 'open', 'user', 'link')
    return revealInTree(path, via, true)
  }
  const location = at.line ? { line: at.line, ...(at.endLine ? { endLine: at.endLine } : {}) } : undefined
  requestSurfaceFocus(`file:${path}`, via)
  st.openSurface(handleId, { kind: 'file', key: path, title: path.slice(path.lastIndexOf('/') + 1), ...(location ? { location } : {}) }, 'open', 'user', 'link')
}

/** Plain text with its http(s) URLs as links. A URL cut off by truncation stays text, since it would lead nowhere. */
export function LinkedText({ text, truncated }: { text: string; truncated: boolean }): JSX.Element {
  const hasBrowser = useActive((s) => !!s?.browser)
  const target = useLinkTarget((s) => s.target)
  const out: (string | JSX.Element)[] = []
  let last = 0
  for (const { start, end, url } of urlSpans(text, truncated)) {
    out.push(text.slice(last, start))
    out.push(
      <a key={start} href={url} className={LINK} title={linkTitle(url, hasBrowser, target)} {...linkHandlers(url)}>
        {url}
      </a>
    )
    last = end
  }
  out.push(text.slice(last))
  return <>{out}</>
}
