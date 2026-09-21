import { useCallback, useRef, useState } from 'react'

/**
 * Re-entry core for {@link useGuardedAsync}, kept React-free so the rejection logic is
 * unit-testable without a renderer. `guard.running` gates synchronously: a second call
 * that lands before the first's promise settles is dropped, and the flag clears in
 * `finally` so a throwing `fn` still re-arms the guard.
 */
export async function runGuarded(
  guard: { running: boolean },
  fn: () => Promise<unknown>,
  setPending: (p: boolean) => void
): Promise<void> {
  if (guard.running) return
  guard.running = true
  setPending(true)
  try {
    await fn()
  } finally {
    guard.running = false
    setPending(false)
  }
}

/**
 * Wrap an async action so overlapping calls are rejected: the first click runs, further
 * clicks are ignored until it settles. Returns the guarded callback and a `pending` flag
 * for a busy affordance.
 *
 * The ref rejects re-entry SYNCHRONOUSLY. A create handler awaits (getChatDir, the CLI
 * spawn) before any store write, so same-tick double-clicks all fire before a re-render;
 * a state flag flips too late to stop the second one, a ref does not.
 */
export function useGuardedAsync<A extends unknown[]>(
  fn: (...args: A) => Promise<unknown>
): readonly [(...args: A) => Promise<void>, boolean] {
  const guard = useRef({ running: false })
  const [pending, setPending] = useState(false)
  // Latest fn behind a ref so `guarded` stays identity-stable (safe as an effect dep / prop)
  // without ever calling a stale closure.
  const fnRef = useRef(fn)
  fnRef.current = fn
  const guarded = useCallback(
    (...args: A) => runGuarded(guard.current, () => fnRef.current(...args), setPending),
    []
  )
  return [guarded, pending]
}
