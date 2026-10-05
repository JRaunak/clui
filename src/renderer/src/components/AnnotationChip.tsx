import { chipLabel, clipName } from '../../../shared/annotate'
import { IconClose, IconTarget } from './Icon'

/** One pinned element: a crop thumbnail with its number, the element's words and its host. Read-only in a sent
 *  message, removable in the composer. */
export function AnnotationChip({
  n,
  kind,
  name,
  host,
  thumb,
  onRemove
}: {
  n: number
  kind: string
  name: string
  host: string
  thumb?: string
  onRemove?: () => void
}): JSX.Element {
  return (
    <div
      data-ui="annotation-chip"
      title={name ? `${n} ${kind} "${name}"` : undefined}
      className={`relative flex items-center gap-2 rounded-md border border-border bg-bg-raised py-1 pl-1 ${onRemove ? 'pr-2' : 'pr-3'}`}
    >
      <span className="relative h-10 w-10 shrink-0">
        {thumb ? (
          <img src={thumb} alt="" className="h-10 w-10 rounded bg-tool object-cover" />
        ) : (
          <span className="flex h-10 w-10 items-center justify-center rounded bg-tool text-dim">
            <IconTarget className="h-5 w-5" />
          </span>
        )}
        <span
          aria-hidden="true"
          className="absolute -left-1 -top-1 flex size-4.5 items-center justify-center rounded-full bg-accent text-badge font-semibold text-on-accent"
        >
          {n}
        </span>
      </span>
      <div className="flex min-w-0 flex-col">
        <span className="whitespace-nowrap text-xs text-content">{chipLabel(n, kind, name)}</span>
        <span className="font-mono text-meta text-faint">{host}</span>
      </div>
      {onRemove && (
        <button
          type="button"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dim transition-colors hover:bg-bg-elev hover:text-content"
          onClick={onRemove}
          title="Remove annotation"
          aria-label={`Remove annotation ${n}, ${kind}${name ? ` ${clipName(name)}` : ''}`}
        >
          <IconClose className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}
