/**
 * Top-layer popover primitive: `popover="auto"` for light dismiss and nesting, CSS anchor
 * positioning to the trigger, and the `.pop` enter/exit in styles.css.
 *
 * Esc goes through useEscape (the app's one LIFO stack). Its preventDefault also cancels the
 * browser's own popover close request, so Esc never closes two layers. Outside clicks are the
 * browser's light dismiss, which leaves focus wherever the click put it; only an explicit
 * close() returns focus to the trigger.
 */
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { useEscape } from '../lib/useEscape'
import { viaOf, type Via } from '../lib/motion'
import { occludeIfIntersects } from '../lib/browserOcclusion'

export type PopoverPlacement = 'up' | 'down'
export type PopoverAlign = 'start' | 'end'

const AREA: Record<PopoverPlacement, Record<PopoverAlign, string>> = {
  up: { start: 'top span-right', end: 'top span-left' },
  down: { start: 'bottom span-right', end: 'bottom span-left' }
}

export function usePopover<T extends HTMLElement = HTMLButtonElement>({
  placement = 'down',
  align = 'start',
  solid = false,
  above,
  maxHeight,
  onOpenChange
}: {
  placement?: PopoverPlacement
  align?: PopoverAlign
  /** Force the opaque form of the glass, for a menu that would otherwise stack on another glass panel. */
  solid?: boolean
  /** Clear this anchor's top edge instead of the trigger's, so a chip inside the dock opens above the whole dock. */
  above?: string
  /** The menu's max height. Above the dock it's enforced through the top inset, so a tall dock (a
   *  Gate open) shrinks the menu to the space left instead of pushing it off screen. */
  maxHeight?: string
  onOpenChange?: (open: boolean) => void
} = {}) {
  const id = `pop${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const anchor = `--${id}`
  const triggerRef = useRef<T>(null)
  const popRef = useRef<HTMLDivElement | null>(null)
  // State-backed, so the listeners attach when the panel mounts after the hook (a tray that renders
  // nothing until it has tasks) and detach when it leaves.
  const [popEl, setPopEl] = useState<HTMLDivElement | null>(null)
  const setPop = useCallback((el: HTMLDivElement | null) => {
    popRef.current = el
    setPopEl(el)
  }, [])
  const [open, setOpen] = useState(false)
  const via = useRef<Via>('pointer')
  const onOpenChangeRef = useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange

  useEffect(() => {
    const el = popEl
    // Removing an open popover fires no toggle event, so drop `open` here; that also removes its Esc entry.
    if (!el) {
      setOpen(false)
      return
    }
    const onBefore = (e: Event): void => {
      el.dataset.via = via.current
      if ((e as ToggleEvent).newState !== 'open') return
      // Scale from the trigger's center, whichever edge the popover is aligned to.
      const w = triggerRef.current?.getBoundingClientRect().width ?? 0
      el.style.setProperty('--pop-ox', align === 'start' ? `${w / 2}px` : `calc(100% - ${w / 2}px)`)
    }
    let release: (() => void) | null = null
    const onToggle = (e: Event): void => {
      const isOpen = (e as ToggleEvent).newState === 'open'
      release?.()
      release = isOpen ? occludeIfIntersects(el) : null
      setOpen(isOpen)
      onOpenChangeRef.current?.(isOpen)
      via.current = 'pointer'
    }
    el.addEventListener('beforetoggle', onBefore)
    el.addEventListener('toggle', onToggle)
    return () => {
      el.removeEventListener('beforetoggle', onBefore)
      el.removeEventListener('toggle', onToggle)
      release?.()
    }
  }, [popEl, align])

  const close = useCallback((opts?: { via?: Via; returnFocus?: boolean }) => {
    const el = popRef.current
    if (!el || !el.matches(':popover-open')) return
    via.current = opts?.via ?? 'pointer'
    el.dataset.via = via.current
    el.hidePopover()
    if (opts?.returnFocus !== false) triggerRef.current?.focus()
  }, [])

  const show = useCallback((v: Via = 'pointer') => {
    const el = popRef.current
    if (!el || el.matches(':popover-open')) return
    via.current = v
    el.showPopover()
  }, [])

  useEscape(open, useCallback(() => close({ via: 'keyboard' }), [close]))

  const triggerProps = {
    ref: triggerRef,
    popovertarget: id,
    'aria-expanded': open,
    'aria-controls': id,
    style: { anchorName: anchor } as CSSProperties,
    // Runs before the popovertarget activation, so the popover knows how it was opened.
    onClick: (e: MouseEvent) => {
      via.current = viaOf(e)
    }
  }

  const popoverProps = {
    ref: setPop,
    id,
    popover: 'auto' as const,
    'data-ui': 'popover',
    'data-dir': placement,
    style: {
      positionAnchor: anchor,
      ...(above
        ? {
            bottom: `calc(anchor(${above} top) + 8px)`,
            ...(maxHeight && {
              top: `max(8px, calc(anchor(${above} top) - 8px - ${maxHeight}))`,
              maxHeight: 'stretch',
              alignSelf: 'end'
            }),
            ...(align === 'start' ? { left: 'anchor(left)' } : { right: 'anchor(right)' }),
            marginBottom: 0
          }
        : { positionArea: AREA[placement][align], maxHeight }),
      ...(solid ? { '--control-material': 'solid' } : {})
    } as CSSProperties
  }

  return { open, close, show, triggerProps, popoverProps, triggerRef, popRef }
}
