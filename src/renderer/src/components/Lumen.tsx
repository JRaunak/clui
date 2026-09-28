import { useEffect, useState } from 'react'

/**
 * The working light. Its parent must be `relative` and sized like the bead it lights; the CSS centres it.
 * With `lit`, it stays mounted for one exit fade after `lit` turns false, then unmounts, so nothing keeps
 * animating once the work stops.
 */
export function Lumen({ lit = true, className = '' }: { lit?: boolean; className?: string }): JSX.Element | null {
  const [present, setPresent] = useState(lit)
  useEffect(() => {
    if (lit) {
      setPresent(true)
      return
    }
    // Matches the --dur-fast exit fade in styles.css.
    const t = setTimeout(() => setPresent(false), 150)
    return () => clearTimeout(t)
  }, [lit])
  if (!lit && !present) return null
  return <span className={`lumen ${lit ? '' : 'lumen-out'} ${className}`} aria-hidden="true" data-ui="lumen" />
}
