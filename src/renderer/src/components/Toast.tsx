import { forwardRef, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { flushSync } from 'react-dom'
import { create } from 'zustand'
import { occludeIfIntersects } from '../lib/nativeOcclusion'
import { IconClose } from './Icon'

/**
 * A stack card; ToastStack owns its positioning, stacking and hold. A delete-undo card has no ✕: waiting
 * is the commit and Undo the only action, so a ✕ would read as "cancel". Every card times itself and
 * calls its `onExpire` when the time runs out; the clock stops while the stack is held.
 */
export const Toast = forwardRef<HTMLDivElement, ToastCardProps>(function Toast(
  { toast, onAction, onDismiss, durationMs, held = false, exiting = false },
  ref
): JSX.Element {
  // Flip one frame after mount so the transition plays: enter for a live card, exit for one already leaving.
  const [flipped, setFlipped] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setFlipped(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const isMod = toast.kind === 'mod'
  // Time left survives a hold; a repeat (count bump) starts the full duration again. A resume never
  // gets less than MIN_RESUME_MS, so a card isn't gone before it's read again.
  const minMs = Math.min(MIN_RESUME_MS, durationMs)
  const left = useRef({ count: -1, ms: 0 })
  const [floored, setFloored] = useState<{ count: number; n: number } | null>(null)
  const count = toast.kind === 'mod' ? toast.count : 0
  const onExpireRef = useRef(toast.onExpire)
  onExpireRef.current = toast.onExpire
  useEffect(() => {
    if (exiting) return
    if (left.current.count !== count) left.current = { count, ms: durationMs }
    if (held) return
    if (left.current.ms < minMs) {
      left.current.ms = minMs
      setFloored((f) => ({ count, n: (f?.n ?? 0) + 1 }))
    }
    const start = Date.now()
    const t = setTimeout(() => onExpireRef.current(), left.current.ms)
    return () => {
      clearTimeout(t)
      left.current.ms -= Date.now() - start
    }
  }, [exiting, held, count, durationMs, minMs])
  const floor = floored?.count === count ? floored : null
  const labelId = useId()

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
          <span id={labelId} className="flex min-w-0 flex-1 items-baseline gap-1">
            <span className="min-w-0 truncate font-medium text-content">{toast.title}</span>
            {toast.suffix && <span className="shrink-0 text-dim">{toast.suffix}</span>}
          </span>
          <button
            id={`${labelId}-action`}
            aria-labelledby={`${labelId}-action ${labelId}`}
            className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-label font-semibold text-on-accent transition-colors hover:bg-accent-hover"
            onClick={onAction}
            tabIndex={exiting ? -1 : undefined}
          >
            {toast.actionLabel ?? 'Undo'}
          </button>
        </>
      )}
      {/* Neutral (not accent) countdown so the sole accent stays on Undo; hidden under reduced-motion
          where the drain keyframe would otherwise snap to empty and sit broken. Dropped on a leaving
          card so a re-mounted drain can't flash back to full behind the fade. A repeat remounts it
          (keyed by count) so it refills with the restarted timer; a floored resume remounts it at the
          floor's share of the bar. */}
      {!exiting && (
        <div
          key={floor ? `${count}:${floor.n}` : count}
          className="absolute bottom-0 left-0 h-0.5 w-full origin-left bg-dim motion-reduce:hidden"
          style={
            {
              animation: `toast-drain ${floor ? minMs : durationMs}ms linear forwards ${held ? 'paused' : 'running'}`,
              '--drain-from': floor ? minMs / durationMs : 1
            } as CSSProperties
          }
        />
      )}
    </div>
  )
})

interface ToastCardProps {
  toast: StackToast
  /** The undo card's Undo. */
  onAction?: () => void
  /** The plugin card's ✕. */
  onDismiss?: () => void
  durationMs: number
  /** Stops the clock and the drain. */
  held?: boolean
  /** True while the card is leaving; drives the exit transition and mutes interaction. */
  exiting?: boolean
}

/** `at` orders the stack; `onExpire` runs when the card's time runs out, and is the undo card's commit. */
export type StackToast = { at: number; onExpire: () => void } & (
  | {
      kind: 'undo'
      id: string
      /** Primary token, emphasized; truncates under width pressure so the recognizable name survives. */
      title: string
      /** Dim trailing verb naming what Undo reverses (e.g. "· deleted"); never truncates. */
      suffix?: string
      /** Replaces Undo when the action isn't a reversal. */
      actionLabel?: string
    }
  | { kind: 'mod'; id: string; plugin: string; text: string; count: number; durationMs: number }
)

export type UndoCard = Extract<StackToast, { kind: 'undo' }>

/** Undo cards from Settings' Browser pane, shown on the app's one stack (mounted by SessionsSidebar). The
 *  pane owns their commits; `onUndo` is its handler. */
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

/** The empty slot a card leaves while the stack is held, so nothing shifts under a second click. */
type Spacer = { kind: 'spacer'; id: string; at: number; height: number }

// EXIT_MS matches the card's exit CSS so the unmount waits out the fade; REFLOW_MS is the survivor glide.
const EXIT_MS = 150
const REFLOW_MS = 220
// RELEASE_MS outlasts a pointer crossing the gap between two cards.
const RELEASE_MS = 300
const MIN_RESUME_MS = 1000

/**
 * The one mount point for toasts, oldest on top, so an expiry only ever removes the top card and the
 * newest stays put above the dock. Survivors reflow with a native FLIP pass (transform only). A leaving
 * card moves to a separate fixed overlay pinned where it sat, so its slot closes at once and the
 * survivors' FLIP measures the closed layout. While the pointer or focus is on the stack, or the window
 * is hidden, the stack is held: no card's clock runs and a removed card leaves a spacer in its slot.
 */
export function ToastStack({
  items,
  durationMs,
  announce,
  onUndo,
  onDismiss
}: {
  /** Live toasts, in any order. */
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
  const prevTops = useRef<Map<string, { top: number; left: number; height: number }>>(new Map())
  const prevItems = useRef<StackToast[]>([])
  // The toast that currently holds focus.
  const focusedId = useRef<string | null>(null)
  const exitTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const [exiting, setExiting] = useState<ExitingToast[]>([])

  const [pointerIn, setPointerIn] = useState(false)
  const [focusIn, setFocusIn] = useState(false)
  const [hidden, setHidden] = useState(() => document.hidden)
  const held = pointerIn || focusIn || hidden

  useEffect(() => {
    const sync = (): void => setHidden(document.hidden)
    document.addEventListener('visibilitychange', sync)
    return () => document.removeEventListener('visibilitychange', sync)
  }, [])

  // Spacers are taken in the same render that drops the card, so the survivors never see the closed layout.
  const idKey = items.map((i) => i.id).join('\n')
  const [seen, setSeen] = useState({ key: idKey, items })
  const [spacers, setSpacers] = useState<Spacer[]>([])
  if (seen.key !== idKey) {
    setSeen({ key: idKey, items })
    const ids = new Set(items.map((i) => i.id))
    // A card never measured never took a slot, so it leaves no spacer.
    const gone = held ? seen.items.filter((i) => !ids.has(i.id) && !!prevTops.current.get(i.id)?.height) : []
    if (gone.length) setSpacers([...spacers, ...gone.map((i) => ({ kind: 'spacer' as const, id: i.id, at: i.at, height: prevTops.current.get(i.id)!.height }))])
  }
  if (!held && spacers.length) setSpacers([])
  const rows = [...items, ...spacers].sort((a, b) => a.at - b.at)

  const hasCards = items.length > 0 || exiting.length > 0
  const live = hasCards || spacers.length > 0

  // Hit-tested against the stack's box rather than its cards: a card removed under the pointer fires no
  // pointerout, and the box (spacers and gaps included) stays put until the pointer really leaves it.
  useEffect(() => {
    if (!live) return
    let inside = false
    let release: ReturnType<typeof setTimeout> | undefined
    const track = (now: boolean): void => {
      if (now) {
        clearTimeout(release)
        release = undefined
        // Synchronous, so the hold is in place before a click that lands right after entry. Else that
        // click's render still sees the stack unheld and the slot closes under the pointer.
        if (!inside) flushSync(() => setPointerIn(true))
        inside = true
      } else if (inside) {
        release ??= setTimeout(() => {
          release = undefined
          inside = false
          setPointerIn(false)
        }, RELEASE_MS)
      }
    }
    const move = (e: PointerEvent): void => {
      const r = containerRef.current?.getBoundingClientRect()
      track(!!r && e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom)
    }
    const out = (e: PointerEvent): void => {
      if (!e.relatedTarget) track(false)
    }
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerout', out)
    return () => {
      clearTimeout(release)
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerout', out)
      setPointerIn(false)
    }
  }, [live])

  // A shown manual popover lives in the top layer, where anchoring to the dock is always valid.
  useLayoutEffect(() => {
    const el = containerRef.current
    if (el && !el.matches(':popover-open')) el.showPopover()
  }, [])

  // The stack is always shown, but it only covers the page while it holds cards.
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
      // The newest survivor is the last card.
      if (
        removed.some((r) => r.id === focusedId.current) &&
        document.activeElement === document.body
      ) {
        const nextUndo = [...(containerRef.current?.querySelectorAll<HTMLElement>('[data-toast-id] button') ?? [])].at(-1)
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
    const tops = new Map<string, { top: number; left: number; height: number }>()
    for (const item of items) {
      const el = cardRefs.current.get(item.id)
      if (el) {
        const r = el.getBoundingClientRect()
        tops.set(item.id, { top: r.top, left: r.left, height: r.height })
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
  }, [items, spacers])

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
          // Only keyboard focus holds. A pointer Undo focuses its button and hands focus to the next card,
          // which would otherwise hold the stack until the user clicked somewhere else.
          setFocusIn(!!card && (e.target as HTMLElement).matches(':focus-visible'))
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setFocusIn(false)
        }}
        popover="manual"
        className="pop-base toast-stack pointer-events-none flex w-max flex-col items-center gap-2 outline-none"
      >
        <div aria-live="polite" className="sr-only">
          {announce}
        </div>
        {rows.map((t) =>
          t.kind === 'spacer' ? (
            <div key={`spacer:${t.id}`} aria-hidden="true" className="pointer-events-none shrink-0" style={{ height: t.height }} />
          ) : (
            <Toast
              key={t.id}
              ref={setCardRef(t.id)}
              toast={t}
              onAction={() => onUndo(t.id)}
              onDismiss={() => onDismiss?.(t.id)}
              durationMs={t.kind === 'mod' ? t.durationMs : durationMs}
              held={held}
            />
          )
        )}
      </div>
      {exiting.map((e) => (
        <div key={e.id} className="pointer-events-none fixed z-[60]" style={{ top: e.top, left: e.left }}>
          <Toast toast={e} durationMs={durationMs} exiting />
        </div>
      ))}
    </>
  )
}
