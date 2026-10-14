// Pure helpers for highlighted code, shared by the renderer and the highlight worker.

export function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
}

/**
 * highlight.js HTML cut into one string per source line. A span open across a line break is
 * closed at the end of the line and reopened at the start of the next, so a multi-line string
 * or comment keeps its colour on every row.
 */
export function splitHighlightedLines(html: string): string[] {
  const out: string[] = []
  const open: string[] = []
  const re = /<span[^>]*>|<\/span>|\n/g
  let line = ''
  let at = 0
  for (let m = re.exec(html); m; m = re.exec(html)) {
    line += html.slice(at, m.index)
    at = re.lastIndex
    const tok = m[0]
    if (tok === '\n') {
      out.push(line + '</span>'.repeat(open.length))
      line = open.join('')
      continue
    }
    if (tok === '</span>') open.pop()
    else open.push(tok)
    line += tok
  }
  out.push(line + html.slice(at) + '</span>'.repeat(open.length))
  return out
}

/**
 * `<mark>`s around the text ranges [start, end) of a line's HTML, counted in characters of its
 * text (an entity is one). A mark crossing a tag closes before it and reopens after, so it nests.
 */
export function markHtml(html: string, ranges: [number, number][], active: number, cls: string, activeCls: string): string {
  if (!ranges.length) return html
  let out = ''
  let pos = 0
  let ri = 0
  let open = false
  const openTag = (): string => `<mark class="${ri === active ? activeCls : cls}">`
  for (const [tok] of html.matchAll(/<[^>]*>|&[^;<]+;|[^<&]/g)) {
    if (tok[0] === '<') {
      out += open ? `</mark>${tok}${openTag()}` : tok
      continue
    }
    if (!open && ri < ranges.length && pos === ranges[ri][0]) {
      out += openTag()
      open = true
    }
    out += tok
    pos++
    if (open && pos === ranges[ri][1]) {
      out += '</mark>'
      open = false
      ri++
    }
  }
  return open ? out + '</mark>' : out
}
