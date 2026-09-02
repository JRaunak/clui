import { useCallback, useEffect, useRef, useState } from 'react'
import { useEscape } from '../lib/useEscape'
import { useClickOutside } from '../lib/useClickOutside'

export interface DropdownOption<T extends string> {
  value: T
  label: string
  /** Optional Tailwind text-color class (e.g. 'text-ok') for the label. */
  color?: string
  /** Optional one-line description shown under the label in the open menu only
   *  (the collapsed trigger stays compact). */
  description?: string
  /** Optional leading glyph for this option (e.g. a per-mode permission icon). */
  icon?: React.ReactNode
  /** Marks a full-access / destructive option. In the `pill` variant its whole row
     renders in `err` with its own darker hover fill. Scoped per-option so the shared
     Settings/GlobalSearch dropdowns are unaffected. */
  tone?: 'danger'
}

/** A custom dropdown replacing the native <select>, which renders as the OS default
 *  and looks out of place in Clui's styled UI. */
export function Dropdown<T extends string>({
  value,
  options,
  onChange,
  title,
  className,
  menuClassName,
  align = 'left',
  direction = 'down',
  variant = 'default',
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
  /** `pill` = the composer's borderless recessed-well trigger + a radius-xl
   *  borderless card. `default` = the bordered chip used in Settings/GlobalSearch. */
  variant?: 'default' | 'pill'
  /** Optional leading icon. */
  icon?: React.ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const dismiss = useCallback(() => setOpen(false), [])
  useClickOutside(ref, open, dismiss)
  // Esc closes the open menu via the shared escape-stack, so a dropdown opened
  // inside a modal closes the dropdown first, not the modal.
  useEscape(open, dismiss)

  const current = options.find((o) => o.value === value)
  const isPill = variant === 'pill'

  return (
    <div ref={ref} className={`relative ${className ?? ''}`} title={title}>
      <button
        type="button"
        className={
          isPill
            ? `group flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors ${
                open ? 'bg-control-hover' : 'bg-control hover:bg-control-hover'
              }`
            : 'flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border bg-bg px-2.5 text-xs transition-colors hover:border-border-strong focus:border-accent focus:outline-none focus-visible:outline-none'
        }
        onClick={() => setOpen((o) => !o)}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {icon}
          {/* Pill trigger keeps the label NEUTRAL (dim→content) so the per-mode color
              lives only on the icon; the bordered variant tints the label per-option. */}
          <span
            className={`whitespace-nowrap font-medium ${
              isPill
                ? `${open ? 'text-content' : 'text-dim'} group-hover:text-content`
                : (current?.color ?? 'text-content')
            }`}
          >
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
      {open && isPill && (
        <div
          className={`absolute z-50 min-w-full overflow-hidden rounded-xl bg-bg-elev p-1.5 shadow-lg ${
            align === 'right' ? 'right-0' : 'left-0'
          } ${direction === 'up' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'} ${menuClassName ?? ''}`}
        >
          {options.map((o) => {
            const selected = o.value === value
            const danger = o.tone === 'danger'
            // Selection reads as a trailing ✓ glyph in accent (accent-as-glyph clears the
            // 3:1 non-text floor where accent-as-text on the hover fill would fail, and
            // keeps the scarce accent off the title). Danger rows go fully err with their
            // own darker hover fill; other rows keep a neutral title + faint description.
            return (
              <button
                key={o.value}
                type="button"
                aria-current={selected ? 'true' : undefined}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors ${
                  danger ? 'text-err hover:bg-control-danger-hover' : 'hover:bg-row-hover'
                }`}
                onClick={() => {
                  onChange(o.value)
                  setOpen(false)
                }}
              >
                {o.icon && <span className="shrink-0">{o.icon}</span>}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className={`text-sm font-medium ${danger ? '' : 'text-content'}`}>
                    {o.label}
                  </span>
                  {o.description && (
                    <span
                      className={`whitespace-normal text-xs leading-snug ${
                        danger ? '' : 'text-faint'
                      }`}
                    >
                      {o.description}
                    </span>
                  )}
                </span>
                {selected && (
                  <span className="shrink-0 self-center text-accent" aria-hidden="true">
                    ✓
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
      {open && !isPill && (
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
            // left-edge bar, Clui's active-item idiom (the active-session rail), absolutely
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
