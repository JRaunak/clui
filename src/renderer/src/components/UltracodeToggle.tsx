/**
 * Ultracode toggle for the active session (X-High reasoning + dynamic workflows).
 * Visual grammar: persistent ✦ star (dim off, lit purple on), one-shot ripple on
 * activation, star halo breathes during a busy ultracode turn (the one busy cue
 * generic indicators don't carry). State by color + fill + aria-pressed, never
 * motion alone (reduced-motion loses nothing). Disabled on non-X-High models
 * (shown, aria-disabled, title explains why).
 */
import { useEffect, useId, useRef, useState } from 'react'
import { useActive, useSession } from '../store'
import { supportsUltracodeToggle } from '../../../shared/settings'

export function UltracodeToggle(): JSX.Element | null {
  const model = useActive((s) => s?.modelChoice ?? null)
  const on = useActive((s) => s?.ultracode ?? false)
  const busy = useActive((s) => s?.busy ?? false)
  const setUltracode = useSession((s) => s.setUltracode)
  const [arming, setArming] = useState(false)
  const [tip, setTip] = useState(false)
  // Second flag so the tooltip mounts at opacity-0 then transitions to 1 (an element can't
  // transition from its own initial paint without a reflow between the two states).
  const [tipShown, setTipShown] = useState(false)
  const tooltipId = useId()
  // Track the previous `on` so we only fire the arm sweep on a true off→on edge (not on
  // mount-while-on, e.g. resuming an ultra session, and not on on→off).
  const prevOn = useRef(on)
  useEffect(() => {
    prevOn.current = on
  }, [on])
  useEffect(() => {
    if (!tip) {
      setTipShown(false)
      return
    }
    const id = requestAnimationFrame(() => setTipShown(true))
    return () => cancelAnimationFrame(id)
  }, [tip])

  if (model === null) return null

  const supported = supportsUltracodeToggle(model)
  const tipCopy = !supported
    ? 'Ultra runs only on models with X-High reasoning. Pick one to enable it.'
    : on
      ? 'Ultra is on. X-High reasoning with multi-step workflows, this session only.'
      : 'X-High reasoning with multi-step workflows, for this session.'

  const engaged = on && busy // a live ultracode turn → the star's halo breathes

  const handleClick = (): void => {
    if (!supported) return
    if (!on) setArming(true) // off→on: play the one-shot ripple
    void setUltracode(!on)
  }

  return (
    <div className="relative flex">
      <button
        type="button"
        onClick={handleClick}
        aria-pressed={on}
        aria-disabled={!supported}
        aria-describedby={tip ? tooltipId : undefined}
        onMouseEnter={() => {
          if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) setTip(true)
        }}
        onMouseLeave={() => setTip(false)}
        onFocus={(e) => {
          if (e.currentTarget.matches(':focus-visible')) setTip(true)
        }}
        onBlur={() => setTip(false)}
        onKeyDown={(e) => {
          // Dismiss without blurring, and keep Escape from reaching any outer handler.
          if (e.key === 'Escape' && tip) {
            e.stopPropagation()
            setTip(false)
          }
        }}
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
      {tip && (
        <span
          role="tooltip"
          id={tooltipId}
          className={`pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 max-w-[240px] -translate-x-1/2 rounded-lg border border-border bg-bg-elev px-2.5 py-1.5 text-xs leading-snug text-content shadow-lg transition-opacity duration-[120ms] ease-out motion-reduce:transition-none ${
            tipShown ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {tipCopy}
        </span>
      )}
    </div>
  )
}
