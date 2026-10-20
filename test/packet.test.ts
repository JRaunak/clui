// Boundary: main's packet checks. A reference that no longer points at what the user picked sends nothing; a
// packet that isn't exactly the shape is refused whole; the text Claude reads is built from the checked refs.
import { CLASSIFY_MAX, changeRefStatus, classifyRefPaths, parseOutgoing, preparePacket, validateRefs, type PacketDeps } from '../src/main/cli/packet.ts'
import { parseRefs } from '../src/shared/context.ts'
import { equal, ok } from './support/harness.mjs'

const V = `sha256:${'a'.repeat(32)}`
const V2 = `sha256:${'b'.repeat(32)}`
const DOC = 'A'.repeat(32)
const UUID = '3f2b8c1e-5d4a-4e7b-9c10-2a6f0d9e8b71'
const target = (over: Record<string, unknown> = {}): any => ({
  tag: 'button',
  role: 'button',
  name: 'Sign in hunter2',
  text: 'Sign in',
  selector: '#s',
  bbox: { x: 0, y: 0, width: 10, height: 10 },
  styles: {},
  html: '',
  url: 'https://example.com/?pw=hunter2',
  ...over
})
const lines = (id = 'r1', over: Record<string, unknown> = {}): any => ({ ref: { id, kind: 'file', path: '/w/src/a.ts', lines: { start: 2, end: 3 }, sourceVersion: V, ...over } })
const whole = (id = 'r2', path = '/w/src/b.ts'): any => ({ ref: { id, kind: 'file', path } })
const pin = (id = 'r3', visual = true): any => ({
  ref: { id, kind: 'browser', pin: { source: { kind: 'browser', tabId: 1, docId: DOC }, target: target() } },
  ...(visual ? { visual: { id: 'v1', data: 'QUJD', mimeType: 'image/jpeg', w: 4, h: 4 } } : {}),
  pinId: 1
})

const files: Record<string, { version: string; lineCount: number } | 'missing' | 'denied'> = {}
const deps = (over: Partial<PacketDeps> = {}): PacketDeps => ({
  cwd: () => '/w',
  readRevision: async (_h, p) => {
    const f = files[p]
    if (!f) return { ok: false, reason: 'missing' }
    if (f === 'missing' || f === 'denied') return { ok: false, reason: f }
    return { ok: true, version: f.version as `sha256:${string}`, lineCount: f.lineCount }
  },
  authorize: async (_h, p) => (files[p] === 'denied' ? 'denied' : files[p] ? 'ok' : 'missing'),
  docOf: async () => DOC,
  secrets: () => new Set(['hunter2']),
  change: () => 'missing',
  changeOf: () => null,
  activate: () => {},
  ...over
})
const reasons = async (refs: any[], d = deps()): Promise<string> => (await validateRefs(d, 'h', refs)).map((x) => `${x.id}:${x.reason}`).join()

files['/w/src/a.ts'] = { version: V, lineCount: 10 }
ok((await reasons([lines()])) === '', 'validate: the same content version passes, as a touch does')
files['/w/src/a.ts'] = { version: V2, lineCount: 10 }
ok((await reasons([lines()])) === 'r1:changed', 'validate: a same-size replacement is a new version, so changed')
files['/w/src/a.ts'] = { version: V, lineCount: 2 }
ok((await reasons([lines()])) === 'r1:out-of-range', 'validate: lines past the end are out of range')
files['/w/src/a.ts'] = 'denied'
ok((await reasons([lines()])) === 'r1:denied', 'validate: a denied file')
delete files['/w/src/a.ts']
ok((await reasons([lines()])) === 'r1:missing', 'validate: a missing selection source')
ok((await reasons([whole()])) === '', 'validate: a missing whole file still sends')
files['/w/src/b.ts'] = 'denied'
ok((await reasons([whole()])) === 'r2:denied', 'validate: a denied whole file')
delete files['/w/src/b.ts']
ok((await reasons([pin()], deps({ docOf: async () => 'B'.repeat(32) }))) === 'r3:navigated', 'validate: another document is navigated')
ok((await reasons([pin()], deps({ docOf: async () => null }))) === 'r3:closed', 'validate: no page is closed')
{
  let reads = 0
  files['/w/src/a.ts'] = { version: V, lineCount: 10 }
  const d = deps({ readRevision: async () => (reads++, { ok: true, version: V, lineCount: 10 }) })
  await validateRefs(d, 'h', [lines('r1'), lines('r4', { lines: { start: 5, end: 6 } })])
  ok(reads === 1, 'validate: one read per file')
}

// Content order: ref crops, then the user's attachments, then the text; a crop claims its index.
{
  files['/w/src/a.ts'] = { version: V, lineCount: 10 }
  const p = parseOutgoing({ text: 'look', refs: [lines(), pin()], attachments: [{ kind: 'image', mediaType: 'image/png', data: 'WFla' }, { kind: 'text', name: 'a"b<c>.txt', text: 'x' }], now: false })!
  const r: any = await preparePacket(deps(), 'h', p, UUID)
  ok(r.ok && Array.isArray(r.content) && r.content.length === 4, 'prepare: crop, image, file, text')
  ok(r.content[0].source.data === 'QUJD' && r.content[1].source.data === 'WFla' && r.content[3].text === r.text, 'prepare: the crop comes first and the text last')
  ok(r.content[2].text.startsWith('<file name="a&quot;b&lt;c&gt;.txt">\n'), 'prepare: a text file name is attribute-escaped')
  const parsed = parseRefs(r.text)
  const [file, page] = parsed.refs.map((x: any) => x.value)
  ok(parsed.packetId === UUID && parsed.rest === 'look', 'prepare: the packetId is the uuid, the typed text follows')
  ok(file.ref.path === 'src/a.ts' && file.visualAttachmentIndex === undefined, 'prepare: a path inside the cwd goes relative')
  ok(page.visualAttachmentIndex === 0, 'prepare: the crop is claimed by its content index')
  ok(!page.ref.pin.target.name.includes('hunter2') && !page.ref.pin.target.url.includes('hunter2'), 'prepare: a secret learned after the pick is scrubbed from name and url')
  const plain: any = await preparePacket(deps(), 'h', parseOutgoing({ text: 'hi', refs: [], attachments: [], now: false })!, UUID)
  ok(plain.ok && plain.content === 'hi' && plain.text === 'hi', 'prepare: no refs and no attachments is a plain string')
  files['/w/src/a.ts'] = { version: V2, lineCount: 10 }
  const stale: any = await preparePacket(deps(), 'h', p, UUID)
  ok(!stale.ok && stale.reason === 'stale' && stale.invalid.length === 1, 'prepare: any stale ref sends nothing')
  files['/w/src/a.ts'] = { version: V, lineCount: 10 }
  const big: any = await preparePacket(deps(), 'h', parseOutgoing({ text: '', refs: [{ ...pin('r9', false), ref: { ...pin('r9').ref, pin: { ...pin().ref.pin, target: target({ html: '<'.repeat(2048), selector: '<'.repeat(4096), url: '<'.repeat(4096) }) } } }], attachments: [], now: false })!, UUID)
  ok(!big.ok && big.reason === 'invalid', 'prepare: a record past RECORD_MAX is refused, not truncated')
}

// The trust boundary refuses a packet that isn't exactly the shape.
{
  const pkt = (over: Record<string, unknown>): unknown => ({ text: 'x', refs: [], attachments: [], now: false, ...over })
  ok(!!parseOutgoing(pkt({})), 'parse: the minimal packet')
  ok(!parseOutgoing(pkt({ refs: Array.from({ length: 21 }, (_, i) => whole(`r${i + 1}`, `/w/${i}.ts`)) })), 'parse: 21 refs')
  ok(!parseOutgoing(pkt({ refs: [whole('r1'), whole('r1', '/w/c.ts')] })), 'parse: duplicate ids')
  ok(!parseOutgoing(pkt({ refs: [whole('r1'), whole('r2')] })), 'parse: duplicate refKeys')
  ok(!parseOutgoing(pkt({ refs: [{ ...whole(), visual: pin().visual }] })), 'parse: a visual on a file ref')
  ok(!parseOutgoing(pkt({ refs: [whole('x1')] })), 'parse: an id not shaped r<n>')
  ok(!parseOutgoing(pkt({ attachments: [{ kind: 'image', mediaType: 'image/svg+xml', data: 'QQ==' }] })), 'parse: an unknown attachment media type')
  ok(!parseOutgoing(pkt({ now: 'yes' })), 'parse: now must be a boolean')
}

// A drop becomes a chip only where dispatch would let it through.
{
  const kinds: Record<string, 'file' | 'folder'> = { '/w/a.ts': 'file', '/w/src': 'folder' }
  const asked: string[] = []
  const d = { authorize: async (_h: string, p: string, kind: 'file' | 'folder') => (asked.push(`${kind}:${p}`), kinds[p] === kind ? 'ok' as const : kinds[p] ? 'denied' as const : 'missing' as const) }
  const got = await classifyRefPaths(d, 'h', ['/w/a.ts', '/w/src', '/elsewhere/b.ts'])
  ok(got.join() === 'file,folder,', 'classify: a file, a folder, and a path dispatch would refuse')
  ok(asked.includes('folder:/w/src') && !asked.includes('folder:/w/a.ts'), 'classify: a folder is asked as a folder only after the file check fails')
  ok((await classifyRefPaths(d, 'h', 'not a list')).length === 0, 'classify: a non-array is refused')
  ok((await classifyRefPaths(d, 'h', ['/w/a.ts', 3])).length === 0, 'classify: a non-string path refuses the list')
  ok((await classifyRefPaths(d, 7, ['/w/a.ts'])).length === 0, 'classify: a non-string handle is refused')
  ok((await classifyRefPaths(d, 'h', Array.from({ length: CLASSIFY_MAX + 1 }, () => '/w/a.ts'))).length === 0, 'classify: an oversized list is refused whole')
}

// The bubble's status query answers through the dispatch check, per ref, and refuses anything not a short list.
{
  const A = `chg_${'a'.repeat(32)}`
  const B = `chg_${'b'.repeat(32)}`
  const d = { change: (_h: string, ref: string) => (ref === A ? ('ok' as const) : ('missing' as const)) }
  ok(changeRefStatus(d, 'h', [A, B, 'chg_nope', 7]).join() === 'true,false,false,false', 'status: a live grant, an unknown ref and malformed ones')
  ok(changeRefStatus({ change: () => 'denied' }, 'h', [A]).join() === 'false', 'status: a session without change_read reads nothing')
  ok(changeRefStatus(d, 'h', 'not a list').length === 0 && changeRefStatus(d, 7, [A]).length === 0, 'status: a non-array or a non-string handle is refused')
  ok(changeRefStatus(d, 'h', Array.from({ length: 21 }, () => A)).length === 0, 'status: more than a message can hold is refused whole')
}

// Change refs: a dispatch check like any other ref, and the only grant is made once the packet is written.
{
  const chg = (id: string, n: number): any => ({ ref: { id, kind: 'change', changeRef: `chg_${String(n).repeat(32)}`, path: '/w/src/mcp.ts', side: 'before', old: { start: 3, end: 3 } }, bytes: 1 })
  const state: Record<string, 'ok' | 'missing' | 'denied'> = {}
  const sizes: Record<string, number> = {}
  const activated: unknown[] = []
  const d = deps({ change: (_h, ref) => state[ref] ?? 'missing', changeOf: (_h, ref) => (state[ref] === 'ok' ? { path: '/w/src/mcp.ts', side: 'before', old: { start: 3, end: 3 }, bytes: sizes[ref] ?? 1 } : null), activate: (h, id, refs) => activated.push([h, id, refs]) })
  const pkt = (refs: any[]) => parseOutgoing({ text: 'q', refs, attachments: [], now: false })!
  const a = chg('r1', 1)
  const b = chg('r2', 2)
  ok((await reasons([a], d)) === 'r1:missing', 'change: an unknown ref is missing')
  const stale: any = await preparePacket(d, 'h', pkt([a]), UUID)
  ok(!stale.ok && stale.reason === 'stale' && stale.invalid[0].reason === 'missing' && !('onWritten' in stale), 'change: missing is stale, with no onWritten')
  state[a.ref.changeRef] = 'denied'
  ok((await reasons([a], d)) === 'r1:denied', 'change: denied when the session lacks the tool')
  state[a.ref.changeRef] = 'ok'
  state[b.ref.changeRef] = 'ok'
  files['/w/src/a.ts'] = { version: V, lineCount: 10 }
  const r: any = await preparePacket(d, 'h', pkt([a, lines('r3'), b]), UUID)
  ok(r.ok && typeof r.onWritten === 'function' && !activated.length, 'change: preparing grants nothing')
  ok(!r.text.includes('"bytes"'), "change: the renderer's byte count never reaches the wire")
  const forged: any = await preparePacket(d, 'h', pkt([{ ...a, ref: { ...a.ref, path: '/w/src/other.ts', side: 'after', old: { start: 90, end: 99 } } }]), UUID)
  ok(forged.ok && forged.text.includes('"side":"before"') && !forged.text.includes('other.ts') && !forged.text.includes('"start":90'), "change: the wire carries main's path, side and lines, not the renderer's")
  r.onWritten()
  equal(JSON.stringify(activated), JSON.stringify([['h', UUID, [a.ref.changeRef, b.ref.changeRef]]]), "change: onWritten activates exactly the packet's change refs under its uuid")
  const none: any = await preparePacket(d, 'h', pkt([lines('r3')]), UUID)
  ok(none.ok && none.onWritten === undefined, 'change: a packet without change refs has no onWritten')
  sizes[a.ref.changeRef] = 64 * 1024
  sizes[b.ref.changeRef] = 64 * 1024
  ok((await preparePacket(d, 'h', pkt([a, b]), UUID)).ok, 'change: 128 KiB of change text sends')
  sizes[b.ref.changeRef]++
  const over: any = await preparePacket(d, 'h', pkt([a, b]), UUID)
  ok(!over.ok && over.reason === 'invalid' && !('onWritten' in over), "change: past 128 KiB by main's own count is invalid, whatever the renderer said")
}
