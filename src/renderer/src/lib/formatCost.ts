/** Extra precision only below a cent, where 2dp would round a real charge to $0.00. Shared
 *  by the footer and per-turn trailer so they can't drift. */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}
