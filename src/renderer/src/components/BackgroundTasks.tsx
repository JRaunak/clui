/**
 * Background-task indicator for the bottom info bar (the active session's ambient
 * status strip). A backgrounded task keeps running after the turn's `result` fires,
 * so this is deliberately NOT in the composer (which is reserved for the
 * foreground turn's verb+timer footer). Blue (--color-info) reads as "ambient /
 * informational, no action needed", distinct from the amber foreground running.
 *
 * Clicking the chip opens a popover listing each task with its own elapsed timer
 * and a ✕ to stop it (tool-mediated TaskStop: costs a turn, shows a "stopping…"
 * state until the killed event lands).
 *
 * This tray also holds backgrounded SUBAGENTS (taskType 'local_agent'), not just
 * bg bash shells; the CLI announces both here. A subagent row additionally opens its
 * forwarded transcript (SubagentView, keyed by the row's toolUseId = the parent
 * tool_use id), matching the inline Agent card's "→" open-transcript affordance.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  useActive,
  useSession,
  subagentOwnerOfTask,
  type BackgroundTask,
  type NestedSubagent,
  type SubagentMessage
} from '../store'
import { useEscape } from '../lib/useEscape'
import { useClickOutside } from '../lib/useClickOutside'
import { IconClose, IconCheck } from './Icon'

const EMPTY: Record<string, BackgroundTask> = {}
const EMPTY_SUB_MSGS: Record<string, SubagentMessage[]> = {}
const EMPTY_SUB_CHILDREN: Record<string, NestedSubagent[]> = {}

const LINGER_MS = 15_000

export function BackgroundTasks(): JSX.Element | null {
  const tasks = useActive((s) => s?.backgroundTasks ?? EMPTY)
  const subMsgs = useActive((s) => s?.subagentMessages ?? EMPTY_SUB_MSGS)
  const subChildren = useActive((s) => s?.subagentChildren ?? EMPTY_SUB_CHILDREN)
  const handleId = useActive((s) => s?.handleId ?? null)
  const stopTask = useSession((s) => s.stopBackgroundTask)
  const viewSubagent = useSession((s) => s.viewSubagent)
  const clearCompleted = useSession((s) => s.clearCompletedBgWork)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const list = Object.values(tasks).sort((a, b) => a.startMs - b.startMs)
  const running = list.filter((t) => t.status === 'running')
  // Work the user's own turn started, split by kind. Anything a SUBAGENT started (a shell
  // it ran, or an agent it spawned) is not a peer of these: it nests under that agent, so
  // the tray shows who owns it. Only one level of indent, because the popover is 420px
  // wide and a deeper chain still reads as "owned by the agent above" without marching right.
  const ownerOf = (t: BackgroundTask): string | null =>
    subagentOwnerOfTask(t.toolUseId, subMsgs, subChildren)
  const agents = list.filter((t) => t.taskType === 'local_agent' && !ownerOf(t))
  const shells = list.filter((t) => t.taskType !== 'local_agent' && !ownerOf(t))
  const childrenOf = (agent: BackgroundTask): BackgroundTask[] =>
    agent.toolUseId ? list.filter((t) => ownerOf(t) === agent.toolUseId) : []
  // Only a subagent has a transcript to open; a bg shell has none.
  const openTranscript = (t: BackgroundTask): (() => void) | undefined =>
    t.taskType === 'local_agent' && t.toolUseId
      ? () => {
          setOpen(false)
          viewSubagent(t.toolUseId as string)
          // Opening a completed subagent = "seen" → stop lingering it.
          if (t.status !== 'running') clearCompleted('subagent')
        }
      : undefined
  // Lingering = terminal subagent rows kept clickable post-completion (see store).
  const lingering = list.filter((t) => t.taskType === 'local_agent' && t.status !== 'running')

  const dismiss = useCallback(() => setOpen(false), [])
  useClickOutside(ref, open, dismiss)
  // Esc returns focus to the trigger, since the focused row unmounts with the popover
  // and focus would otherwise fall to <body>. An OUTSIDE CLICK deliberately doesn't:
  // it would steal focus from whatever the user just clicked.
  useEscape(
    open,
    useCallback(() => {
      setOpen(false)
      triggerRef.current?.focus()
    }, [])
  )

  // LINGER grace timer: arm a ~15s one-shot to clear lingering completed subagents when
  // nothing is running. Timer in a ref (StrictMode-safe; the deferred-timer pattern used
  // elsewhere). A new running task re-arms on the next change. Opening the tray also
  // clears them (below), counting as "seen".
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
        ref={triggerRef}
        className="-my-1 flex items-center gap-1.5 rounded py-1 text-info transition-colors hover:brightness-110"
        onClick={() => setOpen((v) => !v)}
        title="Background tasks"
        aria-expanded={open}
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
            <span className="text-xs font-semibold text-content">Background tasks</span>
            {/* "done" is omitted when zero: bash rows are deleted on terminal and subagent
                rows linger only ~15s, so the count is almost always 0. */}
            <span className="ml-auto font-mono text-[11px] text-faint">
              {running.length} running
              {list.length - running.length > 0 ? ` · ${list.length - running.length} done` : ''}
            </span>
          </div>
          <div className="max-h-[40vh] overflow-y-auto py-1">
            {/* Each header depends only on its OWN section. Don't also condition it on the
                other kind: bash rows are deleted on terminal (see the store), so the last
                shell finishing drops both headers and shifts every surviving row up ~26px. */}
            {agents.length > 0 && (
              <>
                <SectionLabel>Agents</SectionLabel>
                {agents.map((t) => (
                  <div key={t.taskId}>
                    <Row
                      task={t}
                      onStop={() => handleId && void stopTask(handleId, t.taskId)}
                      onOpen={openTranscript(t)}
                    />
                    {/* Indentation is the only visual carrier of ownership and AT can't see it,
                        so the group names its owner too (WCAG 1.3.1). Without it a screen reader
                        hears a subagent's shell as a peer of the user's own tasks. */}
                    {childrenOf(t).length > 0 && (
                      <div role="group" aria-label={`Started by ${t.description}`}>
                        {/* A child agent keeps its open-transcript affordance; a child shell
                            has none, so `openTranscript` returns undefined for it. */}
                        {childrenOf(t).map((child) => (
                          <Row
                            key={child.taskId}
                            task={child}
                            nested
                            ownerDesc={t.description}
                            onStop={() => handleId && void stopTask(handleId, child.taskId)}
                            onOpen={openTranscript(child)}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </>
            )}
            {shells.length > 0 && (
              <>
                <SectionLabel>Shells</SectionLabel>
                {shells.map((t) => (
                  <Row
                    key={t.taskId}
                    task={t}
                    onStop={() => handleId && void stopTask(handleId, t.taskId)}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="px-3 pb-1 pt-2 font-mono text-[11px] uppercase tracking-[0.14em] text-faint">
      {children}
    </div>
  )
}

function Row({
  task,
  onStop,
  onOpen,
  nested,
  ownerDesc
}: {
  task: BackgroundTask
  onStop: () => void
  /** Present only for a backgrounded SUBAGENT row; opens its transcript. */
  onOpen?: () => void
  /** Work a subagent started (a shell it ran, or an agent it spawned): indented under it. */
  nested?: boolean
  /** The owning subagent's description, for a nested row's accessible names. */
  ownerDesc?: string
}): JSX.Element {
  const running = task.status === 'running'
  const isSubagent = task.taskType === 'local_agent'

  // Fixed width: the dot is 6px and the terminal icons 14px, so an auto-width slot shifts
  // every label 8px the moment a task finishes.
  const statusDot = (
    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
      {running ? (
        <span className="h-1.5 w-1.5 rounded-full bg-info" />
      ) : task.status === 'failed' ? (
        // `killed` was a requested stop, so only a real failure takes the err tone. The
        // trailing word states it too, so this isn't colour alone. The word stays `faint`:
        // err is 4.34:1 on the hover surface, which fails 4.5:1 as 11px text, while the
        // glyph only needs 3:1.
        <IconClose className="h-3.5 w-3.5 text-err" />
      ) : task.status === 'killed' ? (
        <IconClose className="h-3.5 w-3.5 text-faint" />
      ) : (
        <IconCheck className="h-3.5 w-3.5 text-ok" />
      )}
    </span>
  )

  // A subagent keeps its "Agent" label even when nested: it's the only at-rest cue separating
  // a nested AGENT (clickable, has a transcript) from a nested SHELL, since the `→` is one
  // 11px glyph and hover shows nothing until hovered. Nested spends `faint` rather than the
  // accent so a parent/child pair doesn't spend the scarce accent twice.
  const typeLabel = isSubagent && (
    <span
      className={`shrink-0 font-mono text-[11px] font-semibold ${nested ? 'text-faint' : 'text-accent'}`}
    >
      Agent
    </span>
  )
  const labelInner = (
    <>
      {typeLabel}
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-content" title={task.description}>
        {task.description}
      </span>
      {/* Open-transcript affordance, mirroring the inline Agent card's "→". Inside the button
          so clicking the glyph opens too, with pr-1.5 to clear the inset focus ring, which
          otherwise cuts through it at the flex-1 edge. */}
      {onOpen && <span className="shrink-0 pr-1.5 font-mono text-[11px] text-faint">→</span>}
    </>
  )

  const stopLabel = `Stop background ${isSubagent ? 'subagent' : 'task'}: ${task.description}${
    ownerDesc ? ` (started by ${ownerDesc})` : ''
  }`
  const trailing = running ? (
    <>
      <BgTimer startMs={task.startMs} />
      {task.stopping ? (
        <span className="text-[11px] text-faint">stopping…</span>
      ) : (
        <button
          // h-6 w-6 is the house pattern for a row's icon button (see the sidebar's close);
          // the 14px glyph alone is an 18px target, under the 24px floor.
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-faint opacity-0 transition-opacity hover:text-err focus-visible:opacity-100 focus-visible:outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-accent group-hover:opacity-100"
          onClick={onStop}
          title="Stop this task"
          aria-label={stopLabel}
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

  // min-h-10 holds the row at its running height: the trailing slot swaps a 24px stop button
  // for an ~17px status word, which otherwise shrinks the row 6px the moment a task finishes.
  const rowCls = `group flex min-h-10 items-center gap-2.5 py-1 pr-3 ${nested ? 'pl-6' : 'pl-3'}`
  // A subagent row opens its transcript; a bg-shell row has none. The BUTTON is the label
  // region, not the whole row: a row-level button would nest the stop ✕ inside it, which is
  // invalid HTML and AT may never expose the inner control. The ring is inset because the
  // global one's outline-offset sits outside the element, where the popover clips it.
  if (onOpen) {
    return (
      <div className={`${rowCls} hover:bg-bg-raised focus-within:bg-bg-raised`}>
        {statusDot}
        <button
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left focus-visible:outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-accent"
          onClick={onOpen}
          title="Open this subagent's transcript"
        >
          {labelInner}
        </button>
        {trailing}
      </div>
    )
  }
  return (
    <div className={rowCls}>
      {statusDot}
      <span className="flex min-w-0 flex-1 items-center gap-1.5">{labelInner}</span>
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
