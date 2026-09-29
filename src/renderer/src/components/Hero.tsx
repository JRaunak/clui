import { useEffect, useState } from 'react'
import { Button } from './Button'
import { IconPlus } from './Icon'
import { AppMark } from './AppMark'

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
      <AppMark className="mb-6" />
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
