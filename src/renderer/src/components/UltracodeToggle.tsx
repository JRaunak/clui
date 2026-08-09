/**
 * Ultracode toggle for the active session (X-High reasoning + dynamic workflows).
 * Visual grammar: persistent ✦ star (dim off, lit purple on), one-shot ripple on
 * activation, star halo breathes during a busy ultracode turn (the one busy cue
 * generic indicators don't carry). State by color + fill + aria-pressed, never
 * motion alone (reduced-motion loses nothing). Disabled on non-X-High models
 * (shown, aria-disabled, title explains why).
 */
import { useEffect, useRef, useState } from 'react'
import { useActive, useSession } from '../store'
import { supportsUltracodeToggle } from '../../../shared/settings'

export function UltracodeToggle(): JSX.Element | null {
  const model = useActive((s) => s?.modelChoice ?? null)
  const on = useActive((s) => s?.ultracode ?? false)
  const busy = useActive((s) => s?.busy ?? false)
  const setUltracode = useSession((s) => s.setUltracode)
  const [arming, setArming] = useState(false)
  // Track the previous `on` so we only fire the arm sweep on a true off→on edge (not on
  // mount-while-on, e.g. resuming an ultra session, and not on on→off).
  const prevOn = useRef(on)
  useEffect(() => {
    prevOn.current = on
  }, [on])

  if (model === null) return null

  const supported = supportsUltracodeToggle(model)
  const title = supported
    ? on
      ? 'Ultra on — X-High reasoning + multi-step workflows. Click to turn off.'
      : 'Ultra — X-High reasoning + multi-step workflows. Click to turn on (this session).'
    : 'Ultra needs a model with X-High reasoning — switch models to enable.'

  const engaged = on && busy // a live ultracode turn → the star's halo breathes

  const handleClick = (): void => {
    if (!supported) return
    if (!on) setArming(true) // off→on: play the one-shot ripple
    void setUltracode(!on)
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-pressed={on}
      aria-disabled={!supported}
      title={title}
      className={`flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
        !supported
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
            supported ? (on ? 'text-effort-ultra' : 'text-dim') : 'text-faint'
          } ${engaged ? 'ultra-star-glow' : ''}`}
        >
          ✦
        </span>
        Ultra
      </span>
    </button>
  )
}
