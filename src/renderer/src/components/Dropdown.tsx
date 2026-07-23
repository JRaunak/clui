import { useCallback, useEffect, useRef, useState } from 'react'
import { useEscape } from '../lib/useEscape'
import { useClickOutside } from '../lib/useClickOutside'

export interface DropdownOption<T extends string> {
  value: T
  label: string
  /** Optional Tailwind text-color class (e.g. 'text-ok') for the label. */
  color?: string
  /** Optional one-line description shown UNDER the label in the OPEN menu only
   *  (never on the collapsed trigger — that stays compact). */
  description?: string
  /** Optional leading glyph for this option (e.g. a per-mode permission icon). */
  icon?: React.ReactNode
}

/**
 * A small custom dropdown styled to match Clui's dark theme (the native <select>
 * renders as the OS default, which looks out of place). Click to open, click an
 * option to select, click outside or Escape to dismiss.
 */
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  title,
  className,
  menuClassName,
  align = 'left',
  direction = 'down',
  icon
}: {
  value: T
  options: DropdownOption<T>[]
  onChange: (v: T) => void
  title?: string
  className?: string
  /** Extra classes for the open menu panel (e.g. a wider `w-64` when options
   *  carry descriptions so they don't wrap to 3 lines). */
  menuClassName?: string
  align?: 'left' | 'right'
  /** Open the menu upward (for bottom-docked controls). */
  direction?: 'up' | 'down'
  /** Optional leading icon (instrument-chip treatment). */
  icon?: React.ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const dismiss = useCallback(() => setOpen(false), [])
  useClickOutside(ref, open, dismiss)
  // Esc closes the open menu — via the shared escape-stack so a dropdown opened
  // inside a modal closes the dropdown first, not the modal.
  useEscape(open, dismiss)

  const current = options.find((o) => o.value === value)

  return (
    <div ref={ref} className={`relative ${className ?? ''}`} title={title}>
      <button
        type="button"
        className="flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border bg-bg px-2.5 text-xs transition-colors hover:border-border-strong focus:border-accent focus:outline-none focus-visible:outline-none"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {icon}
          <span className={`whitespace-nowrap font-medium ${current?.color ?? 'text-content'}`}>
            {current?.label ?? value}
          </span>
        </span>
        <svg
          viewBox="0 0 12 12"
          className={`h-3 w-3 shrink-0 text-dim transition-transform ${
            (direction === 'up') !== open ? 'rotate-180' : ''
          }`}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 4.5 6 7.5 9 4.5" />
        </svg>
      </button>
      {open && (
        <div
          className={`absolute z-50 min-w-full overflow-hidden rounded-lg border border-border bg-bg-elev py-1 shadow-2xl ${
            align === 'right' ? 'right-0' : 'left-0'
          } ${direction === 'up' ? 'bottom-full mb-1' : 'top-full mt-1'} ${menuClassName ?? ''}`}
        >
          {options.map((o) => {
            const selected = o.value === value
            // Left-aligned list (correct for scannable menus w/ multi-line descriptions).
            // NO leading tick-gutter (was lopsided dead space) and NO trailing tick (the
            // trigger chip still shows the current choice while the menu is open, so an
            // in-menu tick is redundant). Selection = a full-row highlight + a 2px accent
            // left-edge bar — Clui's active-item idiom (the active-session rail), absolutely
            // positioned so it adds ZERO horizontal shift; aria-current carries it for AT.
            return (
              <button
                key={o.value}
                type="button"
                aria-current={selected ? 'true' : undefined}
                className={`relative flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
                  selected ? 'bg-user' : 'hover:bg-user'
                } ${o.color ?? 'text-content'}`}
                onClick={() => {
                  onChange(o.value)
                  setOpen(false)
                }}
              >
                {selected && (
                  <span
                    className="absolute inset-y-0 left-0 w-0.5 bg-accent"
                    aria-hidden="true"
                  />
                )}
                {o.icon && <span className="mt-px shrink-0">{o.icon}</span>}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="whitespace-nowrap font-medium">{o.label}</span>
                  {o.description && (
                    <span className="whitespace-normal text-[11px] leading-snug text-faint">
                      {o.description}
                    </span>
                  )}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
