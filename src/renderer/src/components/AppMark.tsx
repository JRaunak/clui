/** The app icon's mark without its tile: the C, the terracotta bar in its mouth, the live dot.
 *  The viewBox is the three shapes' bounding box in icon.svg's inner coordinates. The hero-*
 *  classes only animate under `.hero-play`, so anywhere else the mark is static. */
export function AppMark({ className = '' }: { className?: string }): JSX.Element {
  return (
    <svg data-ui="app-mark" className={`hero-mark h-16 w-auto ${className}`} viewBox="345 331 564 589" aria-hidden="true">
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
