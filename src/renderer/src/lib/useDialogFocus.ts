/** Move focus onto a dialog's own container when it opens, for dialogs that should not autofocus a control.
 *  With the background inerted, a dialog that focuses nothing strands focus on body. Focusing the container
 *  (a `tabIndex={-1}` element) fixes this without pre-selecting an action. The container stays out of the Tab order. */
import { useEffect, useRef, type RefObject } from 'react'

export function useDialogFocus<T extends HTMLElement>(): RefObject<T> {
  const ref = useRef<T>(null)
  useEffect(() => {
    // Capture the originating control so focus returns there on close. Runs per mount, so a request body keyed by request id re-runs it for each new request.
    const origin = document.activeElement as HTMLElement | null
    ref.current?.focus()
    return () => {
      if (origin?.isConnected) origin.focus()
    }
  }, [])
  return ref
}
