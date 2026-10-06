import { forwardRef, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { occludeIfIntersects } from '../lib/browserOcclusion'
import { IconClose } from './Icon'

/**
 * A stack card; ToastStack owns its positioning and stacking. A delete-undo card has no ✕: waiting
 * is the commit and Undo the only action, so a ✕ would read as "cancel". A plugin card has a ✕ and
 * times itself, pausing while the pointer or focus is on it or the window is hidden.
 */
export const Toast = forwardRef<HTMLDivElement, ToastCardProps>(function Toast(
  { toast, onAction, onDismiss, durationMs, exiting = false },
  ref
): JSX.Element {
  // Flip one frame after mount so the transition plays: enter for a live card, exit for one already leaving.
  const [flipped, setFlipped] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setFlipped(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const isMod = toast.kind === 'mod'
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [hidden, setHidden] = useState(() => document.hidden)
  useEffect(() => {
    if (!isMod) return
    const sync = (): void => setHidden(document.hidden)
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [isMod])
  const paused = hovered || focused || hidden
  // Time left survives a pause; a repeat (count bump) starts the full duration again.
  const left = useRef({ count: 0, ms: 0 })
  const count = toast.kind === 'mod' ? toast.count : 0
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  useEffect(() => {
    if (!isMod || exiting) return
    if (left.current.count !== count) left.current = { count, ms: durationMs }
    if (paused) return
    const start = Date.now()
    const t = setTimeout(() => onDismissRef.current?.(), left.current.ms)
    return () => {
      clearTimeout(t)
      left.current.ms -= Date.now() - start
    }
  }, [isMod, exiting, paused, count, durationMs])

  const motion = exiting
    ? flipped
      ? 'translate-y-1.5 opacity-0'
      : 'translate-y-0 opacity-100'
    : flipped
      ? 'translate-y-0 opacity-100'
      : 'translate-y-2 opacity-0'

  return (
    <div
      ref={ref}
      data-toast-id={exiting ? undefined : toast.id}
      data-ui="toast"
      data-kind={toast.kind}
      onPointerEnter={isMod ? () => setHovered(true) : undefined}
      onPointerLeave={isMod ? () => setHovered(false) : undefined}
      onFocus={isMod ? () => setFocused(true) : undefined}
      onBlur={
        isMod
          ? (e) => {
              if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false)
            }
          : undefined
      }
      className={`relative inline-flex w-[min(360px,calc(100vw-2rem))] overflow-hidden glass-thick rounded-lg px-3.5 text-xs transition-[translate,opacity] ${
        isMod ? 'flex-col items-start gap-0.5 py-2' : 'items-center gap-3 py-1.5'
      } ${exiting ? 'pointer-events-none duration-fast ease-in' : 'pointer-events-auto duration-base ease-out'} ${motion}`}
    >
      {toast.kind === 'mod' ? (
        <>
          <div className="flex w-full items-center gap-1.5 text-meta text-dim">
            <span className="min-w-0 flex-1 truncate">
              <span className="font-mono">{toast.plugin}</span> plugin
            </span>
            {toast.count > 1 && (
              <span className="shrink-0 tabular-nums text-faint">
                <span aria-hidden="true">×{toast.count}</span>
                <span className="sr-only">{toast.count} times</span>
              </span>
            )}
            <button
              type="button"
              aria-label="Dismiss"
              onClick={onDismiss}
              tabIndex={exiting ? -1 : undefined}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dim transition-colors hover:bg-bg-raised hover:text-content"
            >
              <IconClose className="h-3.5 w-3.5" />
            </button>
          </div>
          <p className="line-clamp-4 whitespace-pre-wrap break-words text-xs text-content" title={toast.text.slice(0, 1000)}>
            {toast.text}
          </p>
        </>
      ) : (
        <>
          <span className="flex min-w-0 flex-1 items-baseline gap-1">
            <span className="min-w-0 truncate font-medium text-content">{toast.title}</span>
            {toast.suffix && <span className="shrink-0 text-dim">{toast.suffix}</span>}
          </span>
          <button
            className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-label font-semibold text-on-accent transition-colors hover:bg-accent-hover"
            onClick={onAction}
            tabIndex={exiting ? -1 : undefined}
          >
            Undo
          </button>
        </>
      )}
      {/* Neutral (not accent) countdown so the sole accent stays on Undo; hidden under reduced-motion
          where the drain keyframe would otherwise snap to empty and sit broken. Dropped on a leaving
          card so a re-mounted drain can't flash back to full behind the fade. A repeat remounts it
          (keyed by count) so it refills with the restarted timer. */}
      {!exiting && (
        <div
          key={count}
          className="absolute bottom-0 left-0 h-0.5 w-full origin-left bg-dim motion-reduce:hidden"
          style={{ animation: `toast-drain ${durationMs}ms linear forwards ${isMod && paused ? 'paused' : 'running'}` }}
        />
      )}
    </div>
  )
})

interface ToastCardProps {
  toast: StackToast
  /** The undo card's Undo. */
  onAction?: () => void
  /** The plugin card's ✕ and its own timeout. */
  onDismiss?: () => void
  durationMs: number
  /** True while the card is leaving; drives the exit transition and mutes interaction. */
  exiting?: boolean
}

export type StackToast =
  | {
      kind: 'undo'
      id: string
      /** Primary token, emphasized; truncates under width pressure so the recognizable name survives. */
      title: string
      /** Dim trailing verb naming what Undo reverses (e.g. "· deleted"); never truncates. */
      suffix?: string
    }
  | { kind: 'mod'; id: string; plugin: string; text: string; count: number; durationMs: number }

export type UndoCard = Extract<StackToast, { kind: 'undo' }> & { at: number }

/** Undo cards from Settings' Browser pane, shown on the app's one stack (mounted by SessionsSidebar). The
 *  pane owns their timers and commits; `onUndo` is its handler. */
export const useBrowserToasts = create<{ items: UndoCard[]; announce: { text: string; at: number }; onUndo: (id: string) => void }>(() => ({
  items: [],
  announce: { text: '', at: 0 },
  onUndo: () => {}
}))

type ExitingToast = StackToast & {
  /** Viewport top of the slot the card occupied when it left the stack; pins the Layer-B overlay. */
  top: number
  left: number
}

// EXIT_MS matches the card's exit CSS so the unmount waits out the fade; REFLOW_MS is the survivor glide.
const EXIT_MS = 150
const REFLOW_MS = 220

/**
 * The one mount point for toasts, newest on top. Survivors reflow with a native FLIP pass
 * (transform only). A leaving card moves to a separate fixed overlay pinned where it sat, so its slot
 * closes at once and the survivors' FLIP measures the closed layout.
 */
export function ToastStack({
  items,
  durationMs,
  announce,
  onUndo,
  onDismiss
}: {
  /** Live toasts, newest first. */
  items: StackToast[]
  /** The undo window; a plugin card carries its own. */
  durationMs: number
  /** sr-only text for the latest card; coalesces rapid ones to the most recent. */
  announce: string
  onUndo: (id: string) => void
  onDismiss?: (id: string) => void
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map())
  const prevTops = useRef<Map<string, { top: number; left: number }>>(new Map())
  const prevItems = useRef<StackToast[]>([])
  // The toast that currently holds focus.
  const focusedId = useRef<string | null>(null)
  const exitTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const [exiting, setExiting] = useState<ExitingToast[]>([])

  // A shown manual popover lives in the top layer, where anchoring to the dock is always valid.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (el && !el.matches(':popover-open')) el.showPopover()
  }, [])

  // The stack is always shown, but it only covers the page while it holds cards.
  const hasCards = items.length > 0 || exiting.length > 0
  useLayoutEffect(() => (hasCards ? (occludeIfIntersects(containerRef.current) ?? undefined) : undefined), [hasCards])

  useLayoutEffect(() => {
    const curIds = new Set(items.map((i) => i.id))
    const removed = prevItems.current.filter((i) => !curIds.has(i.id))

    if (removed.length) {
      // Move each leaver to Layer B and time its unmount.
      setExiting((ex) => {
        const add = removed
          .filter((r) => !ex.some((e) => e.id === r.id))
          .map((r) => ({ ...r, top: prevTops.current.get(r.id)?.top ?? 0, left: prevTops.current.get(r.id)?.left ?? 0 }))
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
    const tops = new Map<string, { top: number; left: number }>()
    for (const item of items) {
      const el = cardRefs.current.get(item.id)
      if (el) {
        const r = el.getBoundingClientRect()
        tops.set(item.id, { top: r.top, left: r.left })
      }
    }

    // Invert each moved survivor to its old top, then play to zero next frame. Never cancel the play rAF:
    // a cancel (e.g. from the next delete) strands the card mid-invert. New/unmoved cards use their class transition.
    for (const item of items) {
      const el = cardRefs.current.get(item.id)
      if (!el) continue
      const oldTop = prevTops.current.get(item.id)?.top
      if (oldTop == null) continue
      const newTop = tops.get(item.id)!.top
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
        aria-label="Notifications"
        tabIndex={-1}
        onFocus={(e) => {
          const card = (e.target as HTMLElement).closest('[data-toast-id]')
          if (card) focusedId.current = card.getAttribute('data-toast-id')
        }}
        popover="manual"
        className="pop-base toast-stack pointer-events-none flex w-max flex-col items-center gap-2 outline-none"
      >
        <div aria-live="polite" className="sr-only">
          {announce}
        </div>
        {items.map((t) => (
          <Toast
            key={t.id}
            ref={setCardRef(t.id)}
            toast={t}
            onAction={() => onUndo(t.id)}
            onDismiss={() => onDismiss?.(t.id)}
            durationMs={t.kind === 'mod' ? t.durationMs : durationMs}
          />
        ))}
      </div>
      {exiting.map((e) => (
        <div key={e.id} className="pointer-events-none fixed z-[60]" style={{ top: e.top, left: e.left }}>
          <Toast toast={e} durationMs={durationMs} exiting />
        </div>
      ))}
    </>
  )
}
