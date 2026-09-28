/** The foreground "working" line: the bead that carries the Lumen, a label, and an elapsed timer. The label is a
 *  randomized verb, "Thinking" with a live token estimate, or "Compacting context…". It lives at the transcript tail
 *  where the next output appears, and is absent during background work.
 *  The verb rotates every few seconds so a long turn never reads as frozen. When the task puck is present, the verb
 *  is dropped because the puck's in_progress activeForm already narrates the work; the compacting label still shows. */
import { useEffect, useState } from 'react'
import { useActive } from '../store'
import { Lumen } from './Lumen'
import { useLumenSite } from '../lib/lumen'
import { randomWorkingVerb } from '../lib/workingVerbs'
import { fmtTokens } from '../lib/formatTokens'

export function WorkingStatus({ taskMerged = false }: { taskMerged?: boolean }): JSX.Element {
  // Elapsed derives from the turn's start timestamp in the slice, not component mount, so switching sessions
  // or entering a detail view doesn't reset a live turn's timer, and each queued turn restarts it.
  const startMs = useActive((s) => s?.turnStartMs ?? null)
  const thinkingTokens = useActive((s) => s?.thinkingTokens ?? null)
  const compacting = useActive((s) => s?.compacting ?? false)
  // The tail lights only while text or thinking streams; a running tool's own bead takes the light.
  const lit = useLumenSite()?.kind === 'tail'
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
    <span className="flex items-center gap-2 text-label" data-ui="working-status">
      {/* mr-1 keeps the first glyph 16px from the bead's centre, clear of the light's 11px reach. */}
      <span className="relative mr-1 flex h-2 w-2 shrink-0" role="status" aria-label="Working">
        {/* The light goes first so the bead, the later positioned sibling, paints over its additive blend. */}
        <Lumen lit={lit} />
        <span className="relative h-2 w-2 rounded-full bg-accent" aria-hidden="true" />
      </span>
      {compacting ? (
        <span className="text-content">Compacting context…</span>
      ) : (
        !taskMerged && (
          <span className="font-medium text-content">{thinkingTokens !== null ? 'Thinking' : `${verb}…`}</span>
        )
      )}
      {!compacting && thinkingTokens !== null && (
        <span aria-hidden="true" className="font-mono tabular-nums text-dim">
          <span className="inline-block min-w-[6ch] text-right">~{fmtTokens(thinkingTokens)}</span>{' '}
          {thinkingTokens === 1 ? 'token' : 'tokens'}
        </span>
      )}
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
