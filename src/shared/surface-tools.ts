/** Claude's presentation tools on the `clui-surface` server, and the main↔renderer bridge they ride. */
import type { SurfaceKind } from './surfaces'

export const SURFACE_STATE_TOOL = 'mcp__clui-surface__surface_state'
export const SURFACE_OPEN_TOOL = 'mcp__clui-surface__surface_open'

/** Validated in main: a path here is absolute and already authorized for its kind. */
export type SurfaceTarget =
  | { kind: 'file'; path: string; line?: number; endLine?: number }
  | { kind: 'tree'; path: string }
  | { kind: 'diff'; path?: string }
  | { kind: 'browser'; tab: number }

interface CommandBase { reqId: string; handleId: string; generation: number; expiresAt: number }
export type SurfaceCommand = CommandBase & ({ op: 'state' } | { op: 'open'; args: SurfaceTarget & { focus: boolean } })

export interface Lines { start: number; end: number }
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
  selection?: Lines
  highlight?: Lines
  pending?: { line?: number; endLine?: number }
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
export type SurfaceReply = PaneFacts | { outcome: OpenOutcome }

// Filenames and page titles are someone else's strings: no controls, no bidi overrides, one bounded line.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g
export function clean(s: string): string {
  const cp = [...s.replace(CONTROL, '')]
  return cp.length > 120 ? `${cp.slice(0, 119).join('')}…` : cp.join('')
}
