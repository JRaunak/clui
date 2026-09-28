import { useEffect } from 'react'
import { useSession } from '../store'

/** Routes browser events from main into their session's slice. Mounted once, in App. */
export function useBrowserEvents(): void {
  useEffect(() => window.clui.onBrowserEvent((handleId, e) => useSession.getState().applyBrowserEvent(handleId, e)), [])
}
