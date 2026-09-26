/** 21500 → "21.5K", 200000 → "200K", 1000000 → "1M". */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${m % 1 === 0 ? m : m.toFixed(1)}M`
  }
  if (n >= 1000) {
    const k = n / 1000
    return `${k % 1 === 0 || k >= 100 ? Math.round(k) : k.toFixed(1)}K`
  }
  return String(n)
}
