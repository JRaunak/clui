/**
 * In-chat compact suggestion. When context nears the
 * auto-compact point, a quiet advisory row appears at the TAIL of the transcript,
 * like an assistant aside, NOT sticky composer chrome (user's explicit pick). It reads
 * as Claude advising you, offers manual `/compact` on your terms, and is dismissible.
 *
 * Trigger + dismiss logic lives in `lib/compaction.ts` (shared with the ContextRing so
 * they never disagree): 90% on 1M / 70% on 200K, re-arming ONCE near auto-compact.
 *
 * Framing is SOFT: `/compact` only shrinks the model's context; the transcript here +
 * the on-disk jsonl survive (verified). So: info-blue base, escalate to amber for the
 * one "last-call" re-arm, NEVER red (red in-transcript reads as "something broke").
 * Copy states the model's REAL auto-compact % (never a constant). Accent-scarcity: the
 * action button is info-blue-tinted (never terracotta/purple); Dismiss is a ghost.
 */
import { useActive, useSession } from '../store'
import { compactSuggestion } from '../lib/compaction'

/** 120000 → "120K", 17000 → "17K". */
function fmtK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}K` : String(n)
}

export function CompactSuggestion(): JSX.Element | null {
  const percent = useActive((s) => s?.contextPercent ?? null)
  const tokens = useActive((s) => s?.contextTokens ?? null)
  const window = useActive((s) => s?.contextWindow ?? null)
  const dismissedAtRunway = useActive((s) => s?.compactDismissedAtRunway ?? null)
  const busy = useActive((s) => s?.busy ?? false)
  const sendMessage = useSession((s) => s.sendMessage)
  const dismiss = useSession((s) => s.dismissCompactSuggestion)

  const sug = compactSuggestion(percent, tokens, window, dismissedAtRunway)
  // Hide while a turn is streaming: the tail is owned by WorkingStatus then, and
  // firing /compact mid-turn is nonsensical. It reappears once the turn settles.
  if (!sug || busy) return null

  const warn = sug.tone === 'warn'
  // info-blue base → amber for the last-call re-arm. Tokens only (never red).
  const tone = warn ? 'warn' : 'info'
  const border = warn ? 'border-warn/40' : 'border-info/40'
  const accentText = warn ? 'text-warn' : 'text-info'
  const btnTint = warn
    ? 'border-warn/50 text-warn hover:bg-warn/10'
    : 'border-info/50 text-info hover:bg-info/10'

  const runway = fmtK(sug.runwayTokens)
  // Human-facing prose gets a rounded threshold ("near 97%"): the one-decimal
  // 96.7 reads as machine false-precision next to the approximating word "near".
  // The exact value still lives on the ContextRing tooltip.
  const autoPct = Math.round(sug.autoPercent)

  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-col gap-2 border-l pl-3.5 ${border}`}
    >
      <div className="text-sm leading-relaxed text-dim">
        {warn ? (
          <>
            <span className={`font-medium ${accentText}`}>About to auto-compact</span> — context is{' '}
            <span className="text-content">{percent}% full</span> ({runway} tokens left before I
            summarize near {autoPct}%). Compact now to keep control of the timing — your
            transcript here stays intact.
          </>
        ) : (
          <>
            Context is <span className="text-content">{percent}% full</span>. I'll auto-compact near{' '}
            {autoPct}%, or you can compact now to free up room — older messages get
            summarized, but your transcript here stays intact.
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void sendMessage('/compact')}
          className={`rounded-md border px-3 py-1 text-xs font-semibold transition-colors ${btnTint}`}
        >
          Compact now
        </button>
        <button
          type="button"
          onClick={dismiss}
          className="rounded-md px-3 py-1 text-xs font-medium text-dim transition-colors hover:text-content"
        >
          Dismiss
        </button>
      </div>
    </div>
  )
}
