import { useEffect } from 'react'
import { useSession } from '../store'

/** Routes browser events from main into their session's slice. Mounted once, in App. */
export function useBrowserEvents(): void {
  useEffect(() => window.clui.onBrowserEvent((handleId, e) => useSession.getState().applyBrowserEvent(handleId, e)), [])
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
