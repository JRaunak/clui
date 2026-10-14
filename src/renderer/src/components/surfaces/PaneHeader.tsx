import { useRef, type ReactNode } from 'react'
import { useSession } from '../../store'
import { usePane } from '../Stage'
import { IconClose, IconExternal, IconMaximize, IconRestore, IconShield } from '../Icon'
import { diveOut, resizePane } from '../../lib/dive'
import { viaOf } from '../../lib/motion'

export const PANE_BTN =
  'toggle-press flex h-7 w-7 items-center justify-center rounded-md text-dim transition-colors focus-visible:-outline-offset-2 pointer-fine:hover:bg-[var(--glass-row-hover)] pointer-fine:hover:text-content'

export const DISABLED_BTN =
  'aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:pointer-fine:hover:bg-transparent aria-disabled:pointer-fine:hover:text-dim'

/** Takes the active surface out of Clui. `label` names where it goes; a `disabledReason` keeps the
 *  button focusable and readable but inert. */
export interface PaneExternal {
  label: string
  onOpen: () => void | Promise<void>
  disabledReason?: string
}

/**
 * The right sidebar's 36px header under the top band, glass only while content is under it. The view
 * inside supplies the title (the element carrying data-ui="pane-title", or the pane's tabs) and its
 * status; the header supplies the pane actions. Only the subagent pane closes from here. Surfaces
 * hide through the toggle or ⇧⌘B so their pages stay live, and each tab has its own close.
 */
export function PaneHeader({
  kind,
  status,
  external,
  actions,
  children
}: {
  /** Without a kind the row starts at 8px, so the first tab lines up with the toolbar's Back button. */
  kind?: string
  status?: ReactNode
  external?: PaneExternal
  actions?: ReactNode
  children: ReactNode
}): JSX.Element {
  const pane = usePane()
  const full = pane.state === 'full'
  const scrolled = useSession((s) => s.secondaryScrolled)
  // A launch can take a second, so the ref keeps a double click to one launch.
  const launching = useRef(false)
  const openExternal = async (): Promise<void> => {
    if (!external || external.disabledReason || launching.current) return
    launching.current = true
    try {
      await external.onOpen()
    } finally {
      launching.current = false
    }
  }
  return (
    <div
      data-ui="pane-header"
      data-scrolled={scrolled || undefined}
      className={`group/pane absolute inset-x-0 top-11 z-30 flex h-9 items-center gap-2 pr-2 text-label ${kind ? 'pl-4' : 'pl-2'}`}
    >
      <div
        aria-hidden="true"
        data-ui="pane-header-glass"
        className="glass-bar pointer-events-none absolute inset-0 -z-10 opacity-0 transition-opacity duration-fast ease-in group-data-[scrolled]/pane:opacity-100 group-data-[scrolled]/pane:ease-out contrast-more:opacity-100 motion-reduce:transition-none"
      />
      <div data-ui="pane-head-title" className="flex min-w-0 flex-1 items-center gap-2">
        {children}
        {kind && <span className="shrink-0 text-meta text-dim">{kind}</span>}
        {status && (
          <>
            <span aria-hidden="true" className="shrink-0 text-meta text-dim">·</span>
            {status}
          </>
        )}
      </div>
      {pane.needsYou && (
        <button
          type="button"
          data-ui="pane-needs-you"
          onClick={pane.resolveNeedsYou}
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-control px-2.5 text-meta font-medium text-content transition-colors hover:bg-control-hover"
        >
          <IconShield className="h-3.5 w-3.5 text-warn" />
          Needs you
        </button>
      )}
      <div data-ui="pane-head-controls" className="flex shrink-0 items-center gap-0.5">
        {external && (
          <button
            type="button"
            data-ui="pane-external"
            aria-label={external.label}
            title={external.disabledReason ? `${external.label}. ${external.disabledReason}` : `${external.label} ⇧⌘O`}
            aria-disabled={!!external.disabledReason || undefined}
            onClick={() => void openExternal()}
            className={`${PANE_BTN} ${DISABLED_BTN}`}
          >
            <IconExternal className="h-4 w-4" />
          </button>
        )}
        {actions}
        {pane.canToggleSize && (
          <button
            type="button"
            data-ui="pane-expand"
            onClick={(e) => resizePane(!full, viaOf(e))}
            aria-pressed={full}
            aria-label={full ? 'Return to split' : 'Expand to full'}
            title={full ? 'Split ⌥⌘B' : 'Expand ⌥⌘B'}
            className={PANE_BTN}
          >
            {full ? <IconRestore className="h-4 w-4" /> : <IconMaximize className="h-4 w-4" />}
          </button>
        )}
        {pane.kind === 'subagent' && (
          <button
            type="button"
            data-ui="pane-close"
            onClick={(e) => diveOut(viaOf(e))}
            aria-label="Close pane"
            title="Close (Esc)"
            className={PANE_BTN}
          >
            <IconClose className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  )
}
