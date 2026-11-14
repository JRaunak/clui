/** Two decimals, or four when any nonzero figure shown with it is under a cent, where 2dp would round a real charge
 *  to $0.00. `group` is every cost in one displayed column, so the column keeps one precision. */
export function formatCost(usd: number, group: readonly number[] = [usd]): string {
  return `$${usd.toFixed(group.some((v) => v > 0 && v < 0.01) ? 4 : 2)}`
}
