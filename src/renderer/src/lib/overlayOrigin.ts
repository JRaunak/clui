import { useLayoutEffect, useRef, type RefObject } from 'react'
import { cssMs, cssVar, reducedMotion } from './motion'

type Point = { x: number; y: number }

// Settings has six openers, so the pressed control is recorded at the document instead of being
// threaded through openSettings().
let last: { p: Point; at: number } | null = null

document.addEventListener(
  'click',
  (e) => {
    if (e.detail === 0) return
    const hit = e.target instanceof Element ? e.target.closest('button, a, [role="option"], [role="menuitem"]') : null
    const r = hit?.getBoundingClientRect()
    last = {
      p: r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: e.clientX, y: e.clientY },
      at: performance.now()
    }
  },
  true
)
document.addEventListener('keydown', () => (last = null), true)

/** The last pointer-clicked control's centre, once. Null after a keypress or once 300ms have passed. */
export function takeOrigin(): Point | null {
  const r = last
  last = null
  return r && performance.now() - r.at <= 300 ? r.p : null
}

/**
 * Grows a modal out of the control the pointer pressed to open it. A keyboard open is instant.
 * No `fill`: if the animation never plays, the element's own style is already the end state.
 */
export function useOverlayEnter(scrimRef: RefObject<HTMLElement>, panelRef: RefObject<HTMLElement>): void {
  useLayoutEffect(() => {
    const o = takeOrigin()
    const scrim = scrimRef.current
    const panel = panelRef.current
    if (!o || !scrim || !panel) return
    const easing = cssVar('--ease-out')
    const fadeIn = [{ opacity: 0 }, { opacity: 1 }]
    if (reducedMotion()) {
      const fast = { duration: cssMs('--dur-fast'), easing }
      panel.animate(fadeIn, fast)
      scrim.animate(fadeIn, fast)
      return
    }
    const r = panel.getBoundingClientRect()
    panel.style.transformOrigin = `${o.x - r.left}px ${o.y - r.top}px`
    const base = { duration: cssMs('--dur-base'), easing }
    panel.animate([{ transform: 'scale(0.94)' }, { transform: 'none' }], { duration: cssMs('--dur-slow'), easing })
    panel.animate(fadeIn, base)
    scrim.animate(fadeIn, base)
  }, [])
}

/**
 * Inerts a modal while the palette or Global Search floats over it. Inerting the focused control
 * drops focus to body, and neither float restores it on close, so focus goes back here.
 */
export function useOverlayCovered(rootRef: RefObject<HTMLElement>, covered: boolean): void {
  const held = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const dialog = root.querySelector<HTMLElement>('[role="dialog"]')
    const active = document.activeElement
    if (covered) held.current = active instanceof HTMLElement && root.contains(active) ? active : dialog
    // React 18 doesn't forward the `inert` attribute, so set the DOM property.
    root.inert = covered
    if (covered || !held.current) return
    if (active === document.body) (held.current.isConnected ? held.current : dialog)?.focus()
    held.current = null
  }, [covered])
}
