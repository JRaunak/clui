import type { AgentRun } from '../../../shared/ipc'
import type { AgentMeta, HistoryMessage } from '../../../shared/sessions'
import { agentRefOf, type AgentRef, type SurfaceTab } from '../../../shared/surfaces'
import type { BackgroundTask, PendingPermission, PerSessionState, SubagentMessage, ToolCall, WorkflowAgent, WorkflowState } from '../store'
import { assignFaces, type Launch } from './faces'

export const isAgentTool = (name: string): boolean => name === 'Task' || name === 'Agent'

export function subagentType(input: unknown): string | null {
  if (input && typeof input === 'object') {
    const t = (input as Record<string, unknown>).subagent_type
    if (typeof t === 'string' && t) return t
  }
  return null
}

export function agentDescription(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    if (typeof o.description === 'string') return o.description
    if (typeof o.prompt === 'string') return o.prompt
  }
  return ''
}

/** An agent tab's label: the launch's description, else its type, else "Agent". */
export const agentLabel = (input: unknown): string => agentDescription(input).trim() || subagentType(input) || 'Agent'

export function findAgentTool(messages: readonly { tools: ToolCall[] }[], id: string): ToolCall | null {
  for (const m of messages) {
    const t = m.tools.find((tc) => tc.id === id)
    if (t) return t
  }
  return null
}

/** The launching Agent call for a subagent: main's card, else the entry in its parent's live stream (which
 *  `subagent-tool-result` completes), else the call in its parent's transcript read from disk. */
export function launcherOf(slice: Pick<PerSessionState, 'messages' | 'subagentMessages' | 'nestedLaunches'>, id: string): ToolCall | null {
  const main = findAgentTool(slice.messages, id)
  if (main) return main
  for (const entries of Object.values(slice.subagentMessages)) for (const e of entries) if (e.kind === 'tool' && e.tool.id === id) return e.tool
  for (const tools of Object.values(slice.nestedLaunches)) for (const t of tools) if (t.id === id) return t
  return null
}

/** The agent that launched a nested one, by tool_use id, else null for main's own. */
function parentOf(slice: Pick<PerSessionState, 'subagentMessages' | 'nestedLaunches' | 'subagentChildren'>, id: string): string | null {
  for (const [p, list] of Object.entries(slice.subagentChildren)) if (list.some((c) => c.childToolUseId === id)) return p
  for (const [p, entries] of Object.entries(slice.subagentMessages)) if (entries.some((e) => e.kind === 'tool' && e.tool.id === id)) return p
  for (const [p, tools] of Object.entries(slice.nestedLaunches)) if (tools.some((t) => t.id === id)) return p
  return null
}

/** A nested agent's ancestor tab ids, root first, as far as the session knows them; at most 8. */
export function trailOf(slice: Pick<PerSessionState, 'subagentMessages' | 'nestedLaunches' | 'subagentChildren'>, id: string): string[] {
  const out: string[] = []
  for (let p = parentOf(slice, id); p && out.length < 8 && !out.includes(`agent:tool:${p}`); p = parentOf(slice, p)) out.unshift(`agent:tool:${p}`)
  return out
}

/** An Agent-tool subagent's label, type and launch input, from its launching call or its parent's child record. */
export function agentInfo(slice: Pick<PerSessionState, 'messages' | 'subagentMessages' | 'nestedLaunches' | 'subagentChildren'>, id: string): { label: string; subtype: string | null; input: unknown } {
  const tool = launcherOf(slice, id)
  if (tool) return { label: agentLabel(tool.input), subtype: subagentType(tool.input), input: tool.input }
  for (const list of Object.values(slice.subagentChildren)) {
    const c = list.find((x) => x.childToolUseId === id)
    if (c) return { label: c.description?.trim() || c.subagentType || 'Agent', subtype: c.subagentType ?? null, input: null }
  }
  return { label: 'Agent', subtype: null, input: null }
}

export type RunState = 'queued' | 'running' | 'background' | 'done' | 'failed' | 'stopped' | 'interrupted' | 'needs' | 'stopping'
export type InterruptReason = 'quit' | 'no-result'
export interface RunStatusOf {
  state: RunState
  reason?: InterruptReason
  startMs?: number
  durationMs?: number
}

export const RUN_WORDS: Record<RunState, { word: string; spoken: string }> = {
  queued: { word: 'Queued', spoken: 'queued' },
  running: { word: 'Running', spoken: 'running' },
  background: { word: 'In background', spoken: 'running in background' },
  done: { word: 'Done', spoken: 'done' },
  failed: { word: 'Failed', spoken: 'failed' },
  stopped: { word: 'Stopped', spoken: 'stopped' },
  interrupted: { word: 'Interrupted', spoken: 'interrupted' },
  needs: { word: 'Needs you', spoken: 'needs you' },
  stopping: { word: 'Stopping…', spoken: 'stopping' }
}

export const REASON_COPY: Record<InterruptReason, string> = {
  quit: 'Clui quit while it was running',
  'no-result': 'It ended without a result'
}

export const isLive = (s: RunState): boolean => s === 'running' || s === 'background' || s === 'needs' || s === 'stopping'

export const STARTING = 'Starting…'

/** The line under a live agent: '' once it ends, a pause while it waits on the user, else the CLI's latest step.
 *  `holds` keeps the slot from launch with "Starting…"; without it the line waits for a first step. */
export function activityLine(state: RunState, activity: string | undefined, holds: boolean): string {
  if (!isLive(state) || (activity === undefined && !holds)) return ''
  return state === 'needs' ? 'Paused until you answer' : (activity ?? STARTING)
}

/** A workflow agent's state word as a run state. A workflow stop cuts its running agents off as `error`, and the user
 *  asked for that stop, so it and every agent it never reached read stopped. A run Clui quit during leaves its unfinished agents interrupted. */
export function runStateOf(state: string, workflowEnded: string | null): 'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'interrupted' {
  const cut = workflowEnded === 'killed' || workflowEnded === 'stopped'
  if (state === 'done') return 'done'
  if (state === 'error') return cut ? 'stopped' : 'failed'
  if (cut) return 'stopped'
  if (workflowEnded === 'interrupted') return 'interrupted'
  if (state === 'start' || state === 'running') return workflowEnded === null ? 'running' : 'stopped'
  return 'queued'
}

/** A workflow agent's state, needs while a gate it raised is up. Its gate carries only its agent id. */
export function workflowAgentState(a: WorkflowAgent, workflowEnded: string | null, pending: readonly PendingPermission[]): RunState {
  const s = runStateOf(a.state, workflowEnded)
  return s === 'running' && !!a.agentId && pending.some((p) => p.agentId === a.agentId) ? 'needs' : s
}

/** A workflow agent's status with its figures: elapsed from its start while it runs, its duration once done. */
export function workflowAgentStatus(a: WorkflowAgent, workflowEnded: string | null, pending: readonly PendingPermission[]): RunStatusOf {
  const state = workflowAgentState(a, workflowEnded, pending)
  return { state, ...(state === 'interrupted' ? { reason: 'quit' as const } : {}), startMs: a.startedAt, durationMs: state === 'done' ? a.durationMs : undefined }
}

export function workflowOfAgent(workflows: Record<string, WorkflowState>, agentId: string): { workflow: WorkflowState; agent: WorkflowAgent } | null {
  for (const workflow of Object.values(workflows)) {
    const agent = workflow.agents.find((a) => a.agentId === agentId)
    if (agent) return { workflow, agent }
  }
  return null
}

const span = (start: number | undefined, end: number | undefined): number | undefined => (start !== undefined && end !== undefined ? end - start : undefined)

function toolRunState(slice: PerSessionState, id: string, meta: AgentMeta | null | undefined): RunStatusOf {
  const bg = Object.values(slice.backgroundTasks).find((t) => t.taskType === 'local_agent' && t.toolUseId === id)
  if (bg) {
    // A stopped agent's row lingers with its stopping flag still set, so only a running one reads stopping.
    const state = bg.status === 'running' ? (bg.stopping ? 'stopping' : 'background') : bg.status === 'killed' ? 'stopped' : bg.status === 'failed' ? 'failed' : 'done'
    return { state, startMs: bg.startMs, durationMs: span(bg.startMs, bg.endMs) }
  }
  const tool = launcherOf(slice, id)
  if (tool && tool.startMs !== undefined) {
    const state = tool.result === undefined ? (slice.interrupting ? 'stopping' : 'running') : tool.stopped ? 'stopped' : tool.isError ? 'failed' : 'done'
    return { state, startMs: tool.startMs, durationMs: span(tool.startMs, tool.endMs) }
  }
  const durationMs = tool?.durationMs
  if (tool && !tool.background && meta?.shape !== 'background') {
    if (tool.result === 'User rejected tool use') return { state: 'stopped', durationMs }
    if (tool.result === undefined) return { state: 'interrupted', reason: 'quit' }
    return { state: tool.isError ? 'failed' : 'done', durationMs }
  }
  if (meta) return meta.finished ? { state: meta.stoppedByUser ? 'stopped' : 'done', durationMs } : { state: 'interrupted', reason: 'quit' }
  // A background launch whose sidecar hasn't been read yet: its completion notice is the only word on it.
  if (tool?.notifiedAt !== undefined) return { state: 'done', durationMs }
  if (tool) return { state: 'interrupted', reason: 'quit' }
  return slice.busy ? { state: 'running' } : { state: 'interrupted', reason: 'no-result' }
}

/** One status for an agent everywhere it shows. `meta` is its sidecar's outcome, undefined until read. */
export function agentRunState(slice: PerSessionState, ref: AgentRef, meta?: AgentMeta | null): RunStatusOf {
  if (ref.by === 'agent') {
    const hit = workflowOfAgent(slice.workflows, ref.id)
    return hit ? workflowAgentStatus(hit.agent, hit.workflow.endedStatus, slice.pendingPermissions) : { state: 'interrupted', reason: 'quit' }
  }
  const s = toolRunState(slice, ref.id, meta === undefined ? slice.agentMetas[ref.id] : meta)
  const asks = (s.state === 'running' || s.state === 'background') && slice.pendingPermissions.some((p) => p.agentToolUseId === ref.id)
  return asks ? { ...s, state: 'needs' } : s
}

/** What a tab's Stop ends: a background agent's task, main's turn while it waits on a foreground agent, or a whole
 *  workflow. Null when nothing it shows is running. `stopping` while that stop is in flight. */
export type StopTarget = ({ kind: 'task'; taskId: string; ancestor?: string } | { kind: 'turn' } | { kind: 'workflow'; taskId: string }) & { stopping: boolean }

export function stopTargetOf(slice: PerSessionState, tab: Pick<SurfaceTab, 'kind' | 'key' | 'trail'>): StopTarget | null {
  const workflow = (w: WorkflowState | undefined): StopTarget | null => (w?.endedStatus === null ? { kind: 'workflow', taskId: w.taskId, stopping: !!w.stopping } : null)
  if (tab.kind === 'workflow') return workflow(slice.workflows[tab.key])
  const ref = tab.kind === 'agent' ? agentRefOf(tab.key) : null
  if (!ref) return null
  // The CLI acks a stop_task on one workflow agent and stops nothing, so its tab stops the run it belongs to.
  if (ref.by === 'agent') return workflow(workflowOfAgent(slice.workflows, ref.id)?.workflow)
  if (!isLive(agentRunState(slice, ref).state)) return null
  const bgOf = (id: string): BackgroundTask | undefined => Object.values(slice.backgroundTasks).find((t) => t.taskType === 'local_agent' && t.toolUseId === id)
  const task = (t: BackgroundTask, ancestor?: string): StopTarget => ({ kind: 'task', taskId: t.taskId, ...(ancestor ? { ancestor } : {}), stopping: !!t.stopping })
  const own = bgOf(ref.id)
  if (own?.status === 'running') return task(own)
  // Interrupting main spares background agents, so a child of one stops only with it.
  const trail = tab.trail ?? trailOf(slice, ref.id)
  for (let i = trail.length - 1; i >= 0; i--) {
    const up = agentRefOf(trail[i].replace(/^agent:/, ''))
    const bg = up?.by === 'tool' ? bgOf(up.id) : undefined
    if (bg) return bg.status === 'running' ? task(bg, trail[i]) : null
  }
  return slice.busy || slice.interrupting ? { kind: 'turn', stopping: slice.interrupting } : null
}

/** An agent's tool calls: its result's total once there is one, else the count at its latest progress report. */
export function toolUsesOf(slice: PerSessionState, ref: AgentRef): number | undefined {
  if (ref.by === 'agent') return workflowOfAgent(slice.workflows, ref.id)?.agent.toolCalls
  return launcherOf(slice, ref.id)?.toolUses ?? slice.agentToolUses[ref.id]
}

export const hasAgents = (s: Pick<PerSessionState, 'messages'>): boolean => s.messages.some((m) => m.tools.some((t) => isAgentTool(t.name)))

/** An agent's status in the Subagents list. One this process watched start is read live. Otherwise its files say how
 *  it ended, and only an agent the live state places (a nested child streaming now) may read running: anything else
 *  they leave open was interrupted. */
function listStatus(slice: PerSessionState, id: string, run: AgentRun | undefined): RunStatusOf {
  const live = agentRunState(slice, { by: 'tool', id })
  const watched = Object.values(slice.backgroundTasks).some((t) => t.toolUseId === id) || launcherOf(slice, id)?.startMs !== undefined
  if (watched) return live
  if (run && run.outcome !== 'open') return { state: run.outcome, durationMs: run.durationMs }
  const placed = Object.values(slice.subagentChildren).some((kids) => kids.some((c) => c.childToolUseId === id))
  return (isLive(live.state) ? placed : !run) ? live : { state: 'interrupted', reason: 'quit' }
}

export interface AgentListRow {
  id: string
  label: string
  type: string | null
  status: RunStatusOf
  face: number | null
  /** Its ancestors' tab ids, root first. */
  trail: string[]
  children: AgentListRow[]
}

/** Every Agent-tool subagent the session knows, by tool_use id, to its parent's (null for main's own), in launch
 *  order: the disk's, then what the slice holds that the disk didn't have yet. */
function agentParents(slice: PerSessionState, disk: readonly AgentRun[] | null): Map<string, string | null> {
  const up = new Map<string, string | null>()
  for (const r of disk ?? []) up.set(r.toolUseId, r.parent ?? null)
  for (const m of slice.messages) for (const t of m.tools) if (isAgentTool(t.name) && !up.has(t.id)) up.set(t.id, null)
  for (const [p, kids] of Object.entries(slice.subagentChildren)) for (const c of kids) if (!up.has(c.childToolUseId)) up.set(c.childToolUseId, p)
  for (const [p, tools] of Object.entries(slice.nestedLaunches)) for (const t of tools) if (!up.has(t.id)) up.set(t.id, p)
  return up
}

export const agentCount = (slice: PerSessionState, disk: readonly AgentRun[] | null): number => agentParents(slice, disk).size

/** The Subagents tree: main's launches newest first, each agent's children in launch order under it. */
export function agentRows(slice: PerSessionState, disk: readonly AgentRun[] | null): AgentListRow[] {
  const runs = new Map(disk?.map((r) => [r.toolUseId, r]))
  const up = agentParents(slice, disk)
  const kids = new Map<string | null, string[]>()
  for (const [id, p] of up) {
    const parent = p !== null && up.has(p) ? p : null
    const list = kids.get(parent)
    if (list) list.push(id)
    else kids.set(parent, [id])
  }
  const build = (id: string, trail: string[]): AgentListRow => {
    const run = runs.get(id)
    const info = agentInfo(slice, id)
    const status = listStatus(slice, id, run)
    const inner = [...trail, `agent:tool:${id}`]
    return {
      id,
      label: info.label === 'Agent' && run ? run.description.trim() || run.subagentType || 'Agent' : info.label,
      type: info.subtype ?? run?.subagentType ?? null,
      status,
      face: faceOf(slice, { key: `tool:${id}`, trail }),
      trail,
      children: inner.length > 8 ? [] : (kids.get(id) ?? []).map((c) => build(c, inner))
    }
  }
  return (kids.get(null) ?? []).map((id) => build(id, [])).reverse()
}

/** How many of the session's subagents run now, nested ones included, without building the tree. The strip, the
 *  picker and the list's summary all count through this. Only an id the live state places can be running. */
export function runningAgents(slice: PerSessionState, disk: readonly AgentRun[] | null): number {
  const ids = new Set<string>()
  for (const t of Object.values(slice.backgroundTasks)) if (t.taskType === 'local_agent' && t.toolUseId && t.status === 'running') ids.add(t.toolUseId)
  for (const m of slice.messages) for (const t of m.tools) if (isAgentTool(t.name) && t.startMs !== undefined && t.result === undefined) ids.add(t.id)
  for (const entries of Object.values(slice.subagentMessages)) for (const e of entries) if (e.kind === 'tool' && isAgentTool(e.tool.name) && e.tool.startMs !== undefined && e.tool.result === undefined) ids.add(e.tool.id)
  for (const kids of Object.values(slice.subagentChildren)) for (const c of kids) ids.add(c.childToolUseId)
  if (!ids.size) return 0
  const runs = disk ? new Map(disk.map((r) => [r.toolUseId, r])) : null
  return [...ids].filter((id) => isLive(listStatus(slice, id, runs?.get(id)).state)).length
}

/** A disk transcript as the live stream shape. Disk keeps no block order inside a message, so thinking, then text,
 *  then tools, as the main transcript's rebuilt fallback does. */
export function entriesOf(history: readonly HistoryMessage[]): SubagentMessage[] {
  return history.flatMap((m): SubagentMessage[] =>
    m.peer
      ? []
      : [
          ...(m.thinking ? [{ kind: 'thinking' as const, role: m.role, text: m.thinking }] : []),
          ...(m.text ? [{ kind: 'text' as const, role: m.role, text: m.text }] : []),
          ...m.tools.map((t) => ({ kind: 'tool' as const, tool: { ...t } }))
        ]
  )
}

const mainFaces = new WeakMap<PerSessionState['messages'], { bg: PerSessionState['backgroundTasks']; faces: Map<string, number> }>()

/** Main's Agent calls in message order. A foreground agent is over before main's next message; a background one
 *  holds its face until its completion notice. */
function mainScope(slice: PerSessionState): Map<string, number> {
  const hit = mainFaces.get(slice.messages)
  if (hit && hit.bg === slice.backgroundTasks) return hit.faces
  const bgIds = new Set(Object.values(slice.backgroundTasks).map((t) => t.toolUseId))
  const launches: Launch[] = slice.messages.flatMap((m, at) =>
    m.tools
      .filter((t) => isAgentTool(t.name))
      .map((t) => {
        const bg = t.background || t.sentToBackground || t.notifiedAt !== undefined || bgIds.has(t.id)
        return { key: t.id, at, end: !bg ? at + 0.5 : t.notifiedAt !== undefined ? t.notifiedAt + 0.5 : null }
      })
  )
  const faces = assignFaces(launches)
  mainFaces.set(slice.messages, { bg: slice.backgroundTasks, faces })
  return faces
}

/** The children an agent launched, in order: its live stream's, else the ones its transcript recorded. */
const childrenOf = (slice: PerSessionState, parent: string): string[] | null =>
  slice.subagentChildren[parent]?.length ? slice.subagentChildren[parent].map((c) => c.childToolUseId) : (slice.nestedLaunches[parent]?.map((t) => t.id) ?? null)

function toolFace(slice: PerSessionState, id: string, trail: readonly string[]): number | null {
  const parentRef = trail.length ? agentRefOf(trail[trail.length - 1].replace(/^agent:/, '')) : null
  if (!parentRef || parentRef.by !== 'tool') return mainScope(slice).get(id) ?? null
  const parentFace = toolFace(slice, parentRef.id, trail.slice(0, -1))
  const kids = childrenOf(slice, parentRef.id)
  if (parentFace === null || !kids) return null
  // ponytail: nested faces ignore top-level holds; merge scopes by record timestamp if users report a clash
  return assignFaces(kids.map((key, at) => ({ key, at, end: null })), parentFace + 1, new Set([parentFace])).get(id) ?? null
}

/** The face an agent tab wears, or null for the generic mark while its scope's launch list isn't known. */
export function faceOf(slice: PerSessionState, tab: Pick<SurfaceTab, 'key' | 'trail'>): number | null {
  const ref = agentRefOf(tab.key)
  if (!ref) return null
  if (ref.by === 'tool') return toolFace(slice, ref.id, tab.trail ?? [])
  const hit = workflowOfAgent(slice.workflows, ref.id)
  return hit ? (workflowFaces(hit.workflow).get(ref.id) ?? null) : null
}

const wfFaces = new WeakMap<WorkflowAgent[], Map<string, number>>()

/** A workflow's agents' faces by agent id, in launch (index) order. */
export function workflowFaces(w: WorkflowState): Map<string, number> {
  const hit = wfFaces.get(w.agents)
  if (hit) return hit
  const agents = w.agents.filter((a) => a.agentId).sort((a, b) => a.index - b.index)
  const faces = assignFaces(agents.map((a) => ({ key: a.agentId!, at: a.index, end: null })))
  wfFaces.set(w.agents, faces)
  return faces
}

/** Labeled tabs need 120px each and 4px between. Dense mode leaves only once they fit with 24px to spare, so a
 *  resize hovering at the edge doesn't flap. */
export function denseNext(n: number, width: number, wasDense: boolean): boolean {
  const need = 120 * n + 4 * Math.max(0, n - 1)
  return wasDense ? need > width - 24 : need > width
}
