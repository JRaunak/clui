import { forwardRef, useEffect, useLayoutEffect, useRef, useState } from 'react'

/**
 * A delete-undo card; ToastStack owns its positioning and stacking.
 * No ✕: waiting is the commit and Undo the only action, so a ✕ would read as "cancel".
 */
export const Toast = forwardRef<HTMLDivElement, ToastCardProps>(function Toast(
  { title, suffix, actionLabel, onAction, durationMs, exiting = false, toastId },
  ref
): JSX.Element {
  // Flip one frame after mount so the transition plays: enter for a live card, exit for one already leaving.
  const [flipped, setFlipped] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setFlipped(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const motion = exiting
    ? flipped
      ? '-translate-y-1.5 opacity-0'
      : 'translate-y-0 opacity-100'
    : flipped
      ? 'translate-y-0 opacity-100'
      : '-translate-y-2 opacity-0'

  return (
    <div
      ref={ref}
      data-toast-id={toastId}
      className={`relative inline-flex min-w-[min(300px,calc(100vw-2rem))] max-w-[min(360px,calc(100vw-2rem))] items-center gap-3 overflow-hidden rounded-lg border border-border bg-bg-raised px-3.5 py-1 text-xs shadow-md transition-[translate,opacity] ${
        exiting
          ? 'pointer-events-none duration-[180ms] ease-in'
          : 'pointer-events-auto duration-200 ease-out'
      } ${motion}`}
    >
      <span className="flex min-w-0 flex-1 items-baseline gap-1">
        <span className="min-w-0 truncate font-medium text-content">{title}</span>
        {suffix && <span className="shrink-0 text-dim">{suffix}</span>}
      </span>
      <button
        className="shrink-0 rounded px-2 py-1.5 font-semibold text-accent transition-colors hover:text-accent-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        onClick={onAction}
        tabIndex={exiting ? -1 : undefined}
      >
        {actionLabel}
      </button>
      {/* Neutral (not accent) countdown so the sole accent stays on Undo; hidden under reduced-motion
          where the drain keyframe would otherwise snap to empty and sit broken. Dropped on a leaving
          card so a re-mounted drain can't flash back to full behind the fade. */}
      {!exiting && (
        <div
          className="absolute bottom-0 left-0 h-px bg-content/20 motion-reduce:hidden"
          style={{ animation: `toast-drain ${durationMs}ms linear forwards` }}
        />
      )}
    </div>
  )
})

interface ToastCardProps {
  /** Primary token, emphasized; truncates under width pressure so the recognizable name survives. */
  title: string
  /** Dim trailing verb naming what Undo reverses (e.g. "· deleted"); never truncates. */
  suffix?: string
  actionLabel: string
  onAction: () => void
  durationMs: number
  /** True while the card is leaving; drives the exit transition and mutes interaction. */
  exiting?: boolean
  /** Mirrored to `data-toast-id` so the stack can locate a card for focus routing. */
  toastId?: string
}

export interface StackToast {
  id: string
  title: string
  suffix?: string
}

interface ExitingToast extends StackToast {
  /** Viewport top of the slot the card occupied when it left the stack; pins the Layer-B overlay. */
  top: number
}

// EXIT_MS matches the card's exit CSS so the unmount waits out the fade; REFLOW_MS is the survivor glide.
const EXIT_MS = 180
const REFLOW_MS = 220

/**
 * The one mount point for delete-undo toasts, newest on top. Survivors reflow with a native FLIP pass
 * (transform only). A leaving card moves to a separate fixed overlay pinned where it sat, so its slot
 * closes at once and the survivors' FLIP measures the closed layout.
 */
export function ToastStack({
  items,
  durationMs,
  announce,
  onUndo
}: {
  /** Live (undoable) toasts, newest first. */
  items: StackToast[]
  durationMs: number
  /** sr-only text for the latest delete; coalesces rapid deletes to the most recent. */
  announce: string
  onUndo: (id: string) => void
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map())
  const prevTops = useRef<Map<string, number>>(new Map())
  const prevItems = useRef<StackToast[]>([])
  // The toast that currently holds focus.
  const focusedId = useRef<string | null>(null)
  const exitTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const [exiting, setExiting] = useState<ExitingToast[]>([])

  useLayoutEffect(() => {
    const curIds = new Set(items.map((i) => i.id))
    const removed = prevItems.current.filter((i) => !curIds.has(i.id))

    if (removed.length) {
      // Move each leaver to Layer B and time its unmount.
      setExiting((ex) => {
        const add = removed
          .filter((r) => !ex.some((e) => e.id === r.id))
          .map((r) => ({ ...r, top: prevTops.current.get(r.id) ?? 0 }))
        return add.length ? [...ex, ...add] : ex
      })
      for (const r of removed) {
        if (exitTimers.current.has(r.id)) continue
        const t = setTimeout(() => {
          exitTimers.current.delete(r.id)
          setExiting((ex) => ex.filter((e) => e.id !== r.id))
        }, EXIT_MS)
        exitTimers.current.set(r.id, t)
      }
      // Hand focus on only if the leaving toast held it: focusedId marks the last-focused toast, and focus
      // orphans to <body> only when its node unmounts. Else it stays on the row the delete came from.
      if (
        removed.some((r) => r.id === focusedId.current) &&
        document.activeElement === document.body
      ) {
        const nextUndo = containerRef.current?.querySelector<HTMLElement>('[data-toast-id] button')
        if (nextUndo) nextUndo.focus()
        else containerRef.current?.focus()
        focusedId.current = null
      }
    }

    // Clear in-flight glides on measured cards so getBoundingClientRect reads the true flow position,
    // not a mid-glide transform. A new card isn't measured yet, so its class enter is left alone.
    for (const item of items) {
      const el = cardRefs.current.get(item.id)
      if (el && prevTops.current.has(item.id)) {
        el.style.transition = 'none'
        el.style.transform = ''
      }
    }

    // Measure the settled positions.
    const tops = new Map<string, number>()
    for (const item of items) {
      const el = cardRefs.current.get(item.id)
      if (el) tops.set(item.id, el.getBoundingClientRect().top)
    }

    // Invert each moved survivor to its old top, then play to zero next frame. Never cancel the play rAF:
    // a cancel (e.g. from the next delete) strands the card mid-invert. New/unmoved cards use their class transition.
    for (const item of items) {
      const el = cardRefs.current.get(item.id)
      if (!el) continue
      const oldTop = prevTops.current.get(item.id)
      if (oldTop == null) continue
      const newTop = tops.get(item.id)!
      if (oldTop === newTop) {
        el.style.transition = ''
        continue
      }
      el.style.transform = `translateY(${oldTop - newTop}px)`
      requestAnimationFrame(() => {
        el.style.transition = `transform ${REFLOW_MS}ms cubic-bezier(0.2,0,0,1)`
        el.style.transform = 'translateY(0)'
      })
    }

    prevTops.current = tops
    prevItems.current = items
  }, [items])

  useEffect(
    () => () => {
      exitTimers.current.forEach(clearTimeout)
      exitTimers.current.clear()
    },
    []
  )

  const setCardRef = (id: string) => (el: HTMLElement | null) => {
    if (el) cardRefs.current.set(id, el)
    else cardRefs.current.delete(id)
  }

  return (
    <>
      <div
        ref={containerRef}
        role="group"
        aria-label="Recently deleted sessions"
        tabIndex={-1}
        onFocus={(e) => {
          const card = (e.target as HTMLElement).closest('[data-toast-id]')
          if (card) focusedId.current = card.getAttribute('data-toast-id')
        }}
        className="pointer-events-none fixed inset-x-0 top-5 z-[60] flex flex-col items-center gap-2 px-4 outline-none"
      >
        <div aria-live="polite" className="sr-only">
          {announce}
        </div>
        {items.map((t) => (
          <Toast
            key={t.id}
            ref={setCardRef(t.id)}
            toastId={t.id}
            title={t.title}
            suffix={t.suffix}
            actionLabel="Undo"
            onAction={() => onUndo(t.id)}
            durationMs={durationMs}
          />
        ))}
      </div>
      {exiting.map((e) => (
        <div
          key={e.id}
          className="pointer-events-none fixed inset-x-0 z-[60] flex justify-center px-4"
          style={{ top: e.top }}
        >
          <Toast
            title={e.title}
            suffix={e.suffix}
            actionLabel="Undo"
            onAction={() => {}}
            durationMs={durationMs}
            exiting
          />
        </div>
      ))}
    </>
  )
}
