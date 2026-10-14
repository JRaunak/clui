export type SurfaceKind = 'browser' | 'tree' | 'file' | 'diff' | 'image' | 'doc' | 'sheet' | 'artifact'
export type OpenedBy = 'user' | 'claude' | 'link' | 'change'
export type ViewMode = 'auto' | 'preview' | 'source'
/** Normalized 0..1 of the rendered page or image. */
export interface Region { x: number; y: number; w: number; h: number }

export interface SurfaceLocation { line?: number; page?: number; sheet?: string; cell?: string; file?: string }
export interface SurfaceSelection {
  lines?: { start: number; end: number }
  change?: { segmentId: string; revision: string; hunkId: string; side: 'diff' | 'before' | 'after' }
  range?: string
  region?: Region
  point?: { x: number; y: number }
  page?: number
  text?: string
}
export type SurfaceViewState =
  | { kind: 'tree'; expanded: string[]; scrollTop: number }
  | { kind: 'file'; topLine: number; offsetPx: number; scrollLeft: number; previewScrollTop: number; find?: string }
  | { kind: 'diff'; path?: string; segmentId?: string; revision?: string; topHunk?: string; offsetPx: number; find?: string }
  | { kind: 'image'; zoom: number | 'fit'; panX: number; panY: number }
  | { kind: 'doc'; page: number; zoom: number | 'fit-width' | 'fit-page'; offsetPx: number; find?: string }
  | { kind: 'sheet'; sheet?: string; topRow: number; leftCol: number; rowOffset: number; colOffset: number }
  | { kind: 'artifact'; scrollX: number; scrollY: number }

export interface SurfaceTab {
  /** Resource identity; Source/Preview does not create another tab. */
  id: string
  kind: Exclude<SurfaceKind, 'browser'>
  /** Canonical authorized path; '' for tree and diff. */
  key: string
  title: string
  openedBy: OpenedBy
  mode?: ViewMode
  location?: SurfaceLocation
  selection?: SurfaceSelection
  highlight?: SurfaceSelection
  pendingShow?: { location?: SurfaceLocation; highlight?: SurfaceSelection }
  viewState?: SurfaceViewState
  /** Source scroll state for image/artifact/sheet presentations. */
  sourceView?: Extract<SurfaceViewState, { kind: 'file' }>
  openedAt: number
  lastViewedAt: number
  provenance?: { sessionId: string; creatingEditId?: string; messageId?: string }
  unseen?: boolean
}

/** Browser content and identity stay in BrowserManager and slice.browser; this only places them. */
export interface SurfaceSet {
  order: string[]
  active: string | null
  tabs: Record<string, SurfaceTab>
  browserLastViewedAt: Record<string, number>
  /** Placement ids Claude updated while they weren't active. */
  browserUnseen: Record<string, true>
}

/** `prepare` places a tab unseen without activating it; a Claude `focus` falls back to it while the user is busy in the pane or a Gate is up. */
export type OpenIntent = 'focus' | 'open' | 'prepare'
