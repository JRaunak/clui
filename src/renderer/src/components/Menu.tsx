import { useEffect, useRef, useState, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react'
import { usePopover, type PopoverAlign } from './Popover'
import { viaOf } from '../lib/motion'

export interface MenuItem {
  key: string
  label: string
  icon: JSX.Element
  onClick: () => void
  danger?: boolean
  /** Keyboard-accelerator hint or a short fact, right-aligned, so the visible menu teaches the invisible key. It
   *  stays out of the item's name; `keys` and `description` say it to assistive tech. */
  hint?: ReactNode
  /** The hint's full text, when it can truncate. */
  hintTitle?: string
  description?: string
  keys?: string
  /** Choosing it hands focus back to the trigger, for an item that opens a dialog over the page. */
  returnFocus?: boolean
}

/**
 * A menu button. The open menu is `role="menu"` with roving focus that starts on the first item; Esc closes
 * and returns focus to the trigger, Tab closes and lets focus move on, and an outside click closes it.
 * Renders nothing if there are no items.
 */
export function Menu({
  label,
  items,
  align,
  width = 'min-w-[188px]',
  trigger,
  children
}: {
  label: string
  items: MenuItem[]
  align: PopoverAlign
  width?: string
  trigger: ButtonHTMLAttributes<HTMLButtonElement> & { 'data-ui'?: string }
  children: ReactNode
}): JSX.Element | null {
  const [focusIdx, setFocusIdx] = useState(0)
  const p = usePopover({ placement: 'down', align })
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    if (p.open) itemRefs.current[focusIdx]?.focus()
  }, [p.open, focusIdx])

  if (items.length === 0) return null

  const onMenuKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusIdx((i) => (i + 1) % items.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusIdx((i) => (i - 1 + items.length) % items.length)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setFocusIdx(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setFocusIdx(items.length - 1)
    } else if (e.key === 'Tab') {
      p.close({ via: 'keyboard', returnFocus: false })
    }
  }

  return (
    <div className="relative">
      <button
        type="button"
        {...trigger}
        {...p.triggerProps}
        aria-haspopup="menu"
        onClick={(e) => {
          e.stopPropagation()
          setFocusIdx(0)
          p.triggerProps.onClick(e)
        }}
      >
        {children}
      </button>
      <div {...p.popoverProps} role="menu" aria-label={label} className={`pop-base pop glass-thick ${width} max-w-[320px] rounded-lg p-1`} onKeyDown={onMenuKey}>
        {items.map((it, i) => (
          <button
            key={it.key}
            ref={(el) => (itemRefs.current[i] = el)}
            role="menuitem"
            tabIndex={i === focusIdx ? 0 : -1}
            aria-description={it.description}
            aria-keyshortcuts={it.keys}
            className={`relative flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-label text-content -outline-offset-2 hover:bg-[var(--glass-row-hover)] focus-visible:bg-[var(--glass-row-hover)] ${
              it.danger ? 'mt-1 border-t border-[var(--glass-edge)] pt-2' : ''
            }`}
            onClick={(e) => {
              e.stopPropagation()
              p.close({ via: viaOf(e), returnFocus: !!it.returnFocus })
              it.onClick()
            }}
          >
            {/* Destructive reads by mark and icon, since err text fails on glass. */}
            {it.danger && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-err" aria-hidden="true" />}
            <span className={`shrink-0 ${it.danger ? 'text-err' : 'text-dim'}`}>{it.icon}</span>
            <span className="min-w-0 flex-1 truncate">{it.label}</span>
            {it.hint && (
              <span aria-hidden="true" title={it.hintTitle} className="min-w-0 max-w-[55%] truncate text-meta text-dim">
                {it.hint}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
