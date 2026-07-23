/**
 * Composer chip toggling ultracode (X-High reasoning + dynamic-workflow orchestration)
 * for the active session — a live `apply_flag_settings {ultracode}` (no respawn).
 *
 * Decoupled from the effort picker (the `Workflow` tool is present at every effort
 * level, verified — ultracode isn't a launch-gated tool, so it's a plain live toggle).
 *
 * Visual grammar (per the combined-concept UX pass):
 *  - A PERSISTENT LEADING ✦ star (the CLI's ultracode signature — its statusline renders
 *    `(ultracode)*`). Dim when off, lit purple when on. Persistent so the OFF/discovery
 *    state still carries an identity mark like its neighbor chips (model/permission both
 *    lead with a glyph) — and so the chip's width never changes on toggle (the row is
 *    layout-shift-sensitive). Replaces the old arbitrary ◆ diamond.
 *  - ARMING: on the off→on activation, a one-shot RIPPLE_RAMP sweep (#3E1676→#8C50F0)
 *    crosses the "✦ Ultra" label via background-clip:text, then settles to the flat
 *    purple on-state. Fires on plain click/Enter (NOT press-and-hold — that has no
 *    keyboard equivalent, WCAG 2.1.1); the ceremony is watching it arm.
 *  - ENGAGED: while an ultracode turn is RUNNING (busy && on), the star's halo breathes
 *    (ultra-glow) — the one signal none of the generic busy cues carry ("this turn is the
 *    Ultra one"). Glow-only, high opacity floor → "energized", not "loading".
 *  - UNAVAILABLE on a non-X-High model: shown, disabled-with-reason via title +
 *    aria-disabled (stays in tab order; the disabled-button anti-pattern avoided).
 *
 * State is carried by color + fill + `aria-pressed` (never motion/glyph alone), so the
 * reduced-motion branch (global rule collapses both animations) loses nothing.
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
      {/* The label + leading star. During ARMING the whole run gets a RIPPLE_RAMP
          gradient clipped to the text; onAnimationEnd drops the arming class so the
          static token color takes over. */}
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
