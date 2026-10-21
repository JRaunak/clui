import { useSyncExternalStore } from 'react'
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

// Point is asked of a surface from outside it (the pane button, ⌘⇧A) and its pressed state is read there too.
let point: string | null = null
let pointing: string | null = null
const listeners = new Set<() => void>()
const emit = (): void => listeners.forEach((l) => l())
const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

/** Asks surface `id` to toggle pointing; a surface that isn't mounted yet takes it when it is. */
export function requestPoint(id: string): void {
  point = id
  emit()
}

export const usePointRequest = (id: string): boolean => useSyncExternalStore(subscribe, () => point === id)

/** The request for `id`, once. */
export function takePoint(id: string): boolean {
  if (point !== id) return false
  point = null
  emit()
  return true
}

export function setPointing(id: string, on: boolean): void {
  const next = on ? id : pointing === id ? null : pointing
  if (next === pointing) return
  pointing = next
  emit()
}

export const usePointing = (id: string | null): boolean => useSyncExternalStore(subscribe, () => !!id && pointing === id)
