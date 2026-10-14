// What the guarded file reads return, in main and across IPC.

export interface Refusal {
  ok: false
  /** `permission` is the OS refusing Clui itself (EACCES/EPERM); `unreadable` is any other read failure. */
  reason: 'invalid' | 'denied' | 'missing' | 'wrong-type' | 'changed' | 'too-large' | 'limit' | 'unreadable' | 'permission' | 'unavailable'
}

export interface TextRead {
  ok: true
  text: string
  size: number
  mtimeMs: number
  binary: boolean
  truncated: boolean
  /** Not valid UTF-8: `text` is empty rather than a lossy decode. */
  unsupportedEncoding: boolean
  /** Hash of the returned bytes, so a touch or a no-op rewrite keeps it. Not the metadata revision readBytes takes. */
  revision: string
}

export interface FileStat {
  ok: true
  type: 'file' | 'directory'
  size: number
  mtimeMs: number
  revision: string
}

/** A watched file may have changed; the consumer re-reads to find out. */
export interface FileChangedEvent {
  handleId: string
  id: string
}
