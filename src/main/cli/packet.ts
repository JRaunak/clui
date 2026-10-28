/**
 * The trust boundary for a user message: the renderer's packet is checked, every reference re-validated against
 * the live file or page, and the text Claude reads built from the result. Nothing here writes to the CLI.
 */
import type { AnnotateTarget } from '../../shared/annotate'
import {
  CHANGE_REF,
  isDraftVisual,
  isRefInput,
  MAX_REFS,
  refKey,
  sentRefs,
  serializeContext,
  type ChangeSide,
  type ContextReference,
  type DraftReference,
  type LineRange,
  type RefFailure,
  type RefInvalid,
  type SourceVersion
} from '../../shared/context'
import { CHANGE_TEXT_BUDGET } from '../../shared/changes'
import type { Refusal } from '../../shared/files'
import type { DispatchResult, OutgoingPacket, WireAttachment } from '../../shared/ipc'
import { scrub } from '../browser/cdp'

export interface PacketDeps {
  cwd(handleId: string): string | null
  /** The file's content version and line count, as the File surface reads them. */
  readRevision(handleId: string, path: string): Promise<{ ok: true; version: SourceVersion; lineCount: number } | { ok: false; reason: Refusal['reason'] }>
  /** The hash of every byte, as an image reference records it. */
  byteVersion(handleId: string, path: string): Promise<{ ok: true; version: SourceVersion } | { ok: false; reason: Refusal['reason'] }>
  authorize(handleId: string, path: string, kind: 'file' | 'folder'): Promise<'ok' | 'missing' | 'denied'>
  /** The tab's current top-frame loaderId; null when the tab or its page is gone. */
  docOf(handleId: string, tab: number): Promise<string | null>
  secrets(handleId: string, tab: number): Set<string>
  /** A change ref passes only as this handle's draft or a grant its session owns. */
  change(handleId: string, ref: string): 'ok' | 'missing' | 'denied'
  /** Main's own record of what the ref selects, or null when it resolves to nothing. */
  changeOf(handleId: string, ref: string): { path: string; side: ChangeSide; old?: LineRange; new?: LineRange; bytes: number } | null
  /** The only way a change grant is made: called once the packet carrying `refs` is written. */
  activate(handleId: string, packetId: string, refs: readonly string[]): void
}

const ATTACH_MAX = 20
const NAME_MAX = 255
const REF_ID = /^r\d{1,9}$/
const BASE64 = /^[A-Za-z0-9+/]+=*$/
const IMAGE_TYPES = new Set<unknown>(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const b64 = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && BASE64.test(v)

function attachment(a: unknown): WireAttachment | null {
  if (!isObj(a)) return null
  switch (a.kind) {
    case 'image':
      return IMAGE_TYPES.has(a.mediaType) && b64(a.data) ? { kind: 'image', mediaType: a.mediaType as string, data: a.data } : null
    case 'document':
      return a.mediaType === 'application/pdf' && b64(a.data) ? { kind: 'document', mediaType: 'application/pdf', data: a.data } : null
    case 'text':
      return typeof a.name === 'string' && a.name.length <= NAME_MAX && typeof a.text === 'string' ? { kind: 'text', name: a.name, text: a.text } : null
    default:
      return null
  }
}

/** Anything not exactly the packet shape is refused whole. */
export function parseOutgoing(raw: unknown): OutgoingPacket | null {
  if (!isObj(raw) || typeof raw.text !== 'string' || typeof raw.now !== 'boolean') return null
  if (!Array.isArray(raw.refs) || raw.refs.length > MAX_REFS || !Array.isArray(raw.attachments) || raw.attachments.length > ATTACH_MAX) return null
  const ids = new Set<string>()
  const keys = new Set<string>()
  const refs: DraftReference[] = []
  for (const d of raw.refs as unknown[]) {
    if (!isObj(d) || !isObj(d.ref) || typeof d.ref.id !== 'string' || !REF_ID.test(d.ref.id) || !isRefInput(d.ref)) return null
    const ref = d.ref as unknown as ContextReference
    const key = refKey(ref)
    if (ids.has(ref.id) || keys.has(key)) return null
    ids.add(ref.id)
    keys.add(key)
    if (d.pinId !== undefined && !Number.isSafeInteger(d.pinId)) return null
    if (d.visual === undefined) refs.push({ ref })
    // A point carries no picture: a crop can't show which pixel was meant.
    else if ((ref.kind === 'browser' || ref.kind === 'page' || (ref.kind === 'image' && !!ref.region)) && isDraftVisual(d.visual)) refs.push({ ref, visual: d.visual })
    else return null
  }
  const attachments: WireAttachment[] = []
  for (const a of raw.attachments as unknown[]) {
    const ok = attachment(a)
    if (!ok) return null
    attachments.push(ok)
  }
  return { text: raw.text, refs, attachments, now: raw.now }
}

/** The reason a file read failure invalidates a selection. */
export function readFailure(reason: Refusal['reason']): 'missing' | 'denied' | 'changed' {
  return reason === 'missing' ? 'missing' : reason === 'denied' || reason === 'permission' ? 'denied' : 'changed'
}

/** One drop's worth; a longer list is refused whole. */
export const CLASSIFY_MAX = 256

/** The reference kind each dropped path would pass dispatch as, so a chip made from a drop is never refused at send. */
export async function classifyRefPaths(deps: Pick<PacketDeps, 'authorize'>, handleId: unknown, paths: unknown): Promise<('file' | 'folder' | null)[]> {
  if (typeof handleId !== 'string' || !Array.isArray(paths) || paths.length > CLASSIFY_MAX || !paths.every((p) => typeof p === 'string')) return []
  return Promise.all(
    paths.map(async (p: string) =>
      (await deps.authorize(handleId, p, 'file')) === 'ok' ? 'file' : (await deps.authorize(handleId, p, 'folder')) === 'ok' ? 'folder' : null
    )
  )
}

/** Per change ref, whether this handle can still read it. A malformed ref is false; a malformed list gets []. The reply
 *  carries no text, path or locator. */
export function changeRefStatus(deps: Pick<PacketDeps, 'change'>, handleId: unknown, refs: unknown): boolean[] {
  if (typeof handleId !== 'string' || !Array.isArray(refs) || refs.length > MAX_REFS) return []
  return refs.map((r: unknown) => typeof r === 'string' && CHANGE_REF.test(r) && deps.change(handleId, r) === 'ok')
}

/** Every ref that no longer points at what the user picked. Each file or tab is read once. */
export async function validateRefs(deps: PacketDeps, handleId: string, refs: readonly Pick<DraftReference, 'ref'>[]): Promise<RefInvalid[]> {
  const memo = new Map<string, Promise<unknown>>()
  const once = <T>(key: string, f: () => Promise<T>): Promise<T> => {
    let p = memo.get(key)
    if (!p) memo.set(key, (p = f()))
    return p as Promise<T>
  }
  const check = async (ref: ContextReference): Promise<RefFailure | null> => {
    switch (ref.kind) {
      case 'file': {
        // A whole file points at current content, so only losing access to it matters; Claude's tools report a missing one.
        if (!ref.lines) return (await once(`a\0${ref.path}`, () => deps.authorize(handleId, ref.path, 'file'))) === 'denied' ? 'denied' : null
        const r = await once(`r\0${ref.path}`, () => deps.readRevision(handleId, ref.path))
        if (!r.ok) return readFailure(r.reason)
        if (r.version !== ref.sourceVersion) return 'changed'
        return ref.lines.end > r.lineCount ? 'out-of-range' : null
      }
      case 'folder':
        return (await once(`d\0${ref.path}`, () => deps.authorize(handleId, ref.path, 'folder'))) === 'denied' ? 'denied' : null
      case 'browser': {
        const { tabId, docId } = ref.pin.source
        const doc = await once(`b\0${tabId}`, () => deps.docOf(handleId, tabId))
        return doc === null ? 'closed' : doc !== docId ? 'navigated' : null
      }
      // ponytail: only the page file is checked. An asset changed while no view is mounted goes unseen; record asset identities at pick if that must count
      case 'page': {
        const r = await once(`r\0${ref.path}`, () => deps.readRevision(handleId, ref.path))
        if (!r.ok) return readFailure(r.reason)
        return r.version === ref.revision ? null : 'changed'
      }
      case 'change': {
        const r = deps.change(handleId, ref.changeRef)
        return r === 'ok' ? null : r
      }
      case 'image': {
        const r = await once(`b\0${ref.path}`, () => deps.byteVersion(handleId, ref.path))
        if (!r.ok) return readFailure(r.reason)
        return r.version === ref.sourceVersion ? null : 'changed'
      }
      default:
        return ref satisfies never
    }
  }
  const reasons = await Promise.all(refs.map((d) => check(d.ref)))
  return refs.flatMap((d, i) => {
    const reason = reasons[i]
    return reason ? [{ id: d.ref.id, reason }] : []
  })
}

// Secrets learned after the pick (a later autofill) are scrubbed too.
function rescrubbed(t: AnnotateTarget, secrets: Set<string>): AnnotateTarget {
  if (!secrets.size) return t
  return { ...t, name: scrub(t.name, secrets), text: scrub(t.text, secrets), html: scrub(t.html, secrets), url: scrub(t.url, secrets) }
}

const attr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function block(a: WireAttachment): unknown {
  switch (a.kind) {
    case 'image':
      return { type: 'image', source: { type: 'base64', media_type: a.mediaType, data: a.data } }
    case 'document':
      return { type: 'document', source: { type: 'base64', media_type: a.mediaType, data: a.data } }
    case 'text':
      // A text file rides as a paste in a named wrapper, which transcript recovery reads back as a chip.
      return { type: 'text', text: `<file name="${attr(a.name)}">\n${a.text}\n</file>` }
  }
}

/** The CLI message content for `p`, with `uuid` as its packetId. No attachments and no crops: a plain string. */
export async function preparePacket(
  deps: PacketDeps,
  handleId: string,
  p: OutgoingPacket,
  uuid: string
): Promise<{ ok: true; content: string | unknown[]; text: string; onWritten?: () => void } | Extract<DispatchResult, { ok: false }>> {
  const invalid = await validateRefs(deps, handleId, p.refs)
  if (invalid.length) return { ok: false, reason: 'stale', invalid }
  const changes = p.refs.flatMap((d) => (d.ref.kind === 'change' ? [d.ref.changeRef] : []))
  // The renderer caps this at attach; a packet past it is a renderer bug, never sent.
  if (changes.reduce((n, ref) => n + (deps.changeOf(handleId, ref)?.bytes ?? 0), 0) > CHANGE_TEXT_BUDGET) return { ok: false, reason: 'invalid' }
  const refs = p.refs.map((d): DraftReference => {
    // The model reads the path and lines from main's record, never the renderer's copy of them.
    if (d.ref.kind === 'change') {
      const c = deps.changeOf(handleId, d.ref.changeRef)
      return c ? { ...d, ref: { id: d.ref.id, kind: 'change', changeRef: d.ref.changeRef, path: c.path, side: c.side, ...(c.old ? { old: c.old } : {}), ...(c.new ? { new: c.new } : {}), ...(d.ref.note === undefined ? {} : { note: d.ref.note }) } } : d
    }
    if (d.ref.kind !== 'browser') return d
    const { pin } = d.ref
    return { ...d, ref: { ...d.ref, pin: { ...pin, target: rescrubbed(pin.target, deps.secrets(handleId, pin.source.tabId)) } } }
  })
  let text: string
  try {
    text = serializeContext(sentRefs(refs, deps.cwd(handleId)), p.text, { packetId: uuid })
  } catch {
    return { ok: false, reason: 'invalid' }
  }
  const onWritten = changes.length ? { onWritten: () => deps.activate(handleId, uuid, changes) } : {}
  const visuals = refs.flatMap((d) => (d.visual ? [block({ kind: 'image', mediaType: d.visual.mimeType, data: d.visual.data })] : []))
  const content = [...visuals, ...p.attachments.map(block)]
  if (!content.length) return { ok: true, content: text, text, ...onWritten }
  if (text) content.push({ type: 'text', text })
  return { ok: true, content, text, ...onWritten }
}
