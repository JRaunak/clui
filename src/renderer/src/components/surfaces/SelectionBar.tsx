import { useId, type ReactNode } from 'react'
import { useActive } from '../../store'
import { Button } from '../Button'
import { IconCheck, IconPlus } from '../Icon'

/** How long a selection's announcement trails the keys that make it. */
export const ANNOUNCE_MS = 300

// The Button's own disabled look needs `disabled`, which drops focus; a blocked Add stays reachable to explain itself.
const BLOCKED =
  'aria-disabled:cursor-default aria-disabled:border-transparent aria-disabled:bg-bg-raised aria-disabled:text-faint aria-disabled:hover:bg-bg-raised'

/**
 * Docked under a surface while it has a selection: what's selected, the source's own controls, and the one action
 * that stages it. `blocked` replaces the label with why it can't be added; activating Add then calls `onBlocked`.
 */
export function SelectionBar({
  label,
  attached,
  onAdd,
  children,
  blocked,
  onBlocked,
  busy
}: {
  label: string
  attached: boolean
  onAdd: () => void
  children?: ReactNode
  blocked?: string
  onBlocked?: () => void
  busy?: boolean
}): JSX.Element {
  const queued = useActive((s) => !!s?.referenceEditTarget)
  const labelId = useId()
  const add = queued ? 'Add to queued message' : 'Add to message'
  const text = blocked ?? label
  return (
    <div data-ui="selection-bar" className="@container/bar flex h-10 shrink-0 items-center gap-2 border-t border-border bg-bg-elev pl-3 pr-1.5">
      <span id={labelId} title={text} className="min-w-0 flex-1 truncate text-meta text-dim">
        {text}
      </span>
      {children}
      <Button
        variant="control"
        size="sm"
        aria-keyshortcuts="Enter"
        aria-label={attached ? 'In message' : add}
        aria-disabled={blocked ? true : undefined}
        aria-describedby={blocked ? labelId : undefined}
        title={`${add} ↵`}
        busy={busy}
        className={BLOCKED}
        onClick={blocked ? onBlocked : onAdd}
      >
        {attached ? <IconCheck className="h-3.5 w-3.5" /> : <IconPlus className="h-3.5 w-3.5" />}
        {attached ? (
          'In message'
        ) : (
          <>
            <span className="@max-[560px]/bar:hidden">{add}</span>
            <span className="hidden @max-[560px]/bar:inline">Add</span>
          </>
        )}
      </Button>
    </div>
  )
}
