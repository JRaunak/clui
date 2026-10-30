import type { HunkRows } from './changes'
import type { ChangeSide, LineRange, SourceVersion } from './context'
import type { PagePlace } from './html-view'
export type SurfaceKind = 'browser' | 'tree' | 'file' | 'diff' | 'image' | 'doc' | 'sheet' | 'artifact'
export type OpenedBy = 'user' | 'claude' | 'link' | 'change'
export type ViewMode = 'auto' | 'preview' | 'source'
/** Normalized 0..1 of the rendered page or image. */
export interface Region { x: number; y: number; w: number; h: number }

export interface SurfaceLocation {
  line?: number
  /** The last line of a range starting at `line`. */
  endLine?: number
  page?: number
  sheet?: string
  cell?: string
  file?: string
  /** A Claude changes hunk id, with `file`. */
  hunk?: string
  /** An element id a Preview scrolls to: a Markdown heading or footnote, or a page's own id; Source ignores it. */
  anchor?: string
}
export interface SurfaceSelection {
  lines?: { start: number; end: number }
  /** A File tab's revision the lines were selected against, so a reader that isn't the mounted tab can build the line reference. */
  sourceVersion?: SourceVersion
  change?: {
    /** Absolute: the Diff tab's key is '', so the selection carries its file. */
    path: string
    segmentId: string
    revision: string
    hunkId: string
    side: ChangeSide
    /** Absent = the whole hunk. */
    rows?: HunkRows
    old?: LineRange
    new?: LineRange
    /** `changeSelection(...).ok` on the hunk the surface rendered; a preview, main decides at mint. */
    fits: boolean
  }
  range?: string
  region?: Region
  point?: { x: number; y: number }
  page?: number
  /** A PDF text selection's last page, when it runs past `page`. */
  endPage?: number
  /** A PDF's selected text, whitespace collapsed, and which occurrence of it on `page` it is. */
  text?: string
  nth?: number
}
export type SurfaceViewState =
  | { kind: 'tree'; expanded: string[]; scrollTop: number }
  /** `page`: an HTML Preview's document scroll, kept beside Source's place. */
  | { kind: 'file'; topLine: number; offsetPx: number; scrollLeft: number; find?: string; page?: PagePlace }
  | { kind: 'diff'; path?: string; segmentId?: string; revision?: string; topHunk?: string; offsetPx: number; find?: string }
  | { kind: 'image'; zoom: number | 'fit'; panX: number; panY: number }
  /** `offset`: 0 to 1 down the current page's box, at the viewport's centre. `pages`: the count it was read with. */
  | { kind: 'doc'; page: number; zoom: number | 'fit-width' | 'fit-page'; offset: number; pages?: number; find?: string }
  | { kind: 'sheet'; sheet?: string; topRow: number; leftCol: number; rowOffset: number; colOffset: number }

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
  /** Tree only: the file whose tab was active when the tree took over, revealed once on mount. Never saved. */
  reveal?: string
  /** The places a Markdown Preview's anchor jumps or a PDF's link and Contents jumps left, newest last, in the
   *  revision they were made in. Never saved. */
  back?: { revision: string; places: BackPlace[]; pages?: undefined } | { revision: string; pages: DocPlace[]; places?: undefined }
}

/** Where a PDF jump left the reader, as its view state keeps it. */
export interface DocPlace {
  page: number
  offset: number
}

/** Where an anchor jump left the reader: the top block's start line, 0 at the document's top, and the link followed. */
export interface BackPlace {
  line: number
  link: { line: number; href: string; nth: number }
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

/** Where a tab keeps its `kind: 'file'` view state. A viewState must be of the tab's own kind, so an artifact's or an
 *  SVG's Source goes in sourceView. */
export const fileViewKey = (kind: SurfaceTab['kind']): 'viewState' | 'sourceView' => (kind === 'artifact' || kind === 'image' ? 'sourceView' : 'viewState')

const IMAGE = /\.(png|jpe?g|webp|gif|avif|svg)$/i

/** The tab kind a path opens as. `.ico` and `.icns` stay files: the image surface reads neither format. */
export const kindForPath = (p: string): 'file' | 'image' | 'doc' => (IMAGE.test(p) ? 'image' : /\.pdf$/i.test(p) ? 'doc' : 'file')

/** Tree and diff are session singletons; a path resource is one tab whatever its presentation. */
export const surfaceIdOf = (t: Pick<SurfaceTab, 'kind' | 'key' | 'provenance'>): string =>
  t.kind === 'tree' || t.kind === 'diff' ? t.kind : `${t.kind}:${t.key}${t.provenance?.creatingEditId ? `#${t.provenance.creatingEditId}` : ''}`

/** Non-browser tabs a session keeps; opening another closes the one viewed least recently. */
export const SURFACE_TAB_CAP = 24

/** A tab as `session-surfaces.json` keeps it: never a selection, a highlight or a pending destination. */
export type SavedTab = Pick<SurfaceTab, 'id' | 'kind' | 'key' | 'title' | 'openedBy' | 'mode' | 'viewState' | 'sourceView' | 'openedAt' | 'lastViewedAt' | 'provenance'>
export interface SavedSet {
  /** Browser placements included. */
  order: string[]
  active: string | null
  tabs: Record<string, SavedTab>
}
/** A set saved before images and PDFs had their own kinds: such a `file:` tab comes back as its `image:` or `doc:`
 *  tab, without the file view state it can't use. A set already holding that tab keeps that one. */
export function restoreKinds(set: SavedSet): SavedSet {
  const ids = new Map<string, string>()
  const tabs: Record<string, SavedTab> = {}
  for (const [id, t] of Object.entries(set.tabs)) {
    const kind = kindForPath(t.key)
    if (t.kind !== 'file' || kind === 'file') {
      tabs[id] = t
      continue
    }
    const { viewState: _v, ...rest } = t
    const next: SavedTab = { ...rest, kind }
    next.id = surfaceIdOf(next)
    ids.set(id, next.id)
    if (!set.tabs[next.id]) tabs[next.id] = next
  }
  if (!ids.size) return set
  const order = [...new Set(set.order.map((id) => ids.get(id) ?? id))]
  return { order, active: set.active === null ? null : (ids.get(set.active) ?? set.active), tabs }
}

/** A session's browser tabs by id and address. No content, history or cookies. */
export interface SavedBrowser {
  tabs: { id: number; url: string; lastViewedAt: number }[]
  nextId: number
  viewed: number
}
/** What the renderer saves; main adds the browser tabs from its own records. */
export interface SurfacesSave {
  set: SavedSet
  open: boolean
  full: boolean
}
export interface SurfacesEntry extends SurfacesSave {
  /** Null when the session never had the browser tools. */
  browserTabs: SavedBrowser | null
}
/** `newer` and `corrupt` open the session with no saved tabs, and the picker says why. */
export type SurfacesRestore = { status: 'none' | 'newer' | 'corrupt' } | { status: 'ok'; entry: SurfacesEntry }
