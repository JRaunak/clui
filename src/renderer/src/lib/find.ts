/** Find's query as a case-insensitive pattern, matched against the text itself: lowercasing the text first would shift
 *  every offset after a character whose lowercase is longer, like `İ`. */
export const findRe = (q: string): RegExp => new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
