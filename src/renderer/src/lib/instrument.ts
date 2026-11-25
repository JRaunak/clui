import { CHANGE_READ_TOOL, changeLabel, messageGist, parseRefs, type ContextReference } from '../../../shared/context'
import type { ChatMessage, MonitorRecord, PerSessionState, ToolCall } from '../store'
import { isBackgroundedTool, sendResultOf } from './agents'
import { READ_CHANGE, spokenChange } from './refCopy'
import { formatCost } from './formatCost'
import { SURFACE_OPEN_TOOL, SURFACE_STATE_TOOL } from '../../../shared/surface-tools'

export { isBackgroundedTool }

/** Backgrounded tools read info blue; amber is reserved for "needs you". */
export type RowState = 'running' | 'needs-you' | 'checking' | 'failed' | 'not-run' | 'stopped' | 'launching' | 'launched' | 'watching' | 'sent' | 'done' | 'ended'

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
  sent: 'sent',
  done: 'done',
  ended: 'ended'
}

/** A backgrounded tool returns at launch while the real work continues in the tray, so its
 *  terminal state is "launched", never "done". */
export function rowState(tool: ToolCall, needsYou: boolean, checking = false): RowState {
  const bg = isBackgroundedTool(tool)
  if (tool.result === undefined) return needsYou ? 'needs-you' : checking ? 'checking' : bg ? 'launching' : 'running'
  // A background agent's launch result lands at once, while its own calls can still stop at a gate.
  if (bg && needsYou) return 'needs-you'
  // Checked before isError: a call auto mode held back carries an error result but never ran.
  if (tool.notRun) return 'not-run'
  if (tool.stopped) return 'stopped'
  if (tool.isError) return 'failed'
  const sent = tool.name === 'SendMessage' ? sendResultOf(tool.result) : null
  if (sent) return sent.ok ? 'sent' : 'failed'
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

/** How much a row asks of the reader: loud needs a look, calm is still working elsewhere, legible changed something
 *  or has an outcome worth reading, routine only looked. */
export type Tier = 'loud' | 'calm' | 'legible' | 'routine'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const CALM_TOOLS = new Set(['Agent', 'Task', 'Workflow', 'SendMessage'])

export function tierOf(tool: ToolCall, state: RowState): Tier {
  if (state === 'needs-you' || state === 'checking' || state === 'failed' || state === 'not-run') return 'loud'
  if (CALM_TOOLS.has(tool.name) || state === 'watching' || state === 'launching' || state === 'launched') return 'calm'
  if (EDIT_TOOLS.has(tool.name) || state === 'stopped' || state === 'ended') return 'legible'
  // A running command's outcome is unknown, so it reads in full until it passes.
  if (tool.name === 'Bash' && state === 'running') return 'legible'
  if (isBrowserTool(tool.name) && browserResultCopy(tool.result)?.flagged) return 'legible'
  return 'routine'
}

/** A done routine call, the only kind that folds. It needs no store: needs-you and checking hold only while a call
 *  has no result, and a Monitor's done start result reads watching or ended, never done. */
export function foldable(tool: ToolCall): boolean {
  return tool.name !== 'Monitor' && rowState(tool, false) === 'done' && tierOf(tool, 'done') === 'routine'
}

function editPathOf(tool: ToolCall): string | null {
  if (!EDIT_TOOLS.has(tool.name) || !tool.input || typeof tool.input !== 'object') return null
  const { file_path, notebook_path } = tool.input as Record<string, unknown>
  const p = file_path ?? notebook_path
  return typeof p === 'string' ? p : null
}

export interface FoldPlan {
  folded: Set<string>
  /** A merged-away edit's id to the id of the last edit to its file, the row that stands in for it. */
  mergedInto: Map<string, string>
  merged: Map<string, ToolCall[]>
  lastVisible: string | null
}

/** A live run keeps its newest done routine rows in view; older ones fold as calls arrive, so its height stops
 *  growing from the fourth call on. */
const LIVE_KEEP = 3

/** Which rows of a run hide. `keptIds` are rows once opened outside the sentence, which never fold or merge. `focusId` is
 *  exempt only while live, so a keyboard user isn't moved as calls stream in; at settle focus is handed off instead. */
export function foldPlan(
  tools: ToolCall[],
  o: { settled: boolean; keptIds: ReadonlySet<string>; focusId: string | null; sentenceOpen: boolean }
): FoldPlan {
  const routine = tools.filter((t) => foldable(t) && !o.keptIds.has(t.id))
  const folded = new Set<string>()
  if (o.settled) {
    // A one-call sentence is no shorter than the row it replaces.
    if (routine.length >= 2) for (const t of routine) folded.add(t.id)
  } else {
    for (const t of routine.slice(0, Math.max(0, routine.length - LIVE_KEEP))) if (o.sentenceOpen || t.id !== o.focusId) folded.add(t.id)
  }
  const mergedInto = new Map<string, string>()
  const merged = new Map<string, ToolCall[]>()
  if (o.settled) {
    const byPath = new Map<string, ToolCall[]>()
    for (const t of tools) {
      const p = editPathOf(t)
      if (p === null || o.keptIds.has(t.id) || rowState(t, false) !== 'done') continue
      byPath.set(p, [...(byPath.get(p) ?? []), t])
    }
    for (const edits of byPath.values()) {
      if (edits.length < 2) continue
      const keep = edits[edits.length - 1].id
      merged.set(keep, edits)
      for (const e of edits.slice(0, -1)) mergedInto.set(e.id, keep)
    }
  }
  let lastVisible: string | null = null
  for (const t of tools) if (!mergedInto.has(t.id) && (o.sentenceOpen || !folded.has(t.id))) lastVisible = t.id
  return { folded, mergedInto, merged, lastVisible }
}

export type SentencePart = { text: string; mono: boolean }

const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** How a verb names its objects (`named`, at 1 or 2) or counts them (`many`). `distinct` verbs count objects, so five
 *  reads of one file still name it; the rest count calls. Verbs with no object use `one` for a single call. */
interface Verb {
  named?: string
  one?: string
  many: (n: number) => string
  distinct?: boolean
  quote?: boolean
  mono?: boolean
}

function verbOf(t: ToolCall): { key: string; verb: Verb } {
  const n = t.name
  if (n === 'Read') return { key: n, verb: { named: 'read', many: (k) => `read ${count(k, 'file')}`, distinct: true } }
  if (isChangeRead(n)) return { key: n, verb: { named: 'read change', many: (k) => `read ${count(k, 'change')}`, distinct: true } }
  if (n === 'Grep') return { key: n, verb: { named: 'searched', many: (k) => `searched ${k} times` } }
  if (n === 'Glob') return { key: n, verb: { named: 'listed', many: (k) => `listed files ${k} times` } }
  if (n === 'WebFetch') return { key: n, verb: { named: 'fetched', many: (k) => `fetched ${count(k, 'page')}`, distinct: true } }
  if (n === 'WebSearch') return { key: n, verb: { named: 'searched the web for', many: (k) => `searched the web ${k} times`, quote: true } }
  if (n === 'Skill') return { key: n, verb: { named: 'used skill', many: (k) => `used ${count(k, 'skill')}`, distinct: true } }
  if (n === 'ToolSearch') return { key: n, verb: { one: 'loaded tools', many: () => 'loaded tools' } }
  if (n === 'TodoWrite') return { key: n, verb: { one: 'updated the todo list', many: () => 'updated the todo list' } }
  if (n === 'BashOutput' || n === 'TaskOutput') return { key: 'BashOutput', verb: { one: 'checked a background task', many: (k) => `checked background tasks ${k} times` } }
  if (n === 'KillShell') return { key: n, verb: { one: 'stopped a background task', many: (k) => `stopped ${count(k, 'background task')}` } }
  if (isBrowserTool(n)) return { key: 'browser', verb: { named: 'browser', many: (k) => `used the browser ${k} times` } }
  if (n === SURFACE_OPEN_TOOL || n === SURFACE_STATE_TOOL) {
    return { key: 'pane', verb: { one: n === SURFACE_OPEN_TOOL ? 'opened the pane' : 'checked the pane', many: (k) => `used the pane ${k} times` } }
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(n)
  if (mcp) return { key: `mcp:${mcp[1]}`, verb: { named: `used ${mcp[1]}`, many: (k) => `used ${mcp[1]} ${k} times`, mono: false } }
  const label = toolLabel(n)
  return { key: `tool:${label}`, verb: { one: `used ${label}`, many: (k) => `used ${label} ${k} times` } }
}

function objectOf(t: ToolCall, changeLabel: (t: ToolCall) => string | null): string | null {
  const o = (t.input && typeof t.input === 'object' ? t.input : {}) as Record<string, unknown>
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
  switch (t.name) {
    case 'Read': {
      const p = str(o.file_path)
      return p && p.slice(p.lastIndexOf('/') + 1)
    }
    case 'Grep':
    case 'Glob':
      return str(o.pattern)
    case 'WebSearch':
      return str(o.query)
    case 'Skill':
      return str(o.skill)
    case 'WebFetch':
      try {
        return new URL(str(o.url) ?? '').host || null
      } catch {
        return null
      }
  }
  if (isChangeRead(t.name)) return changeLabel(t)
  if (isBrowserTool(t.name)) return browserLabel(t.name, t.input)
  const mcp = /^mcp__.+?__(.+)$/.exec(t.name)
  return mcp ? mcp[1] : null
}

function commandOf(t: ToolCall): string {
  const c = (t.input as { command?: unknown } | undefined)?.command
  const line = typeof c === 'string' ? (c.split('\n').find((l) => l.trim()) ?? '').trim() : ''
  return line.length > 40 ? `${line.slice(0, 39)}…` : line
}

/** `a`, `a and b`, `a, b and c`, with no Oxford comma. */
function listOf(items: SentencePart[][]): SentencePart[] {
  return items.flatMap((p, i) => (i === 0 ? p : [{ text: i === items.length - 1 ? ' and ' : ', ', mono: false }, ...p]))
}

const sans = (text: string): SentencePart => ({ text, mono: false })

function objectParts(obj: string, v: Verb): SentencePart[] {
  const o = { text: obj, mono: v.mono ?? true }
  return v.quote ? [sans('"'), o, sans('"')] : [o]
}

/** The dim line a settled run's routine calls fold into: verb phrases in order of first appearance, objects named at 1
 *  or 2 and counted from 3. The Bash clause goes last because it is the only one with its own comma list, so a clause
 *  after it would read as one more command. It names the first `bashNamed` distinct commands and counts the rest. */
export function sentenceOf(
  tools: ToolCall[],
  o: { changeLabel: (t: ToolCall) => string | null; bashNamed: number }
): { parts: SentencePart[]; plain: string } {
  const groups = new Map<string, { verb: Verb; tools: ToolCall[] }>()
  const bash: ToolCall[] = []
  for (const t of tools) {
    if (t.name === 'Bash') {
      bash.push(t)
      continue
    }
    const { key, verb } = verbOf(t)
    const g = groups.get(key)
    if (g) g.tools.push(t)
    else groups.set(key, { verb, tools: [t] })
  }
  const clauses: SentencePart[][] = []
  for (const { verb, tools: calls } of groups.values()) {
    const objs = calls.map((t) => objectOf(t, o.changeLabel))
    const distinct = [...new Set(objs.filter((x): x is string => x !== null))]
    const complete = objs.every((x) => x !== null)
    const n = verb.distinct && complete ? distinct.length : calls.length
    if (verb.named && complete && n <= 2) clauses.push([sans(`${verb.named} `), ...listOf(distinct.map((x) => objectParts(x, verb)))])
    else if (verb.one && calls.length === 1) clauses.push([sans(verb.one)])
    else clauses.push([sans(verb.many(n))])
  }
  if (bash.length) {
    const cmds = [...new Set(bash.map(commandOf))]
    const names = cmds.slice(0, Math.max(0, o.bashNamed))
    const rest = bash.filter((t) => !names.includes(commandOf(t))).length
    const named = names.map((c): SentencePart[] => [{ text: c, mono: true }])
    if (!names.length) clauses.push([sans(`ran ${count(rest, 'command')}`)])
    else clauses.push([sans('ran '), ...listOf(rest ? [...named, [sans(count(rest, 'more command'))]] : named)])
  }
  const parts = clauses.flatMap((c, i) => (i ? [sans(', '), ...c] : c))
  if (parts[0]) parts[0] = { ...parts[0], text: parts[0].text.charAt(0).toUpperCase() + parts[0].text.slice(1) }
  return { parts, plain: parts.map((p) => p.text).join('') }
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
  if (name === 'SendMessage') return 'Message'
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
  if (action === 'click' && o.button === 'right') return ref === null ? 'right-click' : `right-click ${ref}`
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
