import { useEffect } from 'react'
import { useSession } from '../store'
import { setBrowserPaneVia } from './dive'

const typingNow = (): boolean => {
  const el = document.activeElement as HTMLElement | null
  return !!el && (el.matches('input, textarea') || el.isContentEditable)
}

/** Routes browser events from main into their session's slice. Mounted once, in App. */
export function useBrowserEvents(): void {
  useEffect(
    () =>
      window.clui.onBrowserEvent((handleId, e) => {
        const store = useSession.getState()
        store.applyBrowserEvent(handleId, e)
        // The pane slides in as it would on a click, except while the user types: the slide snapshots
        // the Stage, which would freeze their text while it runs. 'keyboard' only skips the slide; this open moves no focus.
        if (e.type === 'tool-tab' && store.autoOpenBrowser(handleId)) setBrowserPaneVia('half', typingNow() ? 'keyboard' : 'pointer')
      }),
    []
  )
  useEffect(
    () =>
      window.clui.onAnnotateEvent((handleId, e) => {
        const store = useSession.getState()
        store.applyAnnotateEvent(handleId, e)
        // Escape in the page finishes annotating, and the comment is typed in the composer.
        if (e.type === 'off' && e.why === 'esc' && handleId === store.activeHandleId)
          document.querySelector<HTMLElement>('[data-composer-input]')?.focus()
      }),
    []
  )
}
