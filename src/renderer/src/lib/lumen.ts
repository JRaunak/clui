import { useMemo } from 'react'
import { useActive, type PerSessionState, type ToolCall } from '../store'

/** Where the active session's single light sits. */
export type LumenSite = null | { kind: 'tail' } | { kind: 'tool'; toolId: string }

/** A backgrounded tool returns at launch while its work continues in the tray, so it never holds the light. */
export function isBackgroundedTool(t: ToolCall): boolean {
  return (
    t.name === 'Workflow' ||
    !!t.sentToBackground ||
    (!!t.input && typeof t.input === 'object' && (t.input as { run_in_background?: unknown }).run_in_background === true)
  )
}

/** A primitive key, so the store selector below never builds an object (a fresh object per render loops Zustand).
 *  Idle wins over a dangling unresolved tool: an interrupted turn can leave a result-less tool behind. */
export function lumenKeyOf(s: PerSessionState | null): string {
  if (!s || s.pendingPermissions.length > 0) return ''
  // With the page on screen the only light is the agent cursor; a collapsed browser hands it back to the running tool's bead.
  if (s.browser?.drive === 'driving' && s.browserOpen) return ''
  if (!s.busy && !s.compacting) return ''
  const running = runningToolsOf(s)
  // One running tool is the site of work; with several in parallel there is no single site, so the turn's tail holds it.
  if (running.length === 1) return `tool:${running[0].id}`
  return 'tail'
}

const NONE: ToolCall[] = []

function runningToolsOf(s: PerSessionState): ToolCall[] {
  return s.messages[s.messages.length - 1]?.tools.filter((t) => t.result === undefined && !isBackgroundedTool(t)) ?? NONE
}

/** Select `n` and `agents` as separate primitives, never the object. */
export function runningCountOf(s: PerSessionState | null): { n: number; agents: boolean } {
  const running = s ? runningToolsOf(s) : NONE
  return { n: running.length, agents: running.length > 0 && running.every((t) => t.name === 'Task' || t.name === 'Agent') }
}

export function parseLumenKey(key: string): LumenSite {
  if (key === '') return null
  if (key === 'tail') return { kind: 'tail' }
  return { kind: 'tool', toolId: key.slice('tool:'.length) }
}

/** Non-hook form, for callers that already hold a slice. */
export function lumenSiteOf(s: PerSessionState | null): LumenSite {
  return parseLumenKey(lumenKeyOf(s))
}

export function useLumenSite(): LumenSite {
  const key = useActive(lumenKeyOf)
  return useMemo(() => parseLumenKey(key), [key])
}
