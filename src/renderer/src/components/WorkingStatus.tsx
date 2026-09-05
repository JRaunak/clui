/** The foreground "working" indicator: 3 bouncing dots + a whimsical randomized verb + an elapsed timer.
 *  Lives at the tail of the chat transcript where the next output appears. The single animated element of a
 *  foreground turn. Absent during background work.
 *  The verb rotates every few seconds so a long turn never reads as frozen. When the task puck is present,
 *  the verb is dropped (dots + timer only): the puck's in_progress activeForm already narrates the work. */
import { useEffect, useState } from 'react'
import { useActive } from '../store'
import { TypingDots } from './TypingDots'
import { randomWorkingVerb } from '../lib/workingVerbs'

export function WorkingStatus({ taskMerged = false }: { taskMerged?: boolean }): JSX.Element {
  // Elapsed derives from the turn's start timestamp in the slice, not component mount, so switching sessions
  // or entering a detail view doesn't reset a live turn's timer, and each queued turn restarts it.
  const startMs = useActive((s) => s?.turnStartMs ?? null)
  const [elapsed, setElapsed] = useState(() => (startMs ? Math.floor((Date.now() - startMs) / 1000) : 0))
  const [verb, setVerb] = useState(randomWorkingVerb)
  useEffect(() => {
    const base = startMs ?? Date.now()
    setElapsed(Math.floor((Date.now() - base) / 1000))
    setVerb(randomWorkingVerb())
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - base) / 1000)), 1000)
    // Rotate the verb periodically, offset from the 1s tick so they don't align.
    const rotate = setInterval(() => setVerb(randomWorkingVerb()), 4200)
    return () => {
      clearInterval(tick)
      clearInterval(rotate)
    }
  }, [startMs])
  return (
    <span className="flex items-center gap-2 text-[13px]">
      <TypingDots className="text-ok" />
      {!taskMerged && <span className="font-serif italic text-content">{verb}…</span>}
      <span className="font-mono tabular-nums text-dim">{formatElapsed(elapsed)}</span>
    </span>
  )
}

/** `47s` / `1m 13s` / `1h 02m`. */
function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}
