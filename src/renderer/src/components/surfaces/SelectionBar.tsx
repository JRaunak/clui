import { useActive } from '../../store'
import { Button } from '../Button'
import { IconCheck, IconPlus } from '../Icon'

/** Docked under a surface while it has a selection: what's selected, and the one action that stages it. */
export function SelectionBar({ label, attached, onAdd }: { label: string; attached: boolean; onAdd: () => void }): JSX.Element {
  const queued = useActive((s) => !!s?.referenceEditTarget)
  const add = queued ? 'Add to queued message' : 'Add to message'
  return (
    <div data-ui="selection-bar" className="flex h-10 shrink-0 items-center gap-2 border-t border-border bg-bg-elev pl-3 pr-1.5">
      <span className="min-w-0 flex-1 truncate text-meta text-dim">{label}</span>
      <Button variant="control" size="sm" aria-keyshortcuts="Enter" title={`${add} ↵`} onClick={onAdd}>
        {attached ? <IconCheck className="h-3.5 w-3.5" /> : <IconPlus className="h-3.5 w-3.5" />}
        {attached ? 'In message' : add}
      </Button>
    </div>
  )
}
