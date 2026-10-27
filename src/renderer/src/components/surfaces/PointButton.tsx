import { activeSlice, DRIVING_NOTE, surfaceKindOf, useActive, useSession, viewedTabOf } from '../../store'
import { requestPoint, usePointing } from '../../lib/surfaceFocus'
import { IconTarget } from '../Icon'
import { DISABLED_BTN, PANE_BTN } from './PaneHeader'
import { NO_CHANGES } from './DiffSurface'
import { fileLike } from '../../lib/presentation'

const PRESSED =
  'relative aria-pressed:bg-control-hover aria-pressed:text-content aria-pressed:after:absolute aria-pressed:after:inset-x-1.5 aria-pressed:after:bottom-0 aria-pressed:after:h-0.5 aria-pressed:after:rounded-full aria-pressed:after:bg-accent'

export const NO_TARGET = "Point needs a page, a file or Claude's changes in the pane."

/** Point for the active surface: the page's inspect mode, else the mounted File, page Preview or Diff surface takes
 *  the request. A disabled surface announces why, so the button and ⌘⇧A both come here. */
export function point(): void {
  const st = useSession.getState()
  const s = activeSlice(st)
  if (!s) return
  const id = s.surfaces.active
  const kind = surfaceKindOf(s.surfaces, id)
  if (kind === 'browser') return st.toggleAnnotate()
  if (id && (kind === 'diff' || fileLike(kind))) return requestPoint(id)
  st.announceStatus(s.handleId, NO_TARGET)
}

export function PointButton({ kind, id }: { kind: 'browser' | 'diff'; id: string }): JSX.Element {
  const annotating = useActive((s) => !!s && s.annotate.tab === s.browser?.viewed)
  const driving = useActive((s) => viewedTabOf(s?.browser)?.drive === 'driving')
  const noChanges = useActive((s) => !s?.changes.length)
  const pointing = usePointing(kind === 'browser' ? null : id)
  const pressed = kind === 'browser' ? annotating : pointing
  const reason =
    kind === 'browser' ? (driving ? `Claude is using this tab. ${DRIVING_NOTE}` : undefined) : noChanges ? NO_CHANGES : undefined
  return (
    <button
      type="button"
      data-ui="pane-point"
      aria-label="Point"
      aria-pressed={pressed}
      aria-keyshortcuts="Meta+Shift+A"
      aria-disabled={!!reason || undefined}
      title={reason ?? 'Point ⌘⇧A'}
      onClick={point}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || kind !== 'browser' || !annotating) return
        e.preventDefault()
        useSession.getState().toggleAnnotate()
        document.querySelector<HTMLElement>('[data-composer-input]')?.focus()
      }}
      className={`${PANE_BTN} ${DISABLED_BTN} ${PRESSED}`}
    >
      <IconTarget className="h-4 w-4" />
    </button>
  )
}
