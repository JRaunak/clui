/**
 * Ultracode toggle for the active session (X-High reasoning + dynamic workflows).
 * Visual grammar: persistent ✦ star (dim off, lit purple on), one-shot ripple on
 * activation, star halo breathes during a busy ultracode turn (the one busy cue
 * generic indicators don't carry). State by color + fill + aria-pressed, never
 * motion alone (reduced-motion loses nothing). Disabled on non-X-High models
 * (shown, aria-disabled, tooltip explains why).
 */
import { useState } from 'react'
import { useActive, useSession, effortCap } from '../store'
import { supportsUltracodeToggle, capBlocksUltra, clampEffort, EFFORT_LABELS } from '../../../shared/settings'
import { Tooltip } from './Tooltip'

export function UltracodeToggle(): JSX.Element | null {
  const model = useActive((s) => s?.modelChoice ?? null)
  const on = useActive((s) => s?.ultracode ?? false)
  const busy = useActive((s) => s?.busy ?? false)
  const setUltracode = useSession((s) => s.setUltracode)
  // Subscribe so a startup / session-start caps load re-renders the toggle.
  useSession((s) => s.effortCaps)
  const [arming, setArming] = useState(false)

  if (model === null) return null

  const cap = effortCap(model)
  // Ultra forces xhigh, so a sub-xhigh CLI cap blocks it as surely as a model without xhigh.
  const capBlocked = capBlocksUltra(cap)
  const ultraEngageable = supportsUltracodeToggle(model) && !capBlocked
  const capLabel = cap ? EFFORT_LABELS[clampEffort(model, cap)] : ''
  // Precedence: a model lacking xhigh outranks the cap message (fix the model first).
  const tipCopy = !supportsUltracodeToggle(model)
    ? "Ultra needs a model with X-High reasoning. The current one doesn't have it."
    : capBlocked
      ? `Ultra needs X-High, but your CLI settings cap effort at ${capLabel}.`
      : on
        ? 'Ultra is on. X-High reasoning and multi-step workflows, this session only.'
        : 'X-High reasoning and multi-step workflows, for this session.'

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
        onClick={handleClick}
        aria-pressed={on}
        aria-disabled={!ultraEngageable}
        className={`flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
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
            className={`ultra-star text-[11px] leading-none ${
              ultraEngageable ? (on ? 'text-effort-ultra' : 'text-dim') : 'text-faint'
            } ${engaged ? 'ultra-star-glow' : ''}`}
          >
            ✦
          </span>
          Ultra
        </span>
      </button>
    </Tooltip>
  )
}
