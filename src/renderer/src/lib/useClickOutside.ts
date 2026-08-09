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
 * @param ref the popover's container (clicks inside it are ignored)
 * @param active whether the popover is currently open
 * @param onOutside called on an outside click (typically closes the popover)
 */
export function useClickOutside(
  ref: RefObject<HTMLElement>,
  active: boolean,
  onOutside: () => void
): void {
  useEffect(() => {
    if (!active) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [ref, active, onOutside])
}
