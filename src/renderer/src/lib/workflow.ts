import type { PendingPermission, PerSessionState, ToolCall, WorkflowState } from '../store'
import { workflowAgentState, type RunState, type RunStatusOf } from './agents'

/** One reading of a workflow for the strip, the tray chip, the info row and the tree, so they never disagree. */
export interface WorkflowSummary {
  state: RunStatusOf
  /** Each agent's state, in `agents` order. */
  states: RunState[]
  done: number
  failed: number
  stopped: number
  total: number
  tokens?: number
}

export function workflowSummary(w: WorkflowState, pending: readonly PendingPermission[]): WorkflowSummary {
  const states = w.agents.map((a) => workflowAgentState(a, w.endedStatus, pending))
  const count = (s: RunState): number => states.filter((x) => x === s).length
  const e = w.endedStatus
  const state: RunStatusOf =
    e === null
      ? { state: states.includes('needs') ? 'needs' : 'running', startMs: w.startMs }
      : e === 'interrupted'
        ? { state: 'interrupted', reason: 'quit' }
        : { state: e === 'completed' ? 'done' : e === 'killed' || e === 'stopped' ? 'stopped' : 'failed', durationMs: w.durationMs }
  // Agents report tokens only once done; the sum must match the Tokens column, so the run's own total never stands in.
  const sum = w.agents.reduce((n, a, i) => (states[i] === 'done' && a.tokens !== undefined ? n + a.tokens : n), 0)
  return { state, states, done: count('done'), failed: count('failed'), stopped: count('stopped'), total: w.agents.length, tokens: sum || undefined }
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
  if (states.some((s) => s !== 'queued')) return workflow === 'running' || workflow === 'needs' ? 'running' : 'done'
  return 'queued'
}

/** The workflow a Workflow tool card launched: the live record that names the call, else the task id its result
 *  text gives. Null when neither does, so the card stays a plain disclosure. */
export function workflowTaskOf(slice: Pick<PerSessionState, 'workflows'>, tool: Pick<ToolCall, 'id' | 'result'>): string | null {
  const live = Object.values(slice.workflows).find((w) => w.toolUseId === tool.id)
  if (live) return live.taskId
  return /Task ID: ([A-Za-z0-9_-]{1,64})/.exec(tool.result ?? '')?.[1] ?? null
}
