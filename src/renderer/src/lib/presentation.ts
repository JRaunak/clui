import { useSyncExternalStore } from 'react'
import { isHtml } from '../../../shared/html-view'
import { isSvg, type SurfaceKind, type SurfaceTab } from '../../../shared/surfaces'

export type Presentation = 'source' | 'preview'

export const isMarkdown = (p: string): boolean => /\.(md|markdown)$/i.test(p)
export const isMermaid = (p: string): boolean => /\.(mmd|mermaid)$/i.test(p)
export const hasPreview = (p: string): boolean => isHtml(p) || isMarkdown(p) || isMermaid(p) || isSvg(p)

/** Tabs that show one file: its text, a Preview beside it for the kinds that have one, an image or a PDF. */
export const fileLike = (kind: SurfaceKind | null | undefined): kind is 'file' | 'artifact' | 'image' | 'doc' =>
  kind === 'file' || kind === 'artifact' || kind === 'image' || kind === 'doc'

/** What a pane tab shows: an explicit choice wins, and `auto` previews unless this file's preview is unavailable.
 *  Null for a tab with no Source and Preview to swap between, a raster image included. */
export function presentationOf(tab: Pick<SurfaceTab, 'kind' | 'key' | 'mode'> | undefined, unavailable: boolean): Presentation | null {
  if (!tab || !fileLike(tab.kind) || !hasPreview(tab.key) || (tab.kind === 'image') !== isSvg(tab.key)) return null
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

export const noPreview = (handleId: string | null, path: string | null | undefined): NoPreview | null =>
  (!!handleId && !!path && refused.get(`${handleId}\0${path}`)) || null

export const useNoPreview = (handleId: string | null, path: string | null | undefined): NoPreview | null => useSyncExternalStore(subscribe, () => noPreview(handleId, path))

/** The tab takes Find: Source, a Markdown Preview, which is DOM text, or a PDF. An HTML Preview is a native page and
 *  takes none, nor does an image. */
export const hasFind = (handleId: string | null, tab: Pick<SurfaceTab, 'kind' | 'key' | 'mode'> | undefined): boolean => {
  if (!tab || !fileLike(tab.kind)) return false
  if (tab.kind === 'doc') return true
  const shown = presentationOf(tab, !!noPreview(handleId, tab.key))
  return tab.kind === 'image' ? shown === 'source' : isMarkdown(tab.key) || shown !== 'preview'
}

/** Open externally takes the file to its default app rather than the editor: from a Preview, a raster image or a PDF. */
export const opensDefault = (kind: SurfaceKind | null | undefined, shown: Presentation | null): boolean => shown === 'preview' || ((kind === 'image' || kind === 'doc') && shown === null)
