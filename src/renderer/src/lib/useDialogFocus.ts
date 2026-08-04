/**
 * Move focus onto a dialog's own container when it opens — for dialogs that
 * should NOT autofocus a control.
 *
 * With the background inerted (App.tsx), a dialog that focuses nothing strands
 * focus on <body>: the screen reader announces nothing on open, and the first
 * Tab has no anchor. Focusing the container (a `tabIndex={-1}` element) fixes both
 * WITHOUT pre-selecting an action — so the permission dialog's deliberate no-autofocus
 * gate (a reflexive Enter must not hit "Allow") is preserved. The container stays out
 * of the Tab order, so the first Tab still lands on the first real control.
 *
 * Search dialogs (command palette, global search) focus their input instead and
 * don't use this.
 */
import { useEffect, useRef, type RefObject } from 'react'

export function useDialogFocus<T extends HTMLElement>(): RefObject<T> {
  const ref = useRef<T>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return ref
}
