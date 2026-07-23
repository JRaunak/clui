/**
 * Robust newline-delimited JSON parsing for a streaming stdout pipe.
 *
 * The CLI writes one JSON object per line, but chunks arriving on the pipe do not
 * respect line boundaries: a chunk may contain several lines plus a partial line,
 * or split a single line across chunks. This buffers the remainder between pushes
 * and only emits fully-parsed objects.
 */
export class NdjsonParser {
  private buffer = ''

  /**
   * Feed a raw stdout chunk; returns the JSON objects that became complete.
   * Malformed lines are skipped (the CLI occasionally interleaves non-JSON).
   */
  push(chunk: string): unknown[] {
    this.buffer += chunk
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

  /** Flush any trailing buffered line at stream end (if it's valid JSON). */
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
