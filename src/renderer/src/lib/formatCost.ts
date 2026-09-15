/** e.g. $0.0032, $0.14, $2.10. Extra precision only below a cent, where 2dp would round a
 *  real charge to $0.00. Shared by the cumulative footer and the per-turn usage trailer so
 *  the two can't drift apart. */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}
