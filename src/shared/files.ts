// What the guarded file reads return, in main and across IPC.

/** The most workspace files listed, so a huge repo can't flood the pickers or the IPC. */
export const WORKSPACE_FILE_CAP = 3000

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

/** One child of a listed directory. A symlink is never followed into, and isn't a folder here. */
export interface TreeEntry {
  name: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  /** Ignored by Git, or for a folder outside a repository, one of the usual build and dependency folders. */
  ignored: boolean
}

export interface TreeListing {
  ok: true
  entries: TreeEntry[]
  /** Every entry in the directory, counted up to a ceiling; above entries.length when the listing was capped. */
  total: number
  /** The count stopped at its ceiling: there are at least `total` entries. */
  totalCapped: boolean
}

/** One native context menu row. Only plain data crosses: main builds the items and returns the chosen id. */
export type ContextMenuItem = { type: 'normal'; id: string; label: string; enabled: boolean } | { type: 'separator' }
