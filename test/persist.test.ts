// Boundary: the Surfaces sidecar. Field validation both ways, a bad entry isolated to its session, a
// newer file never rewritten, serialized writes, delete, and the handle→session routing of saves.
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from './support/electron-stub.mjs'
import {
  bindSession,
  cleanUrl,
  deleteSurfaces,
  flushSurfaces,
  forgetSession,
  loadSurfaces,
  parseEntry,
  saveSession,
  trackSession
} from '../src/main/surfaces/persist.ts'
import { equal, ok } from './support/harness.mjs'

const P = join(app.getPath('userData'), 'session-surfaces.json')
const onDisk = (): any => JSON.parse(readFileSync(P, 'utf8'))
const clear = (): void => rmSync(P, { force: true })

const file = (key: string, over: Record<string, unknown> = {}): any => ({
  id: `file:${key}`,
  kind: 'file',
  key,
  title: key.slice(key.lastIndexOf('/') + 1),
  openedBy: 'user',
  openedAt: 10,
  lastViewedAt: 20,
  viewState: { kind: 'file', topLine: 40, offsetPx: 0, scrollLeft: 0, previewScrollTop: 0 },
  ...over
})
const tree = { id: 'tree', kind: 'tree', key: '', title: 'w', openedBy: 'user', openedAt: 1, lastViewedAt: 2, viewState: { kind: 'tree', expanded: ['src', 'src/lib'], scrollTop: 30 } }
const entry = (over: Record<string, unknown> = {}): any => ({
  set: { order: ['tree', 'file:/w/a.ts', 'browser:2'], active: 'file:/w/a.ts', tabs: { tree, 'file:/w/a.ts': file('/w/a.ts') } },
  browserTabs: { tabs: [{ id: 2, url: 'https://example.com/x', lastViewedAt: 5 }], nextId: 3, viewed: 2 },
  open: true,
  full: false,
  ...over
})
const withSet = (patch: Record<string, unknown>): any => {
  const e = entry()
  return { ...e, set: { ...e.set, ...patch } }
}

// Validation: a whole entry round-trips; transient fields never reach disk.
{
  const e = entry()
  e.set.tabs['file:/w/a.ts'].selection = { lines: { start: 1, end: 2 } }
  e.set.tabs['file:/w/a.ts'].location = { line: 9 }
  const parsed = parseEntry(e)
  ok(!!parsed, 'persist: a well-formed entry parses')
  ok(parsed?.set.tabs['file:/w/a.ts'].viewState?.kind === 'file' && (parsed.set.tabs['file:/w/a.ts'].viewState as any).topLine === 40, 'persist: typed view state kept')
  ok(!('selection' in (parsed?.set.tabs['file:/w/a.ts'] ?? {})) && !('location' in (parsed?.set.tabs['file:/w/a.ts'] ?? {})), 'persist: selections and destinations are dropped')
  ok(parseEntry(entry({ browserTabs: null }))?.browserTabs === null, 'persist: no browser records is valid')
}
{
  const bad: [string, unknown][] = [
    ['unknown kind', withSet({ tabs: { tree, 'file:/w/a.ts': file('/w/a.ts', { kind: 'video' }) } })],
    ['id not its resource', withSet({ tabs: { tree, 'file:/w/a.ts': file('/w/a.ts', { id: 'file:/w/b.ts' }) } })],
    ['relative key', withSet({ order: ['file:w/a.ts'], active: null, tabs: { 'file:w/a.ts': file('w/a.ts') } })],
    ['view state of another kind', withSet({ tabs: { tree, 'file:/w/a.ts': file('/w/a.ts', { viewState: { kind: 'tree', expanded: [], scrollTop: 0 } }) } })],
    ['non-finite scroll', withSet({ tabs: { tree: { ...tree, viewState: { kind: 'tree', expanded: [], scrollTop: null } }, 'file:/w/a.ts': file('/w/a.ts') } })],
    ['tab missing from order', withSet({ order: ['tree'], active: 'tree' })],
    ['order names a missing tab', withSet({ order: ['tree', 'file:/w/a.ts', 'file:/w/b.ts'] })],
    ['active not in order', withSet({ active: 'file:/w/z.ts' })],
    ['duplicate order', withSet({ order: ['tree', 'tree', 'file:/w/a.ts'] })],
    ['browser ids out of order', entry({ browserTabs: { tabs: [{ id: 3, url: 'about:blank', lastViewedAt: 0 }, { id: 2, url: 'about:blank', lastViewedAt: 0 }], nextId: 4, viewed: 2 } })],
    ['nextId reuses an id', entry({ browserTabs: { tabs: [{ id: 2, url: 'about:blank', lastViewedAt: 0 }], nextId: 2, viewed: 2 } })],
    ['open not boolean', entry({ open: 'yes' })]
  ]
  for (const [why, v] of bad) ok(parseEntry(v) === null, `persist: refuses ${why}`)
  const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`file:/w/${i}.ts`, file(`/w/${i}.ts`)]))
  ok(parseEntry(withSet({ order: Object.keys(many), active: null, tabs: many })) === null, 'persist: more than 24 non-browser tabs is not a set Clui wrote')
}

// URLs: no userinfo, no off-machine query or fragment, and nothing but http(s) or a blank page.
equal(cleanUrl('https://user:pw@example.com/a?code=1#access_token=2'), 'https://example.com/a', 'persist: userinfo, query and fragment stripped')
equal(cleanUrl('http://localhost:5173/a?b=1#c'), 'http://localhost:5173/a?b=1#c', 'persist: a localhost query and fragment are kept')
equal(cleanUrl('file:///etc/passwd'), 'about:blank', 'persist: a file URL reopens blank')
equal(cleanUrl('javascript:alert(1)'), 'about:blank', 'persist: a script URL reopens blank')
equal(parseEntry(entry({ browserTabs: { tabs: [{ id: 2, url: 'http://a:b@x.test/', lastViewedAt: 0 }], nextId: 3, viewed: 2 } }))?.browserTabs?.tabs[0].url, 'http://x.test/', 'persist: a parsed record is cleaned')

// A corrupt entry is reported for its own session only, and kept as it was when another session writes.
{
  clear()
  writeFileSync(P, JSON.stringify({ version: 1, sessions: { good: entry(), bad: { set: 'nope' } } }))
  equal((await loadSurfaces('good')).status, 'ok', 'persist: a valid entry loads beside a corrupt one')
  equal((await loadSurfaces('bad')).status, 'corrupt', 'persist: the corrupt entry reads corrupt')
  equal((await loadSurfaces('absent')).status, 'none', 'persist: no entry is the normal case')
  trackSession('h-other', { quick: false, sessionId: 'other', seed: null })
  await saveSession('h-other', entry(), null)
  const d = onDisk()
  ok(d.sessions.bad.set === 'nope' && !!d.sessions.good && !!d.sessions.other, 'persist: a write keeps every other entry, corrupt ones as is')
  forgetSession('h-other')
}

// A newer file is never rewritten, and every session reads it as newer.
{
  clear()
  const raw = JSON.stringify({ version: 2, sessions: { s: { anything: true } } })
  writeFileSync(P, raw)
  equal((await loadSurfaces('s')).status, 'newer', 'persist: a newer version reads newer')
  trackSession('h-new', { quick: false, sessionId: 's', seed: null })
  await saveSession('h-new', entry(), null)
  await deleteSurfaces('s')
  equal(readFileSync(P, 'utf8'), raw, 'persist: a newer file is untouched by save and delete')
  forgetSession('h-new')
}

// An unparseable file holds nothing to keep: it reads corrupt, and the next save replaces it.
{
  clear()
  writeFileSync(P, '{"version":1,"sessions":')
  equal((await loadSurfaces('s')).status, 'corrupt', 'persist: a garbled file reads corrupt')
  trackSession('h-g', { quick: false, sessionId: 's', seed: null })
  await saveSession('h-g', entry(), null)
  ok(onDisk().version === 1 && !!onDisk().sessions.s, 'persist: a save replaces a garbled file')
  forgetSession('h-g')
}

// Concurrent saves from two sessions both land.
{
  clear()
  for (const n of [1, 2, 3, 4]) trackSession(`h${n}`, { quick: false, sessionId: `s${n}`, seed: null })
  await Promise.all([1, 2, 3, 4].map((n) => saveSession(`h${n}`, entry({ full: n % 2 === 0 }), null)))
  const d = onDisk()
  ok([1, 2, 3, 4].every((n) => d.sessions[`s${n}`]?.full === (n % 2 === 0)), 'persist: serialized writes keep every session')
  await deleteSurfaces('s2')
  ok(!('s2' in onDisk().sessions) && 's1' in onDisk().sessions, 'persist: delete drops only its session')
  for (const n of [1, 2, 3, 4]) forgetSession(`h${n}`)
}

// Routing: early saves wait for init, Quick sessions and never-initialized closes write nothing.
{
  clear()
  trackSession('quick', { quick: true, sessionId: null, seed: null })
  await saveSession('quick', entry(), null)
  bindSession('quick', 'q')
  await flushSurfaces()
  trackSession('closed', { quick: false, sessionId: null, seed: null })
  await saveSession('closed', entry(), null)
  forgetSession('closed')
  bindSession('closed', 'c')
  await flushSurfaces()
  let wrote = true
  try {
    readFileSync(P)
  } catch {
    wrote = false
  }
  ok(!wrote, 'persist: a Quick session and a session closed before init write nothing')

  trackSession('early', { quick: false, sessionId: null, seed: null })
  await saveSession('early', entry({ full: true }), entry().browserTabs)
  bindSession('early', 'e')
  await flushSurfaces()
  ok(onDisk().sessions.e?.full === true, 'persist: a save before init lands under the id init reports')
  await saveSession('early', { set: entry().set, open: false, full: false }, undefined)
  ok(onDisk().sessions.e.open === false && onDisk().sessions.e.browserTabs?.nextId === 3, 'persist: a session without browser access keeps its saved browser tabs')
  await saveSession('early', { set: entry().set, open: false, full: false, browserTabs: { injected: true } }, null)
  equal(onDisk().sessions.e.browserTabs, null, "persist: browser records are main's, never the renderer's")
  ok((await saveSession('early', { set: 'bad', open: true, full: true }, null), onDisk().sessions.e.open === false), 'persist: an out-of-shape save is refused')
  forgetSession('early')

  trackSession('fork', { quick: false, sessionId: null, seed: parseEntry(entry())! })
  bindSession('fork', 'f')
  await flushSurfaces()
  ok(onDisk().sessions.f?.set.active === 'file:/w/a.ts' && onDisk().sessions.f.browserTabs?.nextId === 3, "persist: a fork's copy lands under its new id at init")
  forgetSession('fork')
  clear()
}
