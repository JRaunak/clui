/**
 * Three bouncing dots — the chat-app "typing" convention, reused wherever we
 * signal indeterminate assistant activity (Claude thinking, a tool running).
 * A learned, recognition-not-recall pattern; no background. Staggered so the
 * bounce reads as a wave. Honors prefers-reduced-motion via the global rule.
 */
export function TypingDots({ className = '' }: { className?: string }): JSX.Element {
  return (
    <span className={`inline-flex items-end gap-[3px] ${className}`} aria-label="Working" role="status">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block h-1.5 w-1.5 rounded-full bg-current"
          style={{ animation: 'typing-bounce 1.2s ease-in-out infinite', animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </span>
  )
}
