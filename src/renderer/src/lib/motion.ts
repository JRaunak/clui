import { flushSync } from 'react-dom'

export type Via = 'pointer' | 'keyboard'

/** A click fired by Enter/Space on a button has detail 0; a real pointer click has detail ≥ 1. */
export function viaOf(e: { detail: number } | null | undefined): Via {
  return e && e.detail > 0 ? 'pointer' : 'keyboard'
}

export function reducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

const inflight = new WeakMap<Document | HTMLElement, ViewTransition>()

/**
 * Every View Transition in Clui starts here. Keyboard-initiated changes, reduced motion, and a host
 * without startViewTransition apply the update synchronously with no transition.
 * A transition already running on the same scope is skipped first, so rapid clicks never queue.
 */
export function runTransition(o: {
  update: () => void
  via: Via
  scope?: HTMLElement | null
  types?: string[]
}): ViewTransition | null {
  const host: Document | HTMLElement = o.scope ?? document
  if (o.via === 'keyboard' || reducedMotion() || !('startViewTransition' in host)) {
    o.update()
    return null
  }
  inflight.get(host)?.skipTransition()
  const t = host.startViewTransition({ update: () => flushSync(o.update), types: o.types ?? [] })
  inflight.set(host, t)
  t.finished.finally(() => { if (inflight.get(host) === t) inflight.delete(host) })
  return t
}
