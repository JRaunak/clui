/**
 * Dismiss-on-outside-click for popovers/menus.
 *
 * While `active`, a document-level mousedown listener fires `onOutside` when the click
 * lands outside `ref`. The companion to `useEscape` (same call shape): a popover wanting
 * both dismissal paths calls the two side by side. Extracted because the identical effect
 * was hand-rolled in every dropdown/menu; a change here (pointerdown for touch, ignoring
 * the trigger, portalled sub-menus) now lands in one place instead of drifting across sites.
 */
import { useEffect, type RefObject } from 'react'

/**
 * Call `onOutside` when a mousedown lands outside `ref`, while `active` is true.
 * @param ref the popover's container, or several containers when a portalled sub-menu lives
 *   outside the main one in the DOM (a click inside ANY of them counts as inside). Pass a stable
 *   array (memoized or refs) so the listener isn't re-bound every render.
 * @param active whether the popover is currently open
 * @param onOutside called on an outside click (typically closes the popover)
 */
export function useClickOutside(
  ref: RefObject<HTMLElement> | ReadonlyArray<RefObject<HTMLElement>>,
  active: boolean,
  onOutside: () => void
): void {
  useEffect(() => {
    if (!active) return
    const refs = Array.isArray(ref) ? ref : [ref]
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (refs.some((r) => r.current?.contains(target))) return
      onOutside()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [ref, active, onOutside])
}
