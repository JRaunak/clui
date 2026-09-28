import { Fragment, useEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react'
import { usePopover } from './Popover'
import { IconCheck, IconWarn } from './Icon'
import { viaOf } from '../lib/motion'

export interface DropdownOption<T extends string> {
  value: T
  label: string
  /** Optional Tailwind text-color class (e.g. 'text-ok') for the label in the default variant. */
  color?: string
  /** Optional one-line description shown under the label in the open menu only. */
  description?: string
  /** Optional leading glyph for this option. */
  icon?: React.ReactNode
  /** Marks a full-access / destructive option: content-colored text plus an err mark, since
   *  err text fails on glass. */
  tone?: 'danger'
  /** Draws a hairline rule above this option, marking a group boundary. */
  divider?: boolean
  /** Group header rendered above this option; set on the first of each group. */
  header?: string
  /** Right-aligned dim meta in the open menu (e.g. a model's context size). */
  meta?: string
  /** Full title for `meta` so an abbreviation stays recoverable. */
  metaTitle?: string
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
  checkTone = 'accent',
  icon,
  ariaLabel,
  solid = false,
  dataUi,
  labelClassName,
  chevronClassName
}: {
  value: T
  options: DropdownOption<T>[]
  onChange: (v: T) => void
  title?: string
  /** Accessible name for the trigger (its visible label is a value, not the field name). */
  ariaLabel?: string
  className?: string
  menuClassName?: string
  align?: 'left' | 'right'
  /** Open the menu upward (for bottom-docked controls). */
  direction?: 'up' | 'down'
  /** pill = the composer's borderless recessed-well trigger. default = the bordered chip. */
  variant?: 'default' | 'pill'
  /** 'accent' draws the check in content color; 'neutral' dims it. */
  checkTone?: 'accent' | 'neutral'
  icon?: React.ReactNode
  /** Opaque menu, for a dropdown that opens over another glass panel. */
  solid?: boolean
  dataUi?: string
  labelClassName?: string
  chevronClassName?: string
}): JSX.Element {
  // The only upward dropdowns are the composer's chips, which open above the whole dock.
  const p = usePopover({
    placement: direction === 'up' ? 'up' : 'down',
    align: align === 'right' ? 'end' : 'start',
    solid,
    above: direction === 'up' ? '--composer-dock' : undefined
  })
  const optRefs = useRef<(HTMLButtonElement | null)[]>([])
  const selectedIdx = Math.max(0, options.findIndex((o) => o.value === value))

  // Land on the current choice when the list opens, the native <select> convention.
  useEffect(() => {
    if (p.open) optRefs.current[selectedIdx]?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.open])

  const select = (v: T, e: MouseEvent): void => {
    onChange(v)
    p.close({ via: viaOf(e) })
  }

  const onListKey = (e: KeyboardEvent): void => {
    const i = optRefs.current.findIndex((el) => el === document.activeElement)
    const last = options.length - 1
    const to =
      e.key === 'ArrowDown' ? Math.min(last, i + 1)
      : e.key === 'ArrowUp' ? Math.max(0, i - 1)
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : -1
    if (to >= 0) {
      e.preventDefault()
      optRefs.current[to]?.focus()
    } else if (e.key === 'Tab') {
      p.close({ via: 'keyboard', returnFocus: false })
    }
  }

  const current = options.find((o) => o.value === value)
  const isPill = variant === 'pill'

  return (
    <div className={`relative ${className ?? ''}`} title={title}>
      <button
        type="button"
        {...p.triggerProps}
        data-ui={dataUi}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        className={
          isPill
            ? `group flex h-8 items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors ${
                p.open ? 'bg-control-hover' : 'bg-control hover:bg-control-hover'
              }`
            : 'flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border bg-bg px-2.5 text-xs transition-colors hover:border-border-strong'
        }
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {icon}
          <span
            className={`whitespace-nowrap font-medium ${
              isPill
                ? `${p.open ? 'text-content' : 'text-dim'} group-hover:text-content`
                : current?.tone === 'danger'
                  ? 'text-content'
                  : (current?.color ?? 'text-content')
            } ${labelClassName ?? ''}`}
          >
            {current?.label ?? value}
          </span>
        </span>
        <svg
          viewBox="0 0 12 12"
          className={`h-3 w-3 shrink-0 text-dim transition-transform ${(direction === 'up') !== p.open ? 'rotate-180' : ''} ${chevronClassName ?? ''}`}
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
      <div
        {...p.popoverProps}
        role="listbox"
        aria-label={ariaLabel ?? title}
        onKeyDown={onListKey}
        className={`pop-base pop glass-thick max-h-[min(60vh,420px)] overflow-y-auto ${
          isPill ? 'rounded-xl p-1.5' : 'rounded-lg py-1'
        } ${menuClassName ?? ''}`}
        style={{ ...p.popoverProps.style, minWidth: 'anchor-size(width)' }}
      >
        {options.map((o, i) => {
          const selected = o.value === value
          const danger = o.tone === 'danger'
          const check = (
            <IconCheck
              className={`h-3.5 w-3.5 shrink-0 self-center ${checkTone === 'neutral' ? 'text-dim' : 'text-content'}`}
            />
          )
          return (
            <Fragment key={o.value}>
              {!isPill && o.header && (
                <div role="presentation" className="px-3 pb-0.5 pt-1.5 text-caps uppercase text-dim">
                  {o.header}
                </div>
              )}
              <button
                type="button"
                ref={(el) => (optRefs.current[i] = el)}
                role="option"
                aria-selected={selected}
                tabIndex={-1}
                onClick={(e) => select(o.value, e)}
                className={
                  isPill
                    ? `relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left -outline-offset-2 hover:bg-[var(--glass-row-hover)] focus-visible:bg-[var(--glass-row-hover)] ${
                        o.divider ? 'mt-1 border-t border-[var(--glass-edge)] pt-3' : ''
                      }`
                    : `relative flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs -outline-offset-2 ${
                        selected ? 'bg-[var(--glass-row-hover)]' : 'hover:bg-[var(--glass-row-hover)]'
                      } ${danger ? 'text-content' : (o.color ?? 'text-content')}`
                }
              >
                {/* Danger reads by shape as well as hue: a 2px err mark on the leading edge. */}
                {danger && isPill && (
                  <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-err" aria-hidden="true" />
                )}
                {!isPill && selected && (
                  <span className="absolute inset-y-0 left-0 w-0.5 bg-accent" aria-hidden="true" />
                )}
                {o.icon && <span className={`shrink-0 ${isPill ? '' : 'mt-px'}`}>{o.icon}</span>}
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className={`${isPill ? 'text-sm' : 'truncate'} font-medium ${isPill ? 'text-content' : ''}`}>
                    {o.label}
                  </span>
                  {o.description && (
                    <span className="whitespace-normal text-meta leading-snug text-dim">{o.description}</span>
                  )}
                </span>
                {o.meta && (
                  <span className="shrink-0 self-center tabular-nums text-meta text-dim" title={o.metaTitle}>
                    {o.meta}
                  </span>
                )}
                {danger && !isPill && <IconWarn className="h-3.5 w-3.5 shrink-0 self-center text-err" />}
                {isPill && selected && check}
              </button>
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}
