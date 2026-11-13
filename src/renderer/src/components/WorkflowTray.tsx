/**
 * Info-bar chip for ultracode workflows. A workflow runs while the main agent keeps
 * chatting, so its inline card can scroll away. This chip is the always-reachable
 * handle. Clicks open the workflow's tab. Completed workflows linger ~15s (still clickable)
 * until opened, displaced, or grace-timer cleared.
 */
import { useEffect, useRef } from 'react'
import { EMPTY_PENDING, useActive, useSession, type WorkflowState } from '../store'
import { focusPaneTitle } from '../lib/dive'
import { RUN_WORDS } from '../lib/agents'
import { workflowSummary } from '../lib/workflow'
import { RunMark } from './RunMark'

const EMPTY: Record<string, WorkflowState> = {}
const LINGER_MS = 15_000

export function WorkflowTray(): JSX.Element | null {
  const workflows = useActive((s) => s?.workflows ?? EMPTY)
  const pending = useActive((s) => s?.pendingPermissions ?? EMPTY_PENDING)
  const openWorkflowTab = useSession((s) => s.openWorkflowTab)
  const handleId = useActive((s) => s?.handleId ?? null)
  const clearCompleted = useSession((s) => s.clearCompletedBgWork)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A record read back from disk for a tab is history, not news.
  const all = Object.values(workflows).filter((w) => !w.restored)
  const running = all.filter((w) => w.endedStatus === null)
  const ended = all.filter((w) => w.endedStatus !== null)

  // Grace timer: when there are lingering ENDED workflows and nothing running, arm a
  // one-shot ~15s clear. Timer lives in a ref (StrictMode double-invokes effects, and a
  // setTimeout in a setState updater would orphan; the ref + cleanup is the safe pattern).
  // A NEW running workflow (displacement) also clears the old ended ones (see below).
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
  // something takes their place", the strongest anti-clutter rule).
  useEffect(() => {
    if (running.length > 0 && ended.length > 0) clearCompleted('workflow')
  }, [running.length, ended.length, clearCompleted])

  if (all.length === 0) return null

  // The chip opens the running workflow if any, else the most recent ended; several running read as one.
  const shown = running.length ? running : [ended[ended.length - 1]]
  const target = shown[0]
  const sums = shown.map((w) => workflowSummary(w, pending))
  const state = sums.some((x) => x.state.state === 'needs') ? 'needs' : sums[0].state.state
  const add = (k: 'done' | 'total' | 'failed' | 'stopped'): number => sums.reduce((n, x) => n + x[k], 0)
  const [done, total, failed, stopped] = [add('done'), add('total'), add('failed'), add('stopped')]
  const label = shown.length > 1 ? `${shown.length} workflows` : target.name
  const counts = total ? `${done} of ${total} done` : ''

  return (
    <button
      data-ui="workflow-tray"
      className="flex h-6 min-w-0 items-center gap-1.5 rounded-full bg-control px-2 font-mono text-meta text-dim transition-colors hover:bg-control-hover"
      onClick={() => {
        if (handleId) openWorkflowTab(handleId, target.taskId, target.name)
        requestAnimationFrame(focusPaneTitle)
        clearCompleted('workflow') // opening = "seen" → clear the lingering done state.
      }}
      aria-label={`Workflow ${label}, ${RUN_WORDS[state].spoken}${counts ? `, ${counts}` : ''}${failed ? `, ${failed} failed` : ''}${stopped ? `, ${stopped} stopped` : ''}, open workflow`}
      title={label}
    >
      <RunMark state={state} />
      <span className="min-w-0 max-w-[16ch] truncate text-content">{label}</span>
      {counts && (
        <span className="shrink-0 tabular-nums @max-[560px]:sr-only">
          · {counts}
          {failed > 0 && <span className="text-content"> · {failed} failed</span>}
          {stopped > 0 && <> · {stopped} stopped</>}
        </span>
      )}
    </button>
  )
}
