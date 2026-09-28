/**
 * Three dots that mark work in progress (a busy session row, a running tool). They hold still so they differ
 * from a single live dot by shape alone, even in grayscale. The Lumen carries the motion.
 */
export function TypingDots({ className = '' }: { className?: string }): JSX.Element {
  return (
    <span className={`inline-flex items-end gap-[3px] ${className}`} aria-label="Working" role="status">
      {[0, 1, 2].map((i) => (
        <span key={i} className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
      ))}
    </span>
  )
}
