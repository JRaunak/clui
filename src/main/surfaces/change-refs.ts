/**
 * Change references: a draft per minted selection, and a grant per one a written message carried. Memory only, so
 * a reference from an earlier launch reads as unavailable. A grant belongs to owner keys, a handle's CLI session
 * id once known, else `handle:<id>`; a handle resolves only grants its key owns.
 */
import { randomBytes } from 'node:crypto'
import type { HunkRows } from '../../shared/changes'
import type { ChangeSide, LineRange } from '../../shared/context'

export interface Locator {
  /** Absolute, display only. */
  path: string
  /** Cwd-relative when inside the session cwd at mint, else absolute. */
  label: string
  segmentId: string
  revision: string
  hunkId: string
  side: ChangeSide
  rows?: HunkRows
  old?: LineRange
  new?: LineRange
  /** The exact change_read body, <= CHANGE_BYTES_MAX. */
  text: string
  /** UTF-8 bytes of `text`. */
  bytes: number
}
export interface Grant extends Locator {
  ref: string
  packetId: string
  at: number
}

interface Entry extends Grant { owners: Set<string> }
interface Handle {
  key: string
  quick: boolean
  available: boolean | null
  /** Insertion order is age, so the first is the one to evict. */
  drafts: Map<string, Locator>
}

const DRAFTS_MAX = 256
const QUICK_MAX = 256
const GRANTS_MAX = 4000
// Memory only, so the text total is what bounds the registry: 4,000 grants at the 32 KiB body cap would hold 125 MiB.
const GRANT_BYTES_MAX = 16 << 20

const selectionKey = (l: Locator): string => [l.revision, l.hunkId, l.side, l.rows ? `${l.rows.start}-${l.rows.end}` : ''].join('\0')

export class ChangeRefs {
  private handles = new Map<string, Handle>()
  /** Oldest activation first. */
  private grants = new Map<string, Entry>()
  private now: () => number

  constructor(now = Date.now) {
    this.now = now
  }

  track(handleId: string, o: { quick: boolean; sessionId: string | null; forkOf?: string }): void {
    const key = !o.quick && o.sessionId ? o.sessionId : `handle:${handleId}`
    this.handles.set(handleId, { key, quick: o.quick, available: null, drafts: new Map() })
    // A fork's prefix is the source's whole history now, so it inherits exactly what the source owns now.
    if (o.forkOf) for (const g of this.grants.values()) if (g.owners.has(o.forkOf)) g.owners.add(key)
  }

  bind(handleId: string, sessionId: string): void {
    const h = this.handles.get(handleId)
    if (!h || h.quick || h.key === sessionId) return
    for (const g of this.grants.values()) {
      if (!g.owners.delete(h.key)) continue
      g.owners.add(sessionId)
    }
    h.key = sessionId
  }

  setAvailable(handleId: string, ok: boolean): void {
    const h = this.handles.get(handleId)
    if (h) h.available = ok
  }

  /** Null before the session's first init. */
  available(handleId: string): boolean | null {
    return this.handles.get(handleId)?.available ?? null
  }

  /** The selection's ref, the one already minted or granted for it when there is one. Null for an untracked handle. */
  mint(handleId: string, loc: Locator): string | null {
    const h = this.handles.get(handleId)
    if (!h) return null
    const k = selectionKey(loc)
    for (const [ref, d] of h.drafts) if (selectionKey(d) === k) return ref
    for (const g of this.grants.values()) if (g.owners.has(h.key) && selectionKey(g) === k) return g.ref
    // Random, never derived from the selection, so holding the content never yields the ref.
    const ref = `chg_${randomBytes(16).toString('hex')}`
    h.drafts.set(ref, loc)
    if (h.drafts.size > DRAFTS_MAX) h.drafts.delete(h.drafts.keys().next().value!)
    return ref
  }

  check(handleId: string, ref: string): 'ok' | 'missing' | 'denied' {
    const h = this.handles.get(handleId)
    if (!h) return 'missing'
    if (h.available === false) return 'denied'
    return h.drafts.has(ref) || this.owned(h, ref) ? 'ok' : 'missing'
  }

  /** The draft or owned grant the ref resolves to through this handle. */
  locator(handleId: string, ref: string): Locator | null {
    const h = this.handles.get(handleId)
    return h ? (h.drafts.get(ref) ?? this.owned(h, ref) ?? null) : null
  }

  /** Runs only once the message carrying `refs` is written. */
  activate(handleId: string, packetId: string, refs: readonly string[]): void {
    const h = this.handles.get(handleId)
    if (!h) return
    for (const ref of refs) {
      const prev = this.owned(h, ref)
      const loc = h.drafts.get(ref) ?? prev
      if (!loc) continue
      h.drafts.delete(ref)
      // Re-inserted, so the map stays in activation order.
      this.grants.delete(ref)
      this.grants.set(ref, { ...loc, ref, packetId, at: this.now(), owners: prev?.owners ?? new Set([h.key]) })
    }
    if (h.quick) {
      const mine = [...this.grants.values()].filter((g) => g.owners.has(h.key))
      for (const g of mine.slice(0, Math.max(0, mine.length - QUICK_MAX))) this.disown(g, h.key)
    }
    let total = 0
    for (const g of this.grants.values()) total += g.bytes
    for (const [ref, g] of this.grants) {
      if (this.grants.size <= GRANTS_MAX && total <= GRANT_BYTES_MAX) break
      this.grants.delete(ref)
      total -= g.bytes
    }
  }

  resolve(handleId: string, ref: string): Grant | null {
    const h = this.handles.get(handleId)
    const g = h ? this.owned(h, ref) : null
    if (!g) return null
    const { owners: _, ...grant } = g
    return grant
  }

  /** Process exit or Stop. A bound normal session's grants stay for a resume in this launch. */
  dispose(handleId: string): void {
    const h = this.handles.get(handleId)
    if (!h) return
    this.handles.delete(handleId)
    if (h.key !== `handle:${handleId}`) return
    for (const g of [...this.grants.values()]) this.disown(g, h.key)
  }

  deleteSession(sessionId: string): void {
    for (const g of [...this.grants.values()]) this.disown(g, sessionId)
  }

  private owned(h: Handle, ref: string): Entry | null {
    const g = this.grants.get(ref)
    return g?.owners.has(h.key) ? g : null
  }

  private disown(g: Entry, key: string): void {
    if (g.owners.delete(key) && !g.owners.size) this.grants.delete(g.ref)
  }
}
