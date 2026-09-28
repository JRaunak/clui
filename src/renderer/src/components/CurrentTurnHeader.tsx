import { useSession } from '../store'
import { IconArrowUp } from './Icon'

/** One-line "you asked" reminder for a long reply, on the top band's glass. Its parent keys it by
 *  prompt id, so each new turn fades in once. */
export function CurrentTurnHeader(): JSX.Element | null {
  const ct = useSession((s) => s.currentTurn)
  const requestScrollTo = useSession((s) => s.requestScrollTo)
  if (!ct) return null
  const line = ct.text.split('\n')[0]
  return (
    <button
      type="button"
      data-ui="current-turn-header"
      className="slot-in group flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left [-webkit-app-region:no-drag] focus-visible:outline-offset-[-2px] pointer-fine:hover:bg-[var(--glass-row-hover)]"
      title={ct.text}
      aria-label={`Jump to your prompt, turn ${ct.turn}: ${line}`}
      onClick={() => requestScrollTo(ct.messageId, { align: 'start' })}
    >
      <span className="shrink-0 text-meta text-dim">You</span>
      <span className="min-w-0 truncate text-ui text-content">{line}</span>
      <span className="flex-1" aria-hidden="true" />
      <IconArrowUp className="hidden h-3.5 w-3.5 shrink-0 text-dim pointer-fine:group-hover:block group-focus-visible:block" />
      <span className="shrink-0 text-meta tabular-nums text-dim">Turn {ct.turn}</span>
    </button>
  )
}
