import { CHANGE_READ_TOOL, changeLabel, messageGist, parseRefs, type ContextReference } from '../../../shared/context'
import type { ChatMessage, MonitorRecord, PerSessionState, ToolCall } from '../store'
import { isBackgroundedTool } from './lumen'
import { READ_CHANGE, spokenChange } from './refCopy'
import { formatCost } from './formatCost'
import { SURFACE_OPEN_TOOL, SURFACE_STATE_TOOL } from '../../../shared/surface-tools'

export { isBackgroundedTool }

/** Backgrounded tools read info blue; amber is reserved for "needs you". */
export type RowState = 'running' | 'needs-you' | 'checking' | 'failed' | 'not-run' | 'stopped' | 'launching' | 'launched' | 'watching' | 'done' | 'ended'

export const STATE_TEXT: Record<RowState, string> = {
  running: 'running',
  'needs-you': 'needs you',
  checking: 'checking with auto mode',
  failed: 'failed',
  'not-run': 'not run',
  stopped: 'stopped',
  launching: 'launching',
  launched: 'launched',
  watching: 'watching',
  done: 'done',
  ended: 'ended'
}

/** A backgrounded tool returns at launch while the real work continues in the tray, so its
 *  terminal state is "launched", never "done". */
export function rowState(tool: ToolCall, needsYou: boolean, checking = false): RowState {
  const bg = isBackgroundedTool(tool)
  if (tool.result === undefined) return needsYou ? 'needs-you' : checking ? 'checking' : bg ? 'launching' : 'running'
  // Checked before isError: a call auto mode held back carries an error result but never ran.
  if (tool.notRun) return 'not-run'
  if (tool.stopped) return 'stopped'
  if (tool.isError) return 'failed'
  return bg ? 'launched' : 'done'
}

/** A Monitor's start result lands at once while it keeps watching, so its state follows the
 *  monitor. No record means the monitor died with an earlier process (a rebuilt or resumed row). */
export function monitorRowState(tool: ToolCall, needsYou: boolean, checking: boolean, rec: MonitorRecord | undefined): RowState {
  if (tool.result === undefined || tool.isError) return rowState(tool, needsYou, checking)
  if (!rec) return 'ended'
  return rec.status === 'running' ? 'watching' : rec.status === 'completed' ? 'ended' : rec.status === 'killed' ? 'stopped' : 'failed'
}

/** "no wakes yet", "1 wake · $0.0040", "3 wakes, 1 shared · $0.02". */
export function monitorMeta(rec: MonitorRecord, watching: boolean): string {
  if (!rec.wakes) return watching ? 'no wakes yet' : 'no wakes'
  const shared = rec.sharedWakes ? `, ${rec.sharedWakes} shared` : ''
  return `${rec.wakes} wake${rec.wakes === 1 ? '' : 's'}${shared} · ${formatCost(rec.costUsd)}`
}

const SEVERITY: RowState[] = ['failed', 'needs-you', 'checking', 'running', 'launching', 'launched', 'watching', 'not-run', 'stopped', 'ended', 'done']

/** The aggregate row's single bead shows the most urgent child. */
export function worstState(states: RowState[]): RowState {
  let worst = SEVERITY.length - 1
  for (const s of states) worst = Math.min(worst, SEVERITY.indexOf(s))
  return SEVERITY[worst]
}

/** A permission request carries no tool_use id, so the waiting row is found by name: the last
 *  unresolved tool of the last assistant message that matches the oldest pending request. */
export function needsYouToolIdOf(slice: PerSessionState | null): string | null {
  if (!slice) return null
  const req = slice.pendingPermissions[0]
  if (!req) return null
  const last = slice.messages[slice.messages.length - 1]
  if (!last || last.role !== 'assistant') return null
  // Clui's own browser Gates are named for what they ask, not for the tool call waiting on them.
  const browserGate = req.toolName === 'BrowserSite' || req.toolName === 'BrowserLogin'
  for (let i = last.tools.length - 1; i >= 0; i--) {
    const t = last.tools[i]
    if (t.result === undefined && (browserGate ? isBrowserTool(t.name) : t.name === req.toolName)) return t.id
  }
  return null
}

export function summarizeInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    // A subagent call carries a short human description, which reads better than its prompt.
    if (typeof o.description === 'string') return o.description
    if (typeof o.command === 'string') return o.command
    if (typeof o.skill === 'string') return o.skill
    if (typeof o.file_path === 'string') return o.file_path
    if (typeof o.path === 'string') return o.path
    if (typeof o.pattern === 'string') return o.pattern
  }
  return ''
}

const AGENT_MENTION = /@"([^"]+?) \(agent\)"/g

/** Up to 300 chars of a prompt for the header's tooltip; the header itself shows line one. */
export function promptPreview(text: string): string {
  return messageGist(text).replace(AGENT_MENTION, '@$1').trim().slice(0, 300) || 'Attachments only'
}

const isPrompt = (m: ChatMessage): boolean => m.role === 'user' && !m.compaction

/** Turn N is the Nth prompt you sent. Peer messages and compaction markers aren't turns. */
export function turnNumberOf(messages: ChatMessage[], index: number): number {
  let n = 0
  for (let i = 0; i <= index && i < messages.length; i++) if (isPrompt(messages[i])) n++
  return n
}

export interface CurrentTurn {
  messageId: string
  text: string
  turn: number
}

/** The top band's 44px plus 8px of air. A transcript row whose bottom is above this line sits
 *  under the band's glass, so it doesn't count as visible. */
export const TURN_LINE_PX = 52

/** The prompt that owns the top row (the first row not hidden under the top band), or null when
 *  that top row is the prompt itself: the header would repeat what you can already see. */
export function currentTurnAt(messages: ChatMessage[], startIndex: number): CurrentTurn | null {
  for (let i = Math.min(startIndex, messages.length - 1); i >= 0; i--) {
    if (!isPrompt(messages[i])) continue
    if (i === startIndex) return null
    return { messageId: messages[i].id, text: promptPreview(messages[i].text), turn: turnNumberOf(messages, i) }
  }
  return null
}

const BROWSER_PREFIX = 'mcp__clui-browser__'
export function isBrowserTool(name: string): boolean {
  return name.startsWith(BROWSER_PREFIX)
}

export const isChangeRead = (name: string): boolean => name === CHANGE_READ_TOOL

/** What a row, a group and the status line call a tool. A history read is never a bare `Read`, so a group of both
 *  doesn't fold into one name. */
export function toolLabel(name: string): string {
  if (name === 'Task' || name === 'Agent') return 'Agent'
  if (isBrowserTool(name)) return 'Browser'
  return name === SURFACE_OPEN_TOOL || name === SURFACE_STATE_TOOL ? 'Pane' : isChangeRead(name) ? READ_CHANGE : name
}

type ChangeRef = Extract<ContextReference, { kind: 'change' }>
const sentChanges = new WeakMap<ChatMessage, Map<string, ChangeRef>>()

/** The change a change_read call names, from this session's user messages, as `{ label, spoken }`; null for one
 *  compacted away or never sent. */
export function changeReadOf(messages: readonly ChatMessage[], input: unknown): { label: string; spoken: string } | null {
  const ref = input && typeof input === 'object' ? (input as Record<string, unknown>).ref : undefined
  if (typeof ref !== 'string') return null
  for (const m of messages) {
    if (m.role !== 'user') continue
    let sent = sentChanges.get(m)
    if (!sent) {
      sent = new Map(parseRefs(m.text).refs.flatMap((r): [string, ChangeRef][] => (r.kind === 'current' && r.value.ref.kind === 'change' ? [[r.value.ref.changeRef, r.value.ref]] : [])))
      sentChanges.set(m, sent)
    }
    const c = sent.get(ref)
    if (c) return { label: changeLabel(c.path, c.side, c.old, c.new), spoken: spokenChange(c) }
  }
  return null
}
/** "navigate github.com/org/repo", "click 12", "autofill login", for the row's primary arg. `tab` names
 *  the tab it ran in, for a session that has had more than one. */
export function browserLabel(name: string, input: unknown, tab?: number): string {
  const label = actionLabel(name, input)
  return tab ? `${label} · tab ${tab}` : label
}

/** The count a debug tool leads its result with ("3 errors"); flagged means a problem count above zero. */
export function browserResultCopy(result: string | undefined): { copy: string; flagged: boolean } | null {
  const m = /^summary(!?): (.+)$/m.exec(result?.split('\n', 1)[0] ?? '')
  return m ? { copy: m[2], flagged: !!m[1] } : null
}

/** The element number a row shows. Refs look like `t1:d…:e12`; older transcripts store a plain number. */
function refNumber(ref: unknown): number | null {
  if (typeof ref === 'number') return ref
  const m = typeof ref === 'string' ? /:e(\d+)$/.exec(ref) : null
  return m ? Number(m[1]) : null
}

function actionLabel(name: string, input: unknown): string {
  const action = name.slice(BROWSER_PREFIX.length)
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (action === 'navigate' && typeof o.url === 'string') return `navigate ${o.url.replace(/^https?:\/\//, '')}`
  const ref = refNumber(o.ref)
  if ((action === 'click' || action === 'type') && ref !== null) return `${action} ${ref}`
  if (action === 'scroll' && typeof o.dy === 'number') return `scroll ${o.dy}`
  if (action === 'press') {
    const keys = typeof o.keys === 'string' ? [o.keys] : Array.isArray(o.keys) ? o.keys : []
    if (keys.length > 1) return `press ${keys.length} keys`
    if (typeof keys[0] === 'string') return `press ${keys[0] === ' ' ? 'Space' : keys[0]}`
  }
  if (action === 'hover') {
    if (ref !== null) return `hover ${ref}`
    if (typeof o.x === 'number' && typeof o.y === 'number') return `hover ${o.x}, ${o.y}`
  }
  if (action === 'new_tab' && typeof o.url === 'string') return `new tab ${o.url.replace(/^https?:\/\//, '')}`
  if (action === 'console') return o.level === 'error' ? 'console errors' : o.level === 'warn' ? 'console warnings' : 'console'
  if (action === 'network') return o.failedOnly === true ? 'network failed' : typeof o.filter === 'string' && o.filter ? `network ${o.filter}` : 'network'
  if (action === 'network_body' && typeof o.id === 'number') return `response ${o.id}`
  if (action === 'storage') return o.area === 'local' ? 'local storage' : o.area === 'session' ? 'session storage' : o.area === 'indexeddb' ? 'IndexedDB' : 'storage'
  return action.replace(/_/g, ' ')
}
