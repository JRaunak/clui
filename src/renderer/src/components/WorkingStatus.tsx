/**
 * The foreground "working" indicator: 3 bouncing dots + a whimsical randomized
 * verb (Claude Code flavor, e.g. "Tomfoolering…") + an elapsed timer.
 *
 * It lives at the TAIL of the chat transcript (where the next output appears):
 * CLI-parity, and where the user's reading attention is. It is the SINGLE animated
 * element of a foreground turn, so the aggregate subagent header renders static.
 * Absent during background work (the turn has ended → composer is freed).
 *
 * The verb rotates every few seconds so a long turn never reads as frozen. When the
 * task puck is present (`taskMerged`), the verb is DROPPED (dots + timer only): the
 * puck's in_progress activeForm already narrates the work, so the whimsical verb would
 * be a second, competing status line.
 */
import { useEffect, useRef, useState } from 'react'
import { TypingDots } from './TypingDots'
import { randomWorkingVerb } from '../lib/workingVerbs'

export function WorkingStatus({ taskMerged = false }: { taskMerged?: boolean }): JSX.Element {
  const [elapsed, setElapsed] = useState(0)
  const [verb, setVerb] = useState(randomWorkingVerb)
  const start = useRef(Date.now())
  useEffect(() => {
    start.current = Date.now()
    setElapsed(0)
    setVerb(randomWorkingVerb())
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - start.current) / 1000)), 1000)
    // Rotate the verb periodically (offset from the 1s tick so they don't align).
    const rotate = setInterval(() => setVerb(randomWorkingVerb()), 4200)
    return () => {
      clearInterval(tick)
      clearInterval(rotate)
    }
  }, [])
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
