/**
 * Per-session Surfaces sidecar (`<userData>/session-surfaces.json`): a session's pane tabs, their
 * order and view state, and its browser tabs by id and address, read back on resume.
 *
 * Envelope `{ version: 1, sessions: { [cliSessionId]: SurfacesEntry } }`. Entries are validated
 * field by field both ways. One that fails reads as `corrupt` for its own session only and stays
 * on disk as it was until that session saves again. A file from a newer Clui is never rewritten.
 * File grants are not kept: an outside file is re-chosen by the user after a relaunch.
 */
import { app } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from '../lib/atomic'
import {
  SURFACE_TAB_CAP,
  surfaceIdOf,
  type SavedBrowser,
  type SavedSet,
  type SavedTab,
  type SurfaceViewState,
  type SurfacesEntry,
  type SurfacesRestore
} from '../../shared/surfaces'

const VERSION = 1
const BROWSER_TABS_MAX = 100
const PATH_MAX = 4096
const TEXT_MAX = 1024
const ID_MAX = 200
const URL_MAX = 8192
const EXPANDED_MAX = 200
const KINDS = ['tree', 'file', 'diff', 'image', 'doc', 'sheet', 'artifact'] as const
const OPENERS = ['user', 'claude', 'link', 'change'] as const
const MODES = ['auto', 'preview', 'source'] as const
const PLACEMENT = /^browser:[1-9]\d*$/

const sidecarPath = (): string => join(app.getPath('userData'), 'session-surfaces.json')

class Invalid extends Error {}
const fail = (): never => {
  throw new Invalid()
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const obj = (v: unknown): Record<string, unknown> => (isObj(v) ? v : fail())
const list = (v: unknown, max: number): unknown[] => (Array.isArray(v) && v.length <= max ? v : fail())
const str = (v: unknown, max: number): string => (typeof v === 'string' && v.length <= max && !v.includes('\0') ? v : fail())
const abs = (v: unknown): string => (str(v, PATH_MAX).startsWith('/') ? (v as string) : fail())
const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : fail())
const num = (v: unknown): number => Math.max(0, finite(v))
const int = (v: unknown): number => (Number.isSafeInteger(v) && (v as number) >= 1 ? (v as number) : fail())
const bool = (v: unknown): boolean => (typeof v === 'boolean' ? v : fail())
const oneOf = <T extends string>(v: unknown, all: readonly T[]): T => (all.includes(v as T) ? (v as T) : fail())
const zoom = <T extends string>(v: unknown, names: readonly T[]): number | T => (names.includes(v as T) ? (v as T) : num(v) || fail())
/** An optional field, present in the output only when it was in the input. */
const some = <K extends string, V>(key: K, v: unknown, read: (v: unknown) => V): { [P in K]?: V } =>
  (v === undefined ? {} : { [key]: read(v) }) as { [P in K]?: V }

/** http(s) without its userinfo, or a blank page. Anything else a tab could sit on reopens blank.
 *  Off-machine query and fragment go too: OAuth codes and magic-link tokens ride in them. */
export function cleanUrl(v: unknown): string {
  if (typeof v !== 'string' || v.length > URL_MAX) return 'about:blank'
  try {
    const u = new URL(v)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'about:blank'
    u.username = ''
    u.password = ''
    if (!['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
      u.search = ''
      u.hash = ''
    }
    return u.href
  } catch {
    return 'about:blank'
  }
}

function fileView(v: unknown): Extract<SurfaceViewState, { kind: 'file' }> {
  const o = obj(v)
  if (o.kind !== 'file') fail()
  return {
    kind: 'file',
    topLine: int(o.topLine),
    offsetPx: num(o.offsetPx),
    scrollLeft: num(o.scrollLeft),
    previewScrollTop: num(o.previewScrollTop),
    ...some('find', o.find, (x) => str(x, TEXT_MAX)),
    ...some('page', o.page, (x) => {
      const p = obj(x)
      return { x: num(p.x), y: num(p.y) }
    })
  }
}

function viewOf(v: unknown, kind: SavedTab['kind']): SurfaceViewState {
  const o = obj(v)
  if (o.kind !== kind) fail()
  const find = some('find', o.find, (x) => str(x, TEXT_MAX))
  const id = (x: unknown): string => str(x, ID_MAX)
  switch (kind) {
    case 'tree':
      return { kind, expanded: list(o.expanded, EXPANDED_MAX).map((x) => str(x, PATH_MAX)), scrollTop: num(o.scrollTop) }
    case 'file':
      return fileView(o)
    case 'diff':
      return { kind, ...some('path', o.path, abs), ...some('segmentId', o.segmentId, id), ...some('revision', o.revision, id), ...some('topHunk', o.topHunk, id), offsetPx: num(o.offsetPx), ...find }
    case 'image':
      return { kind, zoom: zoom(o.zoom, ['fit'] as const), panX: finite(o.panX), panY: finite(o.panY) }
    case 'doc':
      return { kind, page: int(o.page), zoom: zoom(o.zoom, ['fit-width', 'fit-page'] as const), offsetPx: num(o.offsetPx), ...find }
    case 'sheet':
      return { kind, ...some('sheet', o.sheet, (x) => str(x, TEXT_MAX)), topRow: num(o.topRow), leftCol: num(o.leftCol), rowOffset: num(o.rowOffset), colOffset: num(o.colOffset) }
    case 'artifact':
      return fail()
  }
}

function tabOf(v: unknown): SavedTab {
  const o = obj(v)
  const kind = oneOf(o.kind, KINDS)
  const tab: SavedTab = {
    id: str(o.id, PATH_MAX + ID_MAX),
    kind,
    key: kind === 'tree' || kind === 'diff' ? (o.key === '' ? '' : fail()) : abs(o.key),
    title: str(o.title, TEXT_MAX),
    openedBy: oneOf(o.openedBy, OPENERS),
    openedAt: num(o.openedAt),
    lastViewedAt: num(o.lastViewedAt),
    ...some('mode', o.mode, (x) => oneOf(x, MODES)),
    ...some('provenance', o.provenance, (x) => {
      const p = obj(x)
      return {
        sessionId: str(p.sessionId, ID_MAX),
        ...some('creatingEditId', p.creatingEditId, (y) => str(y, ID_MAX)),
        ...some('messageId', p.messageId, (y) => str(y, ID_MAX))
      }
    }),
    ...some('viewState', o.viewState, (x) => viewOf(x, kind)),
    ...some('sourceView', o.sourceView, fileView)
  }
  return tab.id === surfaceIdOf(tab) ? tab : fail()
}

function setOf(v: unknown): SavedSet {
  const o = obj(v)
  const raw = obj(o.tabs)
  const order = list(o.order, SURFACE_TAB_CAP + BROWSER_TABS_MAX).map((x) => str(x, PATH_MAX + ID_MAX))
  if (new Set(order).size !== order.length) fail()
  const tabs: Record<string, SavedTab> = {}
  for (const id of order) {
    if (PLACEMENT.test(id)) continue
    if (!Object.hasOwn(raw, id)) fail()
    const tab = tabOf(raw[id])
    tabs[id] = tab.id === id ? tab : fail()
  }
  const n = Object.keys(tabs).length
  if (n !== Object.keys(raw).length || n > SURFACE_TAB_CAP) fail()
  const active = o.active === null ? null : str(o.active, PATH_MAX + ID_MAX)
  return { order, active: active === null || order.includes(active) ? active : fail(), tabs }
}

function browserOf(v: unknown): SavedBrowser | null {
  if (v === null || v === undefined) return null
  const o = obj(v)
  const tabs = list(o.tabs, BROWSER_TABS_MAX).map((x) => {
    const t = obj(x)
    return { id: int(t.id), url: cleanUrl(t.url), lastViewedAt: num(t.lastViewedAt) }
  })
  // Open order is id order, and a new tab never reuses an id.
  if (tabs.some((t, i) => i > 0 && t.id <= tabs[i - 1].id)) fail()
  const nextId = int(o.nextId)
  if (tabs.length && nextId <= tabs[tabs.length - 1].id) fail()
  return { tabs, nextId, viewed: int(o.viewed) }
}

/** A session entry, or null when any field is out of shape. */
export function parseEntry(v: unknown): SurfacesEntry | null {
  try {
    const o = obj(v)
    return { set: setOf(o.set), browserTabs: browserOf(o.browserTabs), open: bool(o.open), full: bool(o.full) }
  } catch (e) {
    if (e instanceof Invalid) return null
    throw e
  }
}

type Disk = { kind: 'ok'; sessions: Record<string, unknown> } | { kind: 'newer' } | { kind: 'unreadable' } | { kind: 'garbled' }

async function readDisk(): Promise<Disk> {
  let raw: string
  try {
    raw = await readFile(sidecarPath(), 'utf8')
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'ok', sessions: {} } : { kind: 'unreadable' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'garbled' }
  }
  if (!isObj(parsed)) return { kind: 'garbled' }
  if (typeof parsed.version === 'number' && parsed.version > VERSION) return { kind: 'newer' }
  return parsed.version === VERSION && isObj(parsed.sessions) ? { kind: 'ok', sessions: parsed.sessions } : { kind: 'garbled' }
}

// Serialized so two sessions saving in the same tick can't read the same base and drop each other's entry.
let writeChain: Promise<void> = Promise.resolve()
function serialize<T>(run: () => Promise<T>): Promise<T> {
  const next = writeChain.then(run, run)
  writeChain = next.then(
    () => {},
    () => {}
  )
  return next
}

const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= ID_MAX

/** Queued behind pending writes, so a session closed and resumed at once reads what it just saved. */
export function loadSurfaces(sessionId: string): Promise<SurfacesRestore> {
  return serialize(async () => {
    if (!validId(sessionId)) return { status: 'none' }
    const disk = await readDisk()
    if (disk.kind === 'newer') return { status: 'newer' }
    // A file that can't be read or parsed at all leaves every session without its tabs.
    if (disk.kind !== 'ok') return { status: 'corrupt' }
    if (!Object.hasOwn(disk.sessions, sessionId)) return { status: 'none' }
    const entry = parseEntry(disk.sessions[sessionId])
    return entry ? { status: 'ok', entry } : { status: 'corrupt' }
  })
}

/** Replace or drop one session's entry. A garbled file holds nothing to keep, so it's replaced; an unreadable or newer one is left alone. */
function mutate(sessionId: string, next: (cur: unknown) => SurfacesEntry | null | undefined): Promise<void> {
  return serialize(async () => {
    const disk = await readDisk()
    if (disk.kind === 'newer' || disk.kind === 'unreadable') return
    const sessions = disk.kind === 'ok' ? disk.sessions : {}
    const cur = Object.hasOwn(sessions, sessionId) ? sessions[sessionId] : undefined
    const entry = next(cur)
    if (entry === undefined) return
    const out = { ...sessions }
    if (entry === null) delete out[sessionId]
    else out[sessionId] = entry
    await atomicWriteFile(sidecarPath(), JSON.stringify({ version: VERSION, sessions: out }))
  })
}

/** `keepBrowser` keeps the browser tabs already saved: a session without browser access mustn't erase them. */
function put(sessionId: string, entry: SurfacesEntry, keepBrowser: boolean): Promise<void> {
  return mutate(sessionId, (cur) => (keepBrowser ? { ...entry, browserTabs: parseEntry(cur)?.browserTabs ?? null } : entry)).catch((e: unknown) =>
    console.error('session-surfaces: save failed', e)
  )
}

/** Drop a session's entry (on permanent delete). */
export function deleteSurfaces(sessionId: string): Promise<void> {
  if (!validId(sessionId)) return Promise.resolve()
  return mutate(sessionId, (cur) => (cur === undefined ? undefined : null))
}

/** Resolves once every queued write has landed. */
export function flushSurfaces(): Promise<void> {
  return writeChain
}

interface Tracked {
  sessionId: string | null
  quick: boolean
  /** The latest save before the CLI named the session, written once it does. */
  early: SurfacesEntry | null
}
const tracked = new Map<string, Tracked>()

/**
 * Start routing a handle's saves. A resume knows its id up front; a new session or a fork learns
 * it at init. A fork's `seed` is its source's entry, so the copy lands under the new id even if
 * nothing changes before init. A Quick session never writes.
 */
export function trackSession(handleId: string, opts: { quick: boolean; sessionId: string | null; seed: SurfacesEntry | null }): void {
  tracked.set(handleId, { sessionId: opts.quick ? null : opts.sessionId, quick: opts.quick, early: opts.seed })
}

export function bindSession(handleId: string, sessionId: string): void {
  const t = tracked.get(handleId)
  if (!t || t.quick || t.sessionId === sessionId || !validId(sessionId)) return
  t.sessionId = sessionId
  const early = t.early
  t.early = null
  if (early) void put(sessionId, early, false)
}

/**
 * One session's pane state from the renderer, with main's own browser records. `browser` is undefined
 * for a session running without the browser, which keeps the tabs saved before.
 */
export function saveSession(handleId: string, save: unknown, browser: SavedBrowser | null | undefined): Promise<void> {
  const t = tracked.get(handleId)
  if (!t || t.quick || !isObj(save)) return Promise.resolve()
  const entry = parseEntry({ set: save.set, open: save.open, full: save.full, browserTabs: browser ?? null })
  if (!entry) {
    console.error('session-surfaces: refused an out-of-shape save')
    return Promise.resolve()
  }
  if (t.sessionId) return put(t.sessionId, entry, browser === undefined)
  t.early = browser === undefined ? { ...entry, browserTabs: t.early?.browserTabs ?? null } : entry
  return Promise.resolve()
}

/** A closed or exited session saves nothing more; one that never initialized never wrote at all. */
export function forgetSession(handleId: string): void {
  tracked.delete(handleId)
}
