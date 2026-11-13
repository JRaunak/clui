import type { WorkflowRun } from '../../../shared/ipc'
import type { PendingPermission, PerSessionState, ToolCall, WorkflowState } from '../store'
import { isLive, workflowAgentState, type RunState, type RunStatusOf } from './agents'

/** One reading of a workflow for the strip, the tray chip, the info row and the tree, so they never disagree. */
export interface WorkflowSummary {
  state: RunStatusOf
  /** Each agent's state, in `agents` order. */
  states: RunState[]
  done: number
  failed: number
  stopped: number
  total: number
}

export function workflowSummary(w: WorkflowState, pending: readonly PendingPermission[]): WorkflowSummary {
  const states = w.agents.map((a) => workflowAgentState(a, w.endedStatus, pending))
  const count = (s: RunState): number => states.filter((x) => x === s).length
  const e = w.endedStatus
  const state: RunStatusOf =
    e === null
      ? { state: w.stopping ? 'stopping' : states.includes('needs') ? 'needs' : 'running', startMs: w.startMs }
      : e === 'interrupted'
        ? { state: 'interrupted', reason: 'quit' }
        : { state: e === 'completed' ? 'done' : e === 'killed' || e === 'stopped' ? 'stopped' : 'failed', durationMs: w.durationMs }
  return { state, states, done: count('done'), failed: count('failed'), stopped: count('stopped'), total: w.agents.length }
}

/** A phase's state from its agents'. A run that's over never reads running, and one Clui quit during
 *  leaves every phase it didn't finish interrupted. */
export function phaseState(states: readonly RunState[], workflow: RunState): RunState {
  const has = (s: RunState): boolean => states.includes(s)
  const all = !!states.length && states.every((s) => s === 'done')
  if (workflow === 'interrupted') return all ? 'done' : 'interrupted'
  if (has('needs')) return 'needs'
  if (has('running')) return 'running'
  if (has('failed')) return 'failed'
  if (has('stopped')) return 'stopped'
  if (all) return 'done'
  // A stop ends every agent it reached, started or not, so a phase it cut off before anything ran reads stopped too.
  if (workflow === 'stopped') return 'stopped'
  if (states.some((s) => s !== 'queued')) return isLive(workflow) ? 'running' : 'done'
  return 'queued'
}

/** The workflow a Workflow tool card launched: the live record that names the call, else the task id its result
 *  text gives. Null when neither does, so the card stays a plain disclosure. */
export function workflowTaskOf(slice: Pick<PerSessionState, 'workflows'>, tool: Pick<ToolCall, 'id' | 'result'>): string | null {
  const live = Object.values(slice.workflows).find((w) => w.toolUseId === tool.id)
  if (live) return live.taskId
  return /Task ID: ([A-Za-z0-9_-]{1,64})/.exec(tool.result ?? '')?.[1] ?? null
}

/** A workflow as its record on disk tells it. */
export const recordOf = (run: WorkflowRun): WorkflowState => ({
  taskId: run.taskId,
  name: run.name,
  description: run.summary ?? '',
  phases: run.phases,
  agents: run.agents,
  startMs: run.startTime,
  // The run's process died with the app that launched it.
  endedStatus: run.status === 'running' ? 'interrupted' : run.status,
  durationMs: run.durationMs,
  result: run.result,
  restored: true
})

export const hasWorkflows = (s: Pick<PerSessionState, 'workflows' | 'messages'>): boolean =>
  Object.keys(s.workflows).length > 0 || s.messages.some((m) => m.tools.some((t) => t.name === 'Workflow'))

export const runningWorkflows = (s: Pick<PerSessionState, 'workflows'>): number => Object.values(s.workflows).filter((w) => w.endedStatus === null).length

/** The session's workflows, newest first: the slice's own, then the records on disk it doesn't hold. */
export function workflowRows(slice: Pick<PerSessionState, 'workflows'>, disk: readonly WorkflowRun[] | null): WorkflowState[] {
  const rows = [...Object.values(slice.workflows), ...(disk ?? []).filter((r) => !slice.workflows[r.taskId]).map(recordOf)]
  return rows.sort((a, b) => (b.startMs ?? 0) - (a.startMs ?? 0))
}
