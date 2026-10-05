import type { PerSessionState } from '../store'
import { isBackgroundedTool } from './lumen'
import { highlightOf } from './toolHighlight'
import { isBrowserTool } from './instrument'

export type SessionStatusKind = 'needs' | 'failed' | 'working' | 'idle'

export interface SessionStatus {
  kind: SessionStatusKind
  /** The line's lead: "Needs you", "Last turn failed", a tool name, "Thinking", "Idle". */
  lead: string
  /** What follows the lead: "Allow Write", or the running tool's main argument. */
  rest: string | null
  /** Pending permission requests, for the needs-you mark's count. */
  count: number
}

type StatusSlice = Pick<
  PerSessionState,
  'pendingPermissions' | 'lastError' | 'busy' | 'compacting' | 'thinkingTokens' | 'messages'
>

/**
 * A live session's state for the sidebar's row marks and line 2. "Failed" is the in-chat error box
 * (`lastError`): set by a mid-session error or a failed compact, cleared by the next init or send.
 */
export function sessionStatusOf(s: StatusSlice): SessionStatus {
  const pending = s.pendingPermissions.length
  if (pending > 0) {
    const p = s.pendingPermissions[0]
    const rest =
      p.toolName === 'BrowserLogin'
        ? `Sign in to ${p.displayName}`
        : p.toolName === 'McpElicitation'
          ? `Request from ${p.displayName}`
          : `Allow ${p.displayName || p.toolName}`
    return { kind: 'needs', lead: 'Needs you', rest, count: pending }
  }
  if (s.lastError !== null) return { kind: 'failed', lead: 'Last turn failed', rest: null, count: 0 }
  if (s.compacting) return { kind: 'working', lead: 'Compacting', rest: null, count: 0 }
  if (s.busy) {
    const last = s.messages[s.messages.length - 1]
    const tool =
      last?.role === 'assistant'
        ? [...last.tools].reverse().find((t) => t.result === undefined && !isBackgroundedTool(t))
        : undefined
    if (tool) return { kind: 'working', lead: toolLabel(tool.name), rest: argOf(tool.input), count: 0 }
    return { kind: 'working', lead: s.thinkingTokens !== null ? 'Thinking' : 'Responding', rest: null, count: 0 }
  }
  return { kind: 'idle', lead: 'Idle', rest: null, count: 0 }
}

/** A primitive key of everything a sidebar row shows from the status, for the sidebar's liveSig. */
export function statusKey(s: StatusSlice): string {
  const st = sessionStatusOf(s)
  return `${st.kind}|${st.lead}|${st.rest ?? ''}|${st.count}`
}

/** The status as one plain sentence, for tooltips and accessible labels. */
export function statusText(st: SessionStatus): string {
  if (st.kind === 'needs') return st.rest ? `Needs you: ${st.rest}` : 'Needs you'
  return st.rest ? `${st.lead} ${st.rest}` : st.lead
}

function toolLabel(name: string): string {
  return name === 'Task' || name === 'Agent' ? 'Agent' : isBrowserTool(name) ? 'Browser' : name
}

function argOf(input: unknown): string | null {
  const hit = highlightOf(input)?.value
  if (hit) return hit.split('\n')[0]
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    if (typeof o.description === 'string') return o.description
    if (typeof o.pattern === 'string') return o.pattern
  }
  return null
}
