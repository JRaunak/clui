/**
 * Ultracode toggle for the active session (multi-step workflows at the stored effort).
 * Visual grammar: persistent ✦ star (dim off, lit purple on), one-shot ripple on
 * activation, star halo breathes during a busy ultracode turn (the one busy cue
 * generic indicators don't carry). State by color + fill + aria-pressed, never
 * motion alone (reduced-motion loses nothing). Disabled on models without Ultra
 * (shown, aria-disabled, tooltip explains why).
 */
import { useState } from 'react'
import { useActive, useSession, effortCap } from '../store'
import { supportsUltracodeToggle, cappedEffort, EFFORT_LABELS } from '../../../shared/settings'
import { Tooltip } from './Tooltip'

export function UltracodeToggle(): JSX.Element | null {
  const model = useActive((s) => s?.modelChoice ?? null)
  const on = useActive((s) => s?.ultracode ?? false)
  const effortChoice = useActive((s) => s?.effortChoice ?? 'high')
  const busy = useActive((s) => s?.busy ?? false)
  const setUltracode = useSession((s) => s.setUltracode)
  // Subscribe so a startup / session-start caps load re-renders the toggle.
  useSession((s) => s.effortCaps)
  const [arming, setArming] = useState(false)

  if (model === null) return null

  const ultraEngageable = supportsUltracodeToggle(model)
  const runLabel = EFFORT_LABELS[cappedEffort(model, effortChoice, effortCap(model))]
  const tipCopy = !ultraEngageable
    ? "Ultra isn't available on this model."
    : on
      ? `Ultra is on for this session. Multi-step workflows at ${runLabel} effort.`
      : `Multi-step workflows for this session, at ${runLabel} effort.`

  const engaged = on && busy // a live ultracode turn → the star's halo breathes

  const handleClick = (): void => {
    if (!ultraEngageable) return
    if (!on) setArming(true) // off→on: play the one-shot ripple
    void setUltracode(!on)
  }

  return (
    <Tooltip content={tipCopy} placement="top">
      <button
        type="button"
        data-ui="ultra-toggle"
        onClick={handleClick}
        aria-pressed={on}
        aria-disabled={!ultraEngageable}
        className={`flex h-8 min-w-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors @max-[560px]/composer:px-2 ${
          !ultraEngageable
            ? 'cursor-default border-border text-faint opacity-60'
            : on
              ? 'border-effort-ultra/50 bg-effort-ultra/12 text-effort-ultra'
              : 'border-border text-dim hover:text-content hover:border-border-strong'
        }`}
      >
        <span
          className={`flex items-center gap-1.5 ${arming ? 'ultra-arming' : ''}`}
          onAnimationEnd={() => setArming(false)}
        >
          <span
            aria-hidden="true"
            className={`ultra-star text-badge leading-none ${
              ultraEngageable ? (on ? 'text-effort-ultra' : 'text-dim') : 'text-faint'
            } ${engaged ? 'ultra-star-glow' : ''}`}
          >
            ✦
          </span>
          <span className="@max-[560px]/composer:sr-only">Ultra</span>
        </span>
      </button>
    </Tooltip>
  )
}
