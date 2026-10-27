import { useSyncExternalStore } from 'react'
import { isHtml } from '../../../shared/html-view'
import type { SurfaceKind, SurfaceTab } from '../../../shared/surfaces'

export type Presentation = 'source' | 'preview'

/** Tabs that show a file's text, and for HTML a Preview beside it. */
export const fileLike = (kind: SurfaceKind | null | undefined): kind is 'file' | 'artifact' => kind === 'file' || kind === 'artifact'

/** What a pane tab shows: an explicit choice wins, and `auto` previews unless this file's preview is unavailable.
 *  Null for a tab with no Preview. */
export function presentationOf(tab: Pick<SurfaceTab, 'kind' | 'key' | 'mode'> | undefined, unavailable: boolean): Presentation | null {
  if (!tab || !fileLike(tab.kind) || !isHtml(tab.key)) return null
  if (tab.mode === 'source' || tab.mode === 'preview') return tab.mode
  return unavailable ? 'source' : 'preview'
}

/** Why main won't run a page: outside the session's folder, or a session folder at or above home. */
export type NoPreview = 'denied' | 'too-broad'

// Neither cause changes while Clui runs: a page's path and its session's folder stay put.
const refused = new Map<string, NoPreview>()
const listeners = new Set<() => void>()
const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function markNoPreview(handleId: string, path: string, why: NoPreview): void {
  const key = `${handleId}\0${path}`
  if (refused.has(key)) return
  refused.set(key, why)
  for (const l of listeners) l()
}

const noPreview = (handleId: string | null, path: string | null | undefined): NoPreview | null =>
  (!!handleId && !!path && refused.get(`${handleId}\0${path}`)) || null

export const useNoPreview = (handleId: string | null, path: string | null | undefined): NoPreview | null => useSyncExternalStore(subscribe, () => noPreview(handleId, path))

/** The tab takes the file actions (Find, Point): a file-like tab showing Source. A Preview takes none of them. */
export const showsSource = (handleId: string | null, tab: Pick<SurfaceTab, 'kind' | 'key' | 'mode'> | undefined): boolean =>
  !!tab && fileLike(tab.kind) && presentationOf(tab, !!noPreview(handleId, tab.key)) !== 'preview'
