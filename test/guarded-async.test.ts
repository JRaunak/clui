// Boundary: the double-submit guard's re-entry rejection. A create handler awaits the CLI
// spawn before it writes any state, so overlapping calls must be dropped synchronously or a
// click-flurry starts one session per click. Tests the React-free core the hook delegates to.
import { runGuarded } from '../src/renderer/src/lib/useGuardedAsync.ts'
import { equal } from './support/harness.mjs'

// A second call while the first is still unsettled is dropped, and the guard re-arms once it settles.
{
  const guard = { running: false }
  let calls = 0
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  const fn = (): Promise<void> => {
    calls++
    return gate
  }
  const pendings: boolean[] = []
  const setPending = (p: boolean): void => void pendings.push(p)

  const first = runGuarded(guard, fn, setPending)
  const dropped = runGuarded(guard, fn, setPending) // rejected synchronously, before any await

  equal(calls, 1, 'guard: second concurrent call is dropped (fn ran once)')
  equal(pendings[0], true, 'guard: pending flips true on entry')
  await dropped
  equal(calls, 1, 'guard: the dropped call never invoked fn')

  release()
  await first
  equal(guard.running, false, 'guard: cleared after the run settles')
  equal(pendings[pendings.length - 1], false, 'guard: pending flips false in finally')

  await runGuarded(guard, fn, setPending)
  equal(calls, 2, 'guard: re-armed after settle, the next call runs')
}

// A throwing fn still clears the guard (finally), so a failed spawn doesn't wedge the control.
{
  const guard = { running: false }
  let calls = 0
  const fn = async (): Promise<void> => {
    calls++
    throw new Error('spawn failed')
  }
  await runGuarded(guard, fn, () => {}).catch(() => {})
  equal(guard.running, false, 'guard: cleared even when fn throws')
  await runGuarded(guard, fn, () => {}).catch(() => {})
  equal(calls, 2, 'guard: re-armed after a throw')
}
