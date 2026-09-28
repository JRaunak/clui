/**
 * Hover/focus tooltip. Opens after a delay on fine-pointer hover or on keyboard focus, closes
 * immediately. The delay is a behavior constant, not motion, so reduced motion keeps it.
 * The bubble is a manual top-layer popover: it escapes every clip, and unlike an auto popover it
 * never closes an open picker.
 */
import { cloneElement, useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactElement } from 'react'

export function Tooltip({
  content,
  align = 'center',
  openDelay = 550,
  describedBy = true,
  placement = 'top',
  children
}: {
  content: string
  placement?: 'top' | 'bottom'
  align?: 'center' | 'end'
  openDelay?: number
  describedBy?: boolean
  children: ReactElement
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const rawId = useId()
  const id = `tip${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`
  const anchor = `--${id}`
  const wrapRef = useRef<HTMLSpanElement>(null)
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

  const bubbleRef = useCallback((el: HTMLSpanElement | null) => {
    if (el && !el.matches(':popover-open')) el.showPopover()
  }, [])

  const trigger = describedBy && open ? cloneElement(children, { 'aria-describedby': id }) : children

  // A trigger inside the composer dock gets its bubble above the whole dock, never over the textarea.
  const inDock = open && !!wrapRef.current?.closest('[data-ui="composer-dock"]')
  const style = {
    positionAnchor: anchor,
    ...(placement === 'bottom'
      ? { top: 'calc(anchor(bottom) + 8px)' }
      : { bottom: inDock ? 'calc(anchor(--composer-dock top) + 8px)' : 'calc(anchor(top) + 8px)' }),
    ...(align === 'end' ? { right: 'anchor(right)' } : { left: 'anchor(center)', translate: '-50% 0' })
  } as CSSProperties

  return (
    <span
      ref={wrapRef}
      className="relative inline-flex"
      style={{ anchorName: anchor } as CSSProperties}
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
          ref={bubbleRef}
          popover="manual"
          role="tooltip"
          id={id}
          className="pop-base tip glass-thick w-max max-w-[260px] rounded-md px-2.5 py-1.5 text-xs text-content"
          style={style}
        >
          {content}
        </span>
      )}
    </span>
  )
}
