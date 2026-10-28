import { useSyncExternalStore } from 'react'
import { isHtml } from '../../../shared/html-view'
import type { SurfaceKind, SurfaceTab } from '../../../shared/surfaces'

export type Presentation = 'source' | 'preview'

export const isMarkdown = (p: string): boolean => /\.(md|markdown)$/i.test(p)
export const isMermaid = (p: string): boolean => /\.(mmd|mermaid)$/i.test(p)
export const hasPreview = (p: string): boolean => isHtml(p) || isMarkdown(p) || isMermaid(p)

/** Tabs that show a file's text, and a Preview beside it for the kinds that have one. */
export const fileLike = (kind: SurfaceKind | null | undefined): kind is 'file' | 'artifact' => kind === 'file' || kind === 'artifact'

/** What a pane tab shows: an explicit choice wins, and `auto` previews unless this file's preview is unavailable.
 *  Null for a tab with no Preview. */
export function presentationOf(tab: Pick<SurfaceTab, 'kind' | 'key' | 'mode'> | undefined, unavailable: boolean): Presentation | null {
  if (!tab || !fileLike(tab.kind) || !hasPreview(tab.key)) return null
  if (tab.mode === 'source' || tab.mode === 'preview') return tab.mode
  return unavailable ? 'source' : 'preview'
}

/** Why `auto` shows Source: main won't run a page outside the session's folder or in a session folder at or above
 *  home, and a Markdown file was over 1 MB when its tab first read it. */
export type NoPreview = 'denied' | 'too-broad' | 'too-large'

// A page's refusal holds while Clui runs, since its path and its session's folder stay put. A big Markdown file stays in
// Source for the life of the mounted tab, so it never flips under the reader if it shrinks; the Source that showed its
// banner clears it on unmount, and the next open measures again.
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

export function clearNoPreview(handleId: string, path: string): void {
  if (!refused.delete(`${handleId}\0${path}`)) return
  for (const l of listeners) l()
}

const noPreview = (handleId: string | null, path: string | null | undefined): NoPreview | null =>
  (!!handleId && !!path && refused.get(`${handleId}\0${path}`)) || null

export const useNoPreview = (handleId: string | null, path: string | null | undefined): NoPreview | null => useSyncExternalStore(subscribe, () => noPreview(handleId, path))

/** The tab takes Find: Source, or a Markdown Preview, which is DOM text. An HTML Preview is a native page and takes none. */
export const hasFind = (handleId: string | null, tab: Pick<SurfaceTab, 'kind' | 'key' | 'mode'> | undefined): boolean =>
  !!tab && fileLike(tab.kind) && (isMarkdown(tab.key) || presentationOf(tab, !!noPreview(handleId, tab.key)) !== 'preview')
