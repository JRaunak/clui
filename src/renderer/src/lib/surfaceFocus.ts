import type { Via } from './motion'

let pending: { id: string; via: Via } | null = null

/** A user open asks surface `id` to take keyboard focus once it renders its destination. */
export function requestSurfaceFocus(id: string, via: Via = 'keyboard'): void {
  pending = { id, via }
}

/** How the open was made, once, for the surface that was asked; else null. */
export function takeSurfaceFocus(id: string): Via | null {
  if (pending?.id !== id) return null
  const { via } = pending
  pending = null
  return via
}
