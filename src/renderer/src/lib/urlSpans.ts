const URL_RE = /https?:\/\/[^\s<>"'`]+/g

/** A URL as printed, minus sentence punctuation after it and a closing paren it didn't open. */
function trimUrl(raw: string): string {
  let url = raw.replace(/[.,;:!?'"]+$/, '')
  while (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1)
  return url
}

/** The http(s) URLs in plain text. One that a truncation cut off is left out, since it would lead nowhere. */
export function urlSpans(text: string, truncated: boolean): { start: number; end: number; url: string }[] {
  const out: { start: number; end: number; url: string }[] = []
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0])
    const start = m.index ?? 0
    const end = start + url.length
    if (truncated && end >= text.length - 1) break
    out.push({ start, end, url })
  }
  return out
}
