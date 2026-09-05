/**
 * Newline-delimited JSON parsing for a streaming stdout pipe.
 *
 * The CLI writes one JSON object per line, but chunks arriving on the pipe do not
 * respect line boundaries: a chunk may contain several lines plus a partial line,
 * or split a single line across chunks. This buffers the remainder between pushes
 * and only emits fully-parsed objects.
 */
/** Ceiling for a single unterminated line's buffer. A real CLI JSON line is at most a
 *  few MB (a big tool result); past this it's runaway/garbage, so drop it rather than let
 *  one newline-less stream grow memory without bound. */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024

export class NdjsonParser {
  private buffer = ''

  /** Malformed lines are skipped: the CLI occasionally interleaves non-JSON. */
  push(chunk: string): unknown[] {
    this.buffer += chunk
    // No newline in a buffer this large = a runaway partial; discard it (a later newline
    // resyncs the stream) instead of accumulating unbounded.
    if (this.buffer.length > MAX_BUFFER_BYTES && !this.buffer.includes('\n')) this.buffer = ''
    const out: unknown[] = []
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        out.push(JSON.parse(trimmed))
      } catch {
        // Skip non-JSON / partial noise defensively.
      }
    }
    return out
  }

  flush(): unknown[] {
    const trimmed = this.buffer.trim()
    this.buffer = ''
    if (!trimmed) return []
    try {
      return [JSON.parse(trimmed)]
    } catch {
      return []
    }
  }
}
