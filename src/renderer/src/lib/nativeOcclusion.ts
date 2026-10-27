import { useEffect } from 'react'
import { transitionHooks } from './motion'

type Listener = (occluded: boolean) => void
const holds = new Set<symbol>()
const listeners = new Set<Listener>()

function emit(): void {
  const occluded = holds.size > 0
  listeners.forEach((l) => l(occluded))
}

/** Hide the native views while something overlaps them. Returns the release function. */
export function occludeNative(): () => void {
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
  useEffect(() => (active ? occludeNative() : undefined), [active])
}

/** For popovers: occlude only if the element's rect intersects a native view's slot. */
export function occludeIfIntersects(el: Element | null): (() => void) | null {
  const slots = document.querySelectorAll('[data-native-slot]')
  if (!el || !slots.length) return null
  const a = el.getBoundingClientRect()
  const hit = [...slots].some((slot) => {
    const b = slot.getBoundingClientRect()
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
  })
  return hit ? occludeNative() : null
}

// Registered at module load, before any pane mounts: a transition that opens the pane runs its
// hooks before the pane exists, so a pane-owned hook would miss its own opening.
transitionHooks.add(() => occludeNative())
