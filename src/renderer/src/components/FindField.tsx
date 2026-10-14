import type { ReactNode, RefObject } from 'react'
import { IconChevron, IconClose, IconSearch } from './Icon'

const STEP_BTN = 'flex h-7 w-7 items-center justify-center rounded text-dim transition-colors hover:text-content'
const STEP_BTN_DISABLABLE = `${STEP_BTN} disabled:opacity-40`

/** The find row's look: an input, a count or hint, and step and close buttons. Its owner does the searching. */
export function FindField({
  inputRef,
  value,
  onChange,
  onEnter,
  onClose,
  onPrev,
  onNext,
  stepDisabled,
  countText,
  countId,
  countClass = 'text-dim',
  statusText,
  placeholder,
  label,
  icon,
  invalid,
  numeric,
  closeLabel = 'Close find',
  ui
}: {
  inputRef: RefObject<HTMLInputElement>
  value: string
  onChange: (v: string) => void
  onEnter: (shift: boolean) => void
  onClose: () => void
  /** Without these the row has no step buttons. */
  onPrev?: () => void
  onNext?: () => void
  stepDisabled?: boolean
  countText: string
  /** Set when the count is the input's description rather than a visual echo. */
  countId?: string
  countClass?: string
  statusText?: string
  placeholder: string
  label: string
  icon?: ReactNode
  invalid?: boolean
  numeric?: boolean
  closeLabel?: string
  ui?: string
}): JSX.Element {
  return (
    <div data-ui={ui} className="flex h-8 w-full min-w-0 items-center gap-1.5 px-2 [-webkit-app-region:no-drag]">
      {icon ?? <IconSearch className="h-3.5 w-3.5 shrink-0 text-dim" />}
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onEnter(e.shiftKey)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }
        }}
        placeholder={placeholder}
        aria-label={label}
        aria-describedby={countId}
        aria-invalid={invalid || undefined}
        inputMode={numeric ? 'numeric' : undefined}
        className="h-7 min-w-0 flex-1 rounded-md bg-control px-2 text-ui text-content placeholder:text-dim focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-[-2px]"
      />
      <span id={countId} className={`min-w-[3.5rem] shrink-0 text-right font-mono text-meta tabular-nums ${countClass}`} aria-hidden={countId ? undefined : true}>
        {countText}
      </span>
      {statusText !== undefined && (
        <span className="sr-only" role="status" aria-live="polite">
          {statusText}
        </span>
      )}
      <div className="flex items-center">
        {onPrev && (
          <button type="button" onClick={onPrev} disabled={stepDisabled} aria-label="Previous match" className={STEP_BTN_DISABLABLE}>
            <IconChevron className="h-3.5 w-3.5 -rotate-90" />
          </button>
        )}
        {onNext && (
          <button type="button" onClick={onNext} disabled={stepDisabled} aria-label="Next match" className={STEP_BTN_DISABLABLE}>
            <IconChevron className="h-3.5 w-3.5 rotate-90" />
          </button>
        )}
        <button type="button" onClick={onClose} aria-label={closeLabel} className={STEP_BTN}>
          <IconClose className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
