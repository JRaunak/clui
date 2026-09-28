import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'

/** Position of this Gate in the session's pending queue; the header shows "1 of N" when N > 1. */
export interface GateCount {
  index: number
  total: number
}

export function focusComposer(): void {
  document.querySelector<HTMLElement>('[data-composer-input]')?.focus()
}

/**
 * The shared shape of a Gate: a region inside the composer dock, above the textarea. Focus lands
 * on the region itself, never on a button, because a stray Enter or Space must not approve it.
 * Esc hands focus back to the composer without deciding.
 */
export function GateFrame({
  icon,
  kicker,
  title,
  count,
  tabs,
  footer,
  describedBy,
  onKeyDown,
  children
}: {
  icon: ReactNode
  kicker: string
  title: ReactNode
  count: GateCount
  tabs?: ReactNode
  footer: ReactNode
  describedBy?: string
  onKeyDown?: (e: KeyboardEvent) => void
  children: ReactNode
}): JSX.Element {
  const titleId = useId()
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    const a = document.activeElement as HTMLTextAreaElement | null
    // Taking the caret from a half-typed message would drop whatever is typed next; the announcer
    // still speaks and the Gate is one Tab away.
    const drafting = !!a?.matches('[data-composer-input]') && a.value.trim() !== ''
    if (!drafting) ref.current?.focus({ preventScroll: true })
    return () => {
      // A decided Gate unmounts with focus inside it, which drops focus to body. Hand it to the
      // composer, unless the user has already moved somewhere else.
      const a = document.activeElement
      if (!a || a === document.body) focusComposer()
    }
  }, [])

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      focusComposer()
      return
    }
    onKeyDown?.(e)
  }

  return (
    <section
      ref={ref}
      data-ui="gate"
      role="region"
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      tabIndex={-1}
      onKeyDown={onKey}
      className="@container flex max-h-[60vh] flex-col rounded-t-[calc(var(--radius-xl)-1px)] outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      <header className="shrink-0 px-5 pt-4 pb-3">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-caps uppercase text-warn">
            {icon}
            {kicker}
          </span>
          {count.total > 1 && (
            <span data-ui="gate-queue" className="ml-auto text-meta tabular-nums text-dim">
              {count.index} of {count.total}
            </span>
          )}
        </div>
        <div id={titleId} data-ui="gate-title" className="mt-1.5 text-title text-content">
          {title}
        </div>
      </header>
      {tabs}
      <div className="min-h-0 flex-1 overflow-y-auto px-5">{children}</div>
      <footer className="flex shrink-0 items-center gap-3 px-5 pt-3 pb-4">{footer}</footer>
    </section>
  )
}
