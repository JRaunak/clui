import { useEffect } from 'react'
import { transitionHooks } from './motion'

type Listener = (occluded: boolean) => void
const holds = new Set<symbol>()
const listeners = new Set<Listener>()

function emit(): void {
  const occluded = holds.size > 0
  listeners.forEach((l) => l(occluded))
}

/** Hide the native browser view while something overlaps it. Returns the release function. */
export function occludeBrowser(): () => void {
  const id = Symbol()
  holds.add(id)
  if (holds.size === 1) emit()
  return () => {
    if (holds.delete(id) && holds.size === 0) emit()
  }
}

/** Subscribe, getting the current state at once, so a pane that mounts under an open overlay starts hidden. */
export function onOcclusion(l: Listener): () => void {
  listeners.add(l)
  l(holds.size > 0)
  return () => {
    listeners.delete(l)
  }
}

/** For overlays that cover the whole window whenever they're mounted. */
export function useOccludeWhile(active: boolean): void {
  useEffect(() => (active ? occludeBrowser() : undefined), [active])
}

/** For popovers: occlude only if the element's rect intersects the browser pane. */
export function occludeIfIntersects(el: Element | null): (() => void) | null {
  const pane = document.querySelector('[data-ui="browser-pane"]')
  if (!el || !pane) return null
  const a = el.getBoundingClientRect()
  const b = pane.getBoundingClientRect()
  const hit = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  return hit ? occludeBrowser() : null
}

// Registered at module load, before any pane mounts: a transition that opens the pane runs its
// hooks before the pane exists, so a pane-owned hook would miss its own opening.
transitionHooks.add(() => occludeBrowser())
