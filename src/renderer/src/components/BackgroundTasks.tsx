/**
 * Background-task indicator for the bottom info bar (the active session's ambient
 * status strip). A backgrounded task keeps running after the turn's `result` fires
 * — so this is deliberately NOT in the composer (which is reserved for the
 * foreground turn's verb+timer footer). Blue (--color-info) reads as "ambient /
 * informational, no action needed", distinct from the amber foreground running.
 *
 * Clicking the chip opens a popover listing each task with its own elapsed timer
 * and a ✕ to stop it (tool-mediated TaskStop — costs a turn, shows a "stopping…"
 * state until the killed event lands).
 *
 * This tray also holds backgrounded SUBAGENTS (taskType 'local_agent'), not just
 * bg bash shells — the CLI announces both here. A subagent row additionally opens its
 * forwarded transcript (SubagentView, keyed by the row's toolUseId = the parent
 * tool_use id), matching the inline Agent card's "→" open-transcript affordance.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useActive, useSession, type BackgroundTask } from '../store'
import { useEscape } from '../lib/useEscape'
import { useClickOutside } from '../lib/useClickOutside'
import { IconClose, IconCheck } from './Icon'

const EMPTY: Record<string, BackgroundTask> = {}

const LINGER_MS = 15_000

export function BackgroundTasks(): JSX.Element | null {
  const tasks = useActive((s) => s?.backgroundTasks ?? EMPTY)
  const handleId = useActive((s) => s?.handleId ?? null)
  const stopTask = useSession((s) => s.stopBackgroundTask)
  const viewSubagent = useSession((s) => s.viewSubagent)
  const clearCompleted = useSession((s) => s.clearCompletedBgWork)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const list = Object.values(tasks).sort((a, b) => a.startMs - b.startMs)
  const running = list.filter((t) => t.status === 'running')
  // Lingering = terminal subagent rows kept clickable post-completion (see store).
  const lingering = list.filter((t) => t.taskType === 'local_agent' && t.status !== 'running')

  const dismiss = useCallback(() => setOpen(false), [])
  useClickOutside(ref, open, dismiss)
  useEscape(open, dismiss)

  // LINGER grace timer: arm a ~15s one-shot to clear lingering completed subagents when
  // nothing is running. Timer in a ref (StrictMode-safe; the deferred-timer pattern used
  // elsewhere). A new running task re-arms on the next change. Opening the tray also
  // clears them (below) — "seen".
  useEffect(() => {
    if (lingering.length > 0 && running.length === 0) {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => clearCompleted('subagent'), LINGER_MS)
    }
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
  }, [lingering.length, running.length, clearCompleted])

  // Nothing to show once there are no tasks at all (running or recently-terminal).
  if (list.length === 0) return null

  return (
    <div className="relative" ref={ref}>
      <button
        className="flex items-center gap-1.5 rounded text-info transition-colors hover:brightness-110"
        onClick={() => setOpen((v) => !v)}
        title="Background tasks"
      >
        <span
          className="h-1.5 w-1.5 rounded-full bg-info"
          style={running.length > 0 ? { animation: 'var(--animate-breathe)' } : undefined}
          aria-hidden="true"
        />
        {running.length > 0
          ? `${running.length} background task${running.length > 1 ? 's' : ''}`
          : 'Background tasks'}
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1.5 w-[min(420px,90vw)] overflow-hidden rounded-lg border border-border bg-bg-elev shadow-lg">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="h-1.5 w-1.5 rounded-full bg-info" aria-hidden="true" />
            <span className="text-xs font-semibold text-content">Background tasks</span>
            <span className="ml-auto font-mono text-[11px] text-faint">
              {running.length} running · {list.length - running.length} done
            </span>
          </div>
          <div className="max-h-[40vh] overflow-y-auto py-1">
            {list.map((t) => (
              <Row
                key={t.taskId}
                task={t}
                onStop={() => handleId && void stopTask(handleId, t.taskId)}
                onOpen={
                  t.taskType === 'local_agent' && t.toolUseId
                    ? () => {
                        setOpen(false)
                        viewSubagent(t.toolUseId as string)
                        // Opening a completed subagent = "seen" → stop lingering it.
                        if (t.status !== 'running') clearCompleted('subagent')
                      }
                    : undefined
                }
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Row({
  task,
  onStop,
  onOpen
}: {
  task: BackgroundTask
  onStop: () => void
  /** Present only for a backgrounded SUBAGENT row — opens its transcript. */
  onOpen?: () => void
}): JSX.Element {
  const running = task.status === 'running'
  const isSubagent = task.taskType === 'local_agent'

  const statusDot = running ? (
    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-info" aria-hidden="true" />
  ) : task.status === 'killed' || task.status === 'failed' ? (
    <IconClose className="h-3.5 w-3.5 shrink-0 text-faint" />
  ) : (
    <IconCheck className="h-3.5 w-3.5 shrink-0 text-ok" />
  )

  // The label: a subagent reads "Agent · <desc>" (echoes the inline Agent card); a bg
  // shell shows its command/description as before.
  const label = (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      {isSubagent && (
        <span className="shrink-0 font-mono text-[11px] font-semibold text-accent">Agent</span>
      )}
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-content" title={task.description}>
        {task.description}
      </span>
      {/* Open-transcript affordance — mirrors the inline Agent card's "→". */}
      {onOpen && <span className="shrink-0 font-mono text-[11px] text-faint">→</span>}
    </span>
  )

  const trailing = running ? (
    <>
      <BgTimer startMs={task.startMs} />
      {task.stopping ? (
        <span className="text-[11px] text-faint">stopping…</span>
      ) : (
        <button
          className="rounded p-0.5 text-faint opacity-0 transition-opacity hover:text-err focus-visible:opacity-100 group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation()
            onStop()
          }}
          title="Stop this task"
          aria-label={`Stop background ${isSubagent ? 'subagent' : 'task'}: ${task.description}`}
        >
          <IconClose className="h-3.5 w-3.5" />
        </button>
      )}
    </>
  ) : (
    <span className="text-[11px] text-faint">
      {task.status === 'killed' ? 'stopped' : task.status === 'failed' ? 'failed' : 'done'}
    </span>
  )

  // A subagent row is a button (opens its transcript); a bg-shell row is a plain div
  // (no transcript to open). Both keep the hover-revealed stop ✕ while running.
  if (onOpen) {
    return (
      <button
        className="group flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-bg-raised focus-visible:bg-bg-raised focus-visible:outline-none"
        onClick={onOpen}
        title="Open this subagent's transcript"
      >
        {statusDot}
        {label}
        {trailing}
      </button>
    )
  }
  return (
    <div className="group flex items-center gap-2.5 px-3 py-2">
      {statusDot}
      {label}
      {trailing}
    </div>
  )
}

function BgTimer({ startMs }: { startMs: number }): JSX.Element {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const s = Math.max(0, Math.floor((now - startMs) / 1000))
  const label = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return <span className="font-mono tabular-nums text-[11px] text-faint">{label}</span>
}
