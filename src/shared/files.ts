// What the guarded file reads return, in main and across IPC.
import type { SourceVersion } from './context'
import type { ImageHead } from './imageHead'

/** The most workspace files listed, so a huge repo can't flood the pickers or the IPC. */
export const WORKSPACE_FILE_CAP = 3000

export interface Refusal {
  ok: false
  /** `permission` is the OS refusing Clui itself (EACCES/EPERM); `unreadable` is any other read failure.
   *  `too-broad` is an HTML page inside a session folder at or above home, which can't be a page's workspace. */
  reason: 'invalid' | 'denied' | 'missing' | 'wrong-type' | 'changed' | 'too-large' | 'limit' | 'unreadable' | 'permission' | 'unavailable' | 'too-broad'
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

/** A Markdown preview's image: a `clui-file:` URL for exactly that file, or why there's none. `outside`: not a file
 *  this session may read, so no request is made. */
export type ImageCap = { ok: true; url: string } | { ok: false; outside: boolean }
/** What main reads of an image before it's shown. `head` is null for an empty file; `version` is the hash of every byte,
 *  present only when the head says Clui shows it. */
export interface ImageInfo { ok: true; size: number; revision: string; head: ImageHead | null; version?: string }
/** An image tab's open: its info and, when it's shown, an exact-file cap bound to the bytes `version` hashed. */
export type ImageOpen = (Omit<ImageInfo, 'revision' | 'version'> & { cap?: { url: string; version: SourceVersion } }) | Refusal

/** The most bytes one read returns, so a renderer read can't make main hold a whole file. */
export const CHUNK_MAX = 4 * 1024 * 1024
/** What main reads of a PDF before pdf.js asks for ranges: its size and stat revision, and its first bytes. `head`
 *  is null for an empty file and one past the size Clui reads. */
export interface DocHead { ok: true; size: number; revision: string; head: Uint8Array | null }

/** Per mint, so one document can't hold an unbounded number of caps. */
export const IMAGE_PATHS_MAX = 1000

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
