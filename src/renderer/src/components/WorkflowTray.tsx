/**
 * Info-bar chip for dynamic workflows (ultracode). A workflow runs while the main agent
 * keeps chatting, so its inline card can scroll away — this chip is the always-reachable
 * handle. Clicking opens the maximized transcript view's phase tree for that workflow.
 *
 * LINGER: an ENDED workflow does NOT vanish instantly (that was a silent completion —
 * no linger, no toast). It stays in a neutral "done" state, still clickable into its phase
 * tree (a record of what each phase did), until it's opened, displaced by a new workflow,
 * or a ~15s grace timer elapses — then it's cleared. Uses info-blue (matching the bg-task
 * tray), NOT the terracotta accent — a workflow is background activity, not the scarce focal.
 */
import { useCallback, useEffect, useRef } from 'react'
import { useActive, useSession, type WorkflowState } from '../store'

const EMPTY: Record<string, WorkflowState> = {}
const LINGER_MS = 15_000

export function WorkflowTray(): JSX.Element | null {
  const workflows = useActive((s) => s?.workflows ?? EMPTY)
  const viewWorkflow = useSession((s) => s.viewSubagent)
  const clearCompleted = useSession((s) => s.clearCompletedBgWork)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const all = Object.values(workflows)
  const running = all.filter((w) => w.endedStatus === null)
  const ended = all.filter((w) => w.endedStatus !== null)

  // Grace timer: when there are lingering ENDED workflows and nothing running, arm a
  // one-shot ~15s clear. Timer lives in a ref (StrictMode double-invokes effects — a
  // setTimeout in a setState updater would orphan; the ref + cleanup is the safe pattern).
  // A NEW running workflow (displacement) also clears the old ended ones — see below.
  useEffect(() => {
    if (ended.length > 0 && running.length === 0) {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => clearCompleted('workflow'), LINGER_MS)
    }
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
    // Re-arm when the ended/running counts change.
  }, [ended.length, running.length, clearCompleted])

  // Displacement: a new running workflow supersedes lingering ended ones ("until
  // something takes their place" — the strongest anti-clutter rule).
  useEffect(() => {
    if (running.length > 0 && ended.length > 0) clearCompleted('workflow')
  }, [running.length, ended.length, clearCompleted])

  if (all.length === 0) return null

  const hasRunning = running.length > 0
  // Aggregate agent states across RUNNING workflows for the live chip summary.
  const agents = running.flatMap((w) => w.agents)
  const done = agents.filter((a) => /done|complete|success/i.test(a.state)).length
  const failed = agents.filter((a) => /fail|error/i.test(a.state)).length
  const active = agents.length - done - failed

  // Which workflow the chip opens: the running one (if any), else the most recent ended.
  const target = hasRunning ? running[0] : ended[ended.length - 1]
  const label = hasRunning
    ? running.length === 1
      ? running[0].name
      : `${running.length} workflows`
    : ended.length === 1
      ? ended[0].name
      : `${ended.length} workflows`

  const anyFailed = !hasRunning && ended.some((w) => /fail|error/i.test(w.endedStatus ?? ''))

  return (
    <button
      className={`flex items-center gap-1.5 rounded-md px-2 py-0.5 font-mono text-[11px] transition-[filter] hover:brightness-125 ${
        hasRunning ? 'bg-info/15 text-info' : anyFailed ? 'bg-err/10 text-err' : 'text-dim'
      }`}
      onClick={() => {
        viewWorkflow(target.taskId)
        clearCompleted('workflow') // opening = "seen" → clear the lingering done state.
      }}
      title={hasRunning ? "Open the workflow's live phase tree" : 'Workflow finished — open its phase tree'}
    >
      <span className="text-[10px]">◆</span>
      <span>{label}</span>
      {hasRunning ? (
        agents.length > 0 && (
          /* Full-strength info (not /70) — the count is the payload of this chip and
             at 70% opacity on the blue tint it fell to 2.97:1 (below AA). The leading
             "·" already separates it from the name; contrast shouldn't. */
          <span className="text-info">
            · {done}✓ {active} running{failed ? ` ${failed}✗` : ''}
          </span>
        )
      ) : (
        <span className="text-dim">· {anyFailed ? 'failed' : 'done'}</span>
      )}
    </button>
  )
}
