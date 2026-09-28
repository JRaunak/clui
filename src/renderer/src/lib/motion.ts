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

/** Called before each View Transition starts; a returned cleanup runs when it finishes. The browser
 *  pane uses this to swap its native view, which paints above all DOM, for a still. */
export const transitionHooks = new Set<() => (() => void) | void>()

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
  /** Runs once the DOM reflects `update`, in both paths. Transition names for the new state are set here. */
  after?: () => void
}): ViewTransition | null {
  const host: Document | HTMLElement = o.scope ?? document
  if (o.via === 'keyboard' || reducedMotion() || !('startViewTransition' in host)) {
    flushSync(o.update)
    o.after?.()
    return null
  }
  inflight.get(host)?.skipTransition()
  const cleanups = [...transitionHooks].map((h) => h())
  const t = host.startViewTransition({
    update: () => {
      flushSync(o.update)
      o.after?.()
    },
    types: o.types ?? []
  })
  inflight.set(host, t)
  t.finished.finally(() => {
    cleanups.forEach((c) => c?.())
    if (inflight.get(host) === t) inflight.delete(host)
  })
  return t
}

/**
 * runTransition with the host tagged `data-vt="<kind>"` for the transition's lifetime, so the
 * View Transitions CSS can key off it. A newer tagged transition on the same host owns the tag,
 * so a skipped one finishing late never clears it.
 */
export function runTagged(kind: string, o: Parameters<typeof runTransition>[0]): ViewTransition | null {
  const el = o.scope ?? document.documentElement
  const seq = String((Number(el.dataset.vtSeq) || 0) + 1)
  el.dataset.vtSeq = seq
  el.dataset.vt = kind
  const clear = (): void => {
    if (el.dataset.vtSeq !== seq) return
    delete el.dataset.vt
    delete el.dataset.vtSeq
  }
  const t = runTransition(o)
  if (t) t.finished.finally(clear)
  else clear()
  return t
}
