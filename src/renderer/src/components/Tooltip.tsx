/**
 * Hover/focus tooltip wrapper. Opens after a delay on fine-pointer hover or on
 * keyboard focus, closes immediately (unmount, no exit animation). The delay is a
 * behavior constant, not motion, so reduced-motion doesn't disable it.
 */
import { cloneElement, useEffect, useId, useRef, useState, type ReactElement } from 'react'

export function Tooltip({
  content,
  align = 'center',
  openDelay = 550,
  describedBy = true,
  children
}: {
  content: string
  placement?: 'top'
  align?: 'center' | 'end'
  openDelay?: number
  describedBy?: boolean
  children: ReactElement
}): JSX.Element {
  const [open, setOpen] = useState(false)
  // Second flag so the bubble mounts at opacity-0 then transitions in (an element can't
  // transition from its own first paint without a reflow between the two states).
  const [shown, setShown] = useState(false)
  const id = useId()
  const timer = useRef<ReturnType<typeof setTimeout>>()

  const arm = (): void => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(true), openDelay)
  }
  const close = (): void => {
    clearTimeout(timer.current)
    setOpen(false)
  }

  useEffect(() => () => clearTimeout(timer.current), [])

  useEffect(() => {
    if (!open) {
      setShown(false)
      return
    }
    const raf = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(raf)
  }, [open])

  const trigger =
    describedBy && open
      ? cloneElement(children, { 'aria-describedby': id })
      : children

  // 'end' pins the bubble's right edge to the trigger (for a trigger at the window's
  // right edge, where centering would clip); 'center' anchors on the midpoint.
  const anchor = align === 'end' ? 'right-0' : 'left-1/2 -translate-x-1/2'

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => {
        if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) arm()
      }}
      onMouseLeave={close}
      onFocus={(e) => {
        if (e.target.matches(':focus-visible')) arm()
      }}
      onBlur={close}
      onKeyDown={(e) => {
        // Dismiss without blurring, and keep Escape from reaching any outer handler.
        if (e.key === 'Escape' && open) {
          e.stopPropagation()
          close()
        }
      }}
    >
      {trigger}
      {open && (
        <span
          role="tooltip"
          id={id}
          className={`pointer-events-none absolute bottom-full ${anchor} z-30 mb-2 w-max max-w-[260px] rounded-md border border-border bg-bg-elev px-2.5 py-1.5 text-xs text-content shadow-md transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none ${
            shown ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1'
          }`}
        >
          {content}
        </span>
      )}
    </span>
  )
}
