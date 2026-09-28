import { useEffect, useState } from 'react'
import { Button } from './Button'
import { IconPlus } from './Icon'

// Module scope, so closing back to the welcome later in the same launch doesn't replay it.
let heroPlayed = false

export function resetHeroForTests(): void {
  heroPlayed = false
}

/** The welcome screen. The app mark draws in on the first welcome render of a launch; reduced
 *  motion shows the end state. */
export function Hero({
  onNew,
  onNewInDir,
  busy
}: {
  onNew: () => void
  onNewInDir: () => void
  busy: boolean
}): JSX.Element {
  // Read in the initializer and set in an effect: StrictMode keeps state across its re-run,
  // so the first mount's decision survives.
  const [play] = useState(() => !heroPlayed)
  useEffect(() => {
    heroPlayed = true
  }, [])

  return (
    <div data-ui="hero" className={`m-auto flex max-w-md flex-col items-center px-6 text-center ${play ? 'hero-play' : ''}`}>
      <HeroMark />
      <div className="hero-words flex flex-col items-center">
        <div className="mb-6 flex items-baseline gap-2.5">
          <span className="font-serif text-5xl font-semibold tracking-tight text-content">Clui</span>
          <span className="h-2.5 w-2.5 translate-y-[-6px] rounded-full bg-accent" aria-hidden="true" />
        </div>
        <p className="font-serif text-xl italic leading-snug text-dim">
          Drive Claude Code, visually.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-faint">
          A local window onto the <span className="font-mono text-dim">claude</span> CLI: your
          sessions, permissions, and tools, running side by side.
        </p>
      </div>
      <div className="hero-actions flex flex-col items-center">
        <Button variant="primary" size="lg" className="mt-7" onClick={onNew} busy={busy}>
          <IconPlus className="h-4 w-4" />
          New session
        </Button>
        {/* Ghost, so the New session button above stays the only accent button on this screen. */}
        <Button variant="ghost" size="md" className="mt-2" onClick={onNewInDir} busy={busy}>
          New session in a directory…
        </Button>
      </div>
    </div>
  )
}

/** The app icon's mark without its tile: the C, the terracotta bar in its mouth, the live dot.
 *  The viewBox is the three shapes' bounding box in icon.svg's inner coordinates. */
function HeroMark(): JSX.Element {
  return (
    <svg data-ui="hero-mark" className="hero-mark mb-6 h-16 w-auto" viewBox="345 331 564 589" aria-hidden="true">
      <path
        className="hero-c fill-content"
        d="M345 511A180 180 0 0 1 525 331H781A80 80 0 0 1 861 411V433A8 8 0 0 1 853 441H537A76 76 0 0 0 461 517V734A76 76 0 0 0 537 810H853A8 8 0 0 1 861 818V840A80 80 0 0 1 781 920H525A180 180 0 0 1 345 740Z"
      />
      <rect className="hero-bar fill-accent" x="811" y="493" width="98" height="268" rx="26" />
      {/* Fixed teal in both themes, as in the icon: the dot sits on the bar, so it contrasts against the bar. */}
      <circle className="hero-dot" cx="860" cy="700" r="29" style={{ fill: 'var(--teal-400)' }} />
    </svg>
  )
}
