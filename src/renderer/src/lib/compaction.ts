/**
 * Context-compaction thresholds — the single source of truth shared by the ContextRing
 * markers and the in-chat compact suggestion (so they never disagree).
 *
 * The CLI auto-compacts at ~`window − 33K` resident tokens (verified from the binary:
 * effective limit = window − min(maxOutput,20K), then −13K) → ~96.7% on 1M, ~83.5% on
 * 200K. It's window-dependent, not a flat %.
 *
 * The manual-compaction SUGGESTION uses a **window-class threshold** (user decision):
 *   1M window  → offer at 90%  (~67K runway ≈ 2–3 turns before auto-compact)
 *   200K window → offer at 70% (~27K runway ≈ 1.5–2 turns; refuted 75% as too-late)
 * A flat % is used per class (not a runway rule) because the user wants predictable,
 * legible trigger points; the two numbers are tuned so each leaves usable lead time.
 */

/** The reserve the CLI keeps below the window before auto-compacting (tokens). */
const AUTO_COMPACT_RESERVE = 33_000

/** Auto-compact trigger as a percent (0–100) of the window — window-dependent. */
export function autoCompactPercent(window: number): number {
  const trigger = Math.max(0, window - AUTO_COMPACT_RESERVE)
  return Math.min(100, Math.round((trigger / window) * 1000) / 10) // 1 decimal (96.7)
}

/** The percent at which the manual-compaction suggestion first appears, by window class.
 *  1M-class (>500K) → 90%; smaller (200K etc.) → 70%. */
export function suggestCompactPercent(window: number): number {
  return window > 500_000 ? 90 : 70
}

/**
 * Decide whether (and how loudly) to show the compact suggestion for the current fill.
 * Returns null to hide it. `tone: 'info'` = first offer (calm advisory); `tone: 'warn'`
 * = the single "last-call" re-arm near auto-compact (louder, dismiss-once-more).
 *
 * `dismissedAtRunway` is the runway (tokens-until-auto-compact) at the user's last
 * dismissal this cycle, or null. Logic:
 *  - below the class threshold → hidden (and the caller resets dismissedAtRunway to null).
 *  - at/above threshold, not dismissed → show INFO.
 *  - dismissed, but runway has since shrunk to the last-call band (≤ half the initial
 *    offer runway, floored at ~20K) → show WARN once. A second dismiss silences it.
 */
export function compactSuggestion(
  percent: number | null,
  usedTokens: number | null,
  window: number | null,
  dismissedAtRunway: number | null
): { tone: 'info' | 'warn'; autoPercent: number; runwayTokens: number } | null {
  if (percent == null || usedTokens == null || !window) return null
  const threshold = suggestCompactPercent(window)
  if (percent < threshold) return null // below trigger → not offered (caller resets dismiss)

  const auto = autoCompactPercent(window)
  const autoTokens = Math.round((auto / 100) * window)
  const runway = Math.max(0, autoTokens - usedTokens) // tokens until auto-compact
  // Last-call band: half the runway the user had at the FIRST offer, floored so tiny
  // windows still get a re-arm. (Initial offer runway ≈ (auto − threshold)% of window.)
  const initialRunway = ((auto - threshold) / 100) * window
  const lastCall = Math.max(20_000, initialRunway / 2)

  if (dismissedAtRunway == null) return { tone: 'info', autoPercent: auto, runwayTokens: runway }
  // Dismissed: re-appear once when runway has shrunk into the last-call band, and only
  // if we haven't already dismissed AT that lower level (dismissedAtRunway > lastCall).
  if (runway <= lastCall && dismissedAtRunway > lastCall) {
    return { tone: 'warn', autoPercent: auto, runwayTokens: runway }
  }
  return null // dismissed and either not yet at last-call, or last-call already dismissed
}
