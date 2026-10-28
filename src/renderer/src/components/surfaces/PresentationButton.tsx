import { useEffect } from 'react'
import { useSession } from '../../store'
import type { NoPreview, Presentation } from '../../lib/presentation'
import { IconCode, IconEye } from '../Icon'
import { PANE_BTN } from './PaneHeader'
import { useSay } from '../../lib/useSay'

const WHY: Record<NoPreview, string> = {
  denied: "Pages outside this session's folder don't preview in Clui.",
  'too-broad': "Pages don't preview in Clui while the session's folder is your home folder or above it.",
  'too-large': 'Files over 1 MB preview their first 1 MB.'
}

let sayHere: ((text: string) => void) | null = null
/** Speaks through the pane header's live region, which survives the Preview-to-Source swap that unmounts the caller. */
export const sayInHeader = (text: string): void => sayHere?.(text)

/** Swaps a tab between Source and Preview. It names the action, so the label changes instead of a pressed state.
 *  `noPreview`: why `auto` shows Source, which the title says before the user asks for a Preview. */
export function PresentationButton({ handleId, tabId, shown, noPreview }: { handleId: string; tabId: string; shown: Presentation; noPreview: NoPreview | null }): JSX.Element {
  const setView = useSession((s) => s.setSurfaceView)
  const [said, say] = useSay()
  useEffect(() => {
    sayHere = say
    return () => {
      if (sayHere === say) sayHere = null
    }
  }, [say])
  const preview = shown === 'preview'
  const label = preview ? 'Show source' : 'Show preview'
  const swap = (): void => {
    setView(handleId, tabId, { mode: preview ? 'source' : 'preview' })
    say(preview ? 'Showing source' : 'Showing preview')
  }
  return (
    <>
      <button
        type="button"
        data-ui="pane-presentation"
        aria-label={label}
        title={`${label} ⇧⌘V${!preview && noPreview ? `. ${WHY[noPreview]}` : ''}`}
        onClick={swap}
        className={PANE_BTN}
      >
        {preview ? <IconCode className="h-4 w-4" /> : <IconEye className="h-4 w-4" />}
      </button>
      <span className="sr-only" aria-live="polite">
        {said}
      </span>
    </>
  )
}
