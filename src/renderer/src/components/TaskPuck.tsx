/**
 * Floating task-list puck + pinnable checklist over the transcript. No accent here by
 * design: status reads by SHAPE (check / ring / circle / lock), never color alone.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { SessionTask } from '../../../shared/events'
import { IconCheck, IconHalfRing, IconCircle, IconLock, IconPin } from './Icon'
import { useEscape } from '../lib/useEscape'
import { useClickOutside } from '../lib/useClickOutside'

/** Above this many tasks a segmented bar reads as a pinstripe, so switch to a
 *  single continuous ratio fill. */
const SEGMENTED_MAX = 15

/** Idle+all-done linger before the puck hides, so the "N/N done" finish is seen (mirrors
 *  the bg-tray's LINGER_MS). A new task re-arms it. */
const LINGER_MS = 15_000

/**
 * Show while the list is non-empty and (busy or any task unfinished); when idle and all
 * done, linger ~15s then hide. The `!busy` gate is load-bearing: task creation is
 * interleaved, so a batch can be all-done before the next is created, and hiding on that
 * would blank the puck mid-turn.
 */
export function useTaskUiActive(tasks: SessionTask[], busy: boolean): boolean {
  const total = tasks.length
  const allDone = total > 0 && tasks.every((t) => t.status === 'completed')

  // Sticky-on, delayed-off: gating through a separate "lingering" flag left a one-commit
  // gap at busy→idle where both flags were false and the puck flickered.
  const [show, setShow] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const clear = (): void => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
    if (total === 0) {
      clear()
      setShow(false)
    } else if (busy || !allDone) {
      // Working, or unfinished work exists: show now, cancel any pending hide.
      clear()
      setShow(true)
    } else {
      // Idle + everything done: keep it up (no gap), then hide after the grace period.
      // A new/unfinished task re-runs this effect and cancels the timer via the branch above.
      setShow(true)
      clear()
      timerRef.current = setTimeout(() => setShow(false), LINGER_MS)
    }
    return clear
  }, [total, busy, allDone])

  return show
}

/** Exit-animation duration; the panel stays mounted this long after `open` flips false
 *  so the collapse tween can play (transform/opacity only). */
const COLLAPSE_MS = 130

type Tone = 'ok' | 'content' | 'dim' | 'faint'
const TONE_CLASS: Record<Tone, string> = {
  ok: 'text-ok',
  content: 'text-content',
  dim: 'text-dim',
  faint: 'text-faint'
}

/** True when a not-yet-done task is gated by an unfinished dependency. */
function isBlocked(t: SessionTask): boolean {
  return (t.blockedBy?.length ?? 0) > 0 && t.status !== 'completed' && t.status !== 'in_progress'
}

interface RowVisual {
  Icon: (p: { className?: string }) => JSX.Element
  glyph: Tone
  text: Tone
  word: string
}
function rowVisual(t: SessionTask): RowVisual {
  if (t.status === 'completed') return { Icon: IconCheck, glyph: 'ok', text: 'faint', word: 'done' }
  if (t.status === 'in_progress') return { Icon: IconHalfRing, glyph: 'content', text: 'content', word: 'in progress' }
  if (isBlocked(t)) return { Icon: IconLock, glyph: 'faint', text: 'faint', word: 'blocked' }
  return { Icon: IconCircle, glyph: 'dim', text: 'dim', word: 'to do' }
}

/** Progress ring mirroring ContextRing. Fill arc = --color-dim, not border-strong, which
 *  fails 3:1. Size is parametric so the 24px puck ring clears the h-8 pill without bleeding. */
function TaskRing({ done, total, size = 30, stroke = 3 }: { done: number; total: number; size?: number; stroke?: number }): JSX.Element {
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const dash = (total > 0 ? done / total : 0) * circ
  const c = size / 2
  return (
    <svg width={size} height={size} className="-rotate-90 shrink-0" aria-hidden="true">
      <circle cx={c} cy={c} r={r} fill="none" stroke="var(--color-border)" strokeWidth={stroke} />
      <circle
        cx={c}
        cy={c}
        r={r}
        fill="none"
        stroke="var(--color-dim)"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${circ}`}
        style={{ transition: 'stroke-dasharray 0.4s var(--ease-out)' }}
      />
    </svg>
  )
}

/** Segmented (≤15 tasks) or continuous (>15) progress bar. done=teal,
 *  in_progress=content, pending/blocked=border track. */
function ProgressBar({ tasks, done }: { tasks: SessionTask[]; done: number }): JSX.Element {
  const total = tasks.length
  if (total > SEGMENTED_MAX) {
    const pct = total > 0 ? (done / total) * 100 : 0
    return (
      <div className="h-1 w-full overflow-hidden rounded-full bg-border" aria-hidden="true">
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: 'var(--color-ok)', transition: 'width 0.4s var(--ease-out)' }}
        />
      </div>
    )
  }
  return (
    <div className="flex w-full gap-0.5" aria-hidden="true">
      {tasks.map((t) => {
        const bg =
          t.status === 'completed'
            ? 'var(--color-ok)'
            : t.status === 'in_progress'
              ? 'var(--color-content)'
              : 'var(--color-border)'
        return <span key={t.id} className="h-1 flex-1 rounded-full" style={{ background: bg }} />
      })}
    </div>
  )
}

export function TaskPuck({
  tasks,
  atBottom,
  open,
  pinned,
  onOpenChange,
  onPinnedChange,
  reduce
}: {
  tasks: SessionTask[]
  atBottom: boolean
  open: boolean
  pinned: boolean
  onOpenChange: (open: boolean) => void
  onPinnedChange: (pinned: boolean) => void
  reduce: boolean
}): JSX.Element | null {
  const done = tasks.filter((t) => t.status === 'completed').length
  const total = tasks.length
  const inProgress = tasks.filter((t) => t.status === 'in_progress')
  const activeTask = inProgress[0] ?? null
  const activeId = activeTask?.id ?? null
  const subjectById = new Map(tasks.map((t) => [t.id, t.subject]))

  // Keep the panel mounted through its collapse tween. `shown` drives the enter/exit
  // transform+opacity; `mounted` gates the DOM presence.
  const [mounted, setMounted] = useState(open)
  const [shown, setShown] = useState(open)
  useEffect(() => {
    if (open) {
      setMounted(true)
      const raf = requestAnimationFrame(() => setShown(true))
      return () => cancelAnimationFrame(raf)
    }
    setShown(false)
    const t = setTimeout(() => setMounted(false), COLLAPSE_MS)
    return () => clearTimeout(t)
  }, [open])

  const wrapRef = useRef<HTMLDivElement>(null)
  const puckRef = useRef<HTMLButtonElement>(null)
  const bodyRef = useRef<HTMLUListElement>(null)
  const wantPuckFocus = useRef(false)
  const prevOpen = useRef(false)

  // Unpinned only: click-outside dismisses (no focus steal), Esc dismisses + returns
  // focus to the puck. Pinned stays open through both.
  useClickOutside(wrapRef, open && !pinned, () => onOpenChange(false))
  useEscape(open && !pinned, () => {
    wantPuckFocus.current = true
    onOpenChange(false)
  })

  // Return focus to the puck after an Esc dismiss (the focused panel unmounts, so focus
  // would otherwise fall to <body>). The puck is present whenever atBottom.
  useEffect(() => {
    if (!open && atBottom && wantPuckFocus.current) {
      wantPuckFocus.current = false
      puckRef.current?.focus()
    }
  }, [open, atBottom])

  // Center the in_progress row on open (auto) and on active-task change (smooth); no
  // in_progress → scroll to top. reduced-motion forces 'auto'.
  useEffect(() => {
    if (!open) {
      prevOpen.current = false
      return
    }
    const justOpened = !prevOpen.current
    prevOpen.current = true
    const behavior: ScrollBehavior = reduce || justOpened ? 'auto' : 'smooth'
    const el = bodyRef.current?.querySelector('[data-active-task="true"]')
    if (el) el.scrollIntoView({ block: 'center', behavior })
    else bodyRef.current?.scrollTo({ top: 0, behavior })
  }, [open, activeId, reduce])

  const puckLabel = `Task progress: ${done} of ${total} done${
    inProgress.length ? `, ${inProgress.length} in progress` : ''
  }. Show checklist.`

  const panelStyle: CSSProperties = {
    // vw/vh, not %: the content-sized anchor gives a percentage no basis.
    width: 'min(380px, calc(100vw - 3rem))',
    maxHeight: 'min(60vh, 34rem)',
    transformOrigin: 'bottom right',
    transform: shown ? 'scale(1)' : 'scale(0.96)',
    opacity: shown ? 1 : 0,
    transition: `transform ${shown ? 180 : COLLAPSE_MS}ms var(--ease-out), opacity ${
      shown ? 180 : COLLAPSE_MS
    }ms var(--ease-out)`
  }

  return (
    // The anchor holds the puck's position so the panel can float above it via bottom-full
    // even while the puck itself is hidden (pinned + scrolled up). Lifts above the composer dock.
    <div
      ref={wrapRef}
      className="absolute right-5 z-20"
      style={{ bottom: 'calc(1rem + var(--dock-h, 0px))' }}
    >
      {mounted && (
        <div
          role="region"
          aria-label="Session tasks"
          className="absolute bottom-full right-0 z-30 mb-1.5 flex flex-col overflow-hidden rounded-xl border border-border-strong bg-bg-elev shadow-lg"
          style={panelStyle}
        >
          <div className="flex shrink-0 items-center gap-2.5 px-3 pb-2 pt-2.5">
            <TaskRing done={done} total={total} />
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="font-mono text-xs tabular-nums text-content">
                Tasks · {done}/{total}
              </span>
              {activeTask && (
                <span className="truncate text-[13px] text-content" title={activeTask.activeForm || activeTask.subject}>
                  {activeTask.activeForm || activeTask.subject}
                </span>
              )}
            </div>
            <button
              type="button"
              aria-pressed={pinned}
              aria-label={pinned ? 'Unpin task checklist' : 'Pin task checklist open'}
              title={pinned ? 'Unpin' : 'Pin open'}
              onClick={() => onPinnedChange(!pinned)}
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors focus-visible:outline-none focus-visible:inset-ring-2 focus-visible:inset-ring-accent ${
                pinned ? 'text-content' : 'text-faint hover:text-content'
              }`}
            >
              <IconPin className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="shrink-0 px-3 pb-2">
            <ProgressBar tasks={tasks} done={done} />
          </div>
          <ul role="list" className="min-h-0 overflow-y-auto px-1.5 pb-2" ref={bodyRef}>
            {tasks.map((t) => {
              const v = rowVisual(t)
              const blocked = isBlocked(t)
              const blockers = blocked
                ? (t.blockedBy ?? []).map((id) => subjectById.get(id)).filter(Boolean).join(', ')
                : ''
              const name = `${t.subject}, ${v.word}${blocked && blockers ? `, blocked by ${blockers}` : ''}`
              return (
                <li
                  key={t.id}
                  role="listitem"
                  aria-label={name}
                  data-active-task={t.status === 'in_progress' ? 'true' : undefined}
                  className="flex items-start gap-2.5 rounded-md px-1.5 py-1.5"
                >
                  <v.Icon className={`mt-px h-4 w-4 shrink-0 ${TONE_CLASS[v.glyph]}`} />
                  <span className="min-w-0 flex-1">
                    <span className={`block text-[13px] leading-snug ${TONE_CLASS[v.text]}`}>{t.subject}</span>
                    {blocked && blockers && (
                      <span className="mt-0.5 block text-[11px] leading-tight text-faint">blocked by: {blockers}</span>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* The puck is the toggle anchor: present whenever at bottom, hidden when scrolled
          up (JumpToLatest takes over), even if the panel stays pinned-open above. */}
      {atBottom && (
        <button
          ref={puckRef}
          type="button"
          aria-expanded={open}
          aria-label={puckLabel}
          onClick={() => onOpenChange(!open)}
          // pl-[3px]: puts the 24px ring's center on the h-8 pill's left-cap center (both
          // 16px in), so the two arcs nest concentrically instead of the ring drifting right.
          className="flex h-8 items-center gap-2 rounded-full border border-border-strong bg-bg-elev pl-[3px] pr-3 text-dim shadow-md transition-colors hover:text-content focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <TaskRing done={done} total={total} size={24} stroke={2.5} />
          <span className="font-mono text-xs tabular-nums">
            <span className="text-content">{done}</span>
            <span className="text-dim">/{total}</span>
          </span>
        </button>
      )}
    </div>
  )
}
