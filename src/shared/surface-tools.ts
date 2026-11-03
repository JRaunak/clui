/** Claude's presentation tools on the `clui-surface` server, and the main↔renderer bridge they ride. */
import type { SurfaceKind } from './surfaces'

export const SURFACE_STATE_TOOL = 'mcp__clui-surface__surface_state'
export const SURFACE_OPEN_TOOL = 'mcp__clui-surface__surface_open'

/** Validated in main: a path here is absolute and already authorized for its kind. */
export type SurfaceTarget =
  /** `page` only for a PDF or a glimpsed Office file, `range` and `sheet` only for a sheet, `line` for text, which a
   *  CSV's grid marks as rows. `text` and `nth` only for a PDF or a Word file, `page` with them searching that page.
   *  `parts`: ids in a Mermaid diagram, alone on a .mmd file or with the `line` that picks a Markdown file's diagram. */
  | { kind: 'file'; path: string; line?: number; endLine?: number; page?: number; range?: string; sheet?: string; text?: string; nth?: number; parts?: string[] }
  | { kind: 'tree'; path: string }
  | { kind: 'diff'; path?: string }
  | { kind: 'browser'; tab: number }

interface CommandBase { reqId: string; handleId: string; generation: number; expiresAt: number }
export type SurfaceCommand = CommandBase & ({ op: 'state' } | { op: 'open'; args: SurfaceTarget & { focus: boolean } })

/** `parts`: a selection or highlight of that many diagram parts; `labels`: a diagram area holding that many labels. */
export interface Lines { start?: number; end?: number; parts?: number; labels?: number }
/** A PDF selection by its pages and what it is, never its text; Claude's highlight is a page, with `what: 'text'` when it points at words on it. */
export interface DocSpan { page: number; endPage?: number; what?: 'text' | 'region' | 'point' }
/** Text Claude pointed at or the user selected in a Word document, by its part; a PDF's text Claude pointed at without
 *  a page has no part. Never the words. */
export interface TextSpan { what: 'text'; part?: 'body' | 'footnotes' | 'endnotes' }
/** A sheet range in A1 notation, never its values. */
export interface Cells { range: string; sheet?: string }
/** What a tab shows, never its content. Main formats the label: path tabs and the tree send `path`, browser tabs `tab`. */
export interface TabFact {
  kind: SurfaceKind
  path?: string
  tab?: number
  /** Changed files, for Claude changes. */
  files?: number
  claude: boolean
  unseen: boolean
  location?: { line: number; endLine?: number }
  /** A PDF's current page and its count. */
  page?: number
  pages?: number
  selection?: Lines | DocSpan | Cells | TextSpan
  highlight?: Lines | DocSpan | Cells | TextSpan
  pending?: { line?: number; endLine?: number; page?: number; cell?: string }
}
export type SessionView = 'shown' | 'background' | 'minimized' | 'covered'
export interface PaneFacts {
  pane: 'open' | 'closed'
  width?: 'half' | 'wide'
  session: SessionView
  active?: TabFact
  tabs: TabFact[]
  omitted: number
}
/** `pane-closed`: the tab is active, but the user closed the pane and nothing reopens it on its own. */
export type OpenOutcome = 'shown' | 'prepared' | 'deferred' | 'pane-closed' | 'unavailable'
/** `preview`: Claude's lines landed on a tab showing an HTML or SVG Preview, which marks them only in Source, or a
 *  CSV's grid, which marks the rows holding them. `found`: whether the shown tab found Claude's `text`, absent when it
 *  didn't search in time. `missing`: Claude's diagram parts the drawing doesn't have, absent when it didn't draw in
 *  time; `diagram: false` when the line it gave isn't in a diagram. `source`: the tab stays in its explicit Source. */
export type SurfaceReply = PaneFacts | { outcome: OpenOutcome; preview?: true; found?: boolean; missing?: string[]; diagram?: false; source?: true }

// Filenames and page titles are someone else's strings: no controls, no bidi overrides, one bounded line.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g
export const stripControls = (s: string): string => s.replace(CONTROL, '')
export function clean(s: string): string {
  const cp = [...stripControls(s)]
  return cp.length > 120 ? `${cp.slice(0, 119).join('')}…` : cp.join('')
}
