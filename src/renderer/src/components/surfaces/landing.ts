/** The first item belonging to line `start`: its chips and Claude's pointed row come before the line itself. Line 1
 *  starts at 0 so the big/notice/banner/created items above it stay in view. */
export const firstItemOf = (lineIndex: ArrayLike<number>, start: number, count: number): number => {
  const n = Math.max(1, Math.min(count, start))
  return n > 1 ? (lineIndex[n - 1] ?? 0) + 1 : 0
}
