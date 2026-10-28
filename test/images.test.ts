// Images: what the header says before any decode, the view math, the image reference on the wire, saved tabs
// mapped to their image kind, and main's cap that serves only the bytes its version was hashed from.
import { createHash } from 'node:crypto'
import { mkdtempSync, realpathSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { exifOrientation, isSvgText, MAX_PIXELS, readImageHead, tooLarge } from '../src/shared/imageHead.ts'
import { paneRows } from '../src/renderer/src/lib/composerRefs.ts'
import { imagePx, imageTail, isDraftVisual, isRefInput, parseRefs, refKey, refLabel, serializeContext, resourceOf } from '../src/shared/context.ts'
import { kindForPath, restoreKinds, surfaceIdOf, type SavedSet } from '../src/shared/surfaces.ts'
import { centreOf, clampView, densityOf, easing, fileSize, fitScale, fitView, minScale, percent, stepDown, stepUp, viewAt, zoomAt } from '../src/renderer/src/lib/imageView.ts'
import { hasFind, hasPreview, opensDefault, presentationOf } from '../src/renderer/src/lib/presentation.ts'
import { parseOutgoing, validateRefs, type PacketDeps } from '../src/main/cli/packet.ts'
import { BYTES_MAX, createFileAccess, hashFile } from '../src/main/surfaces/files.ts'
import { createImageCaps } from '../src/main/surfaces/protocol.ts'
import { equal, ok } from './support/harness.mjs'

const bytes = (...parts: (number[] | string | Uint8Array)[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...p].map((c) => c.charCodeAt(0)) : [...p])))
const be32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const le16 = (n: number): number[] => [n & 255, (n >> 8) & 255]
const le24 = (n: number): number[] => [n & 255, (n >> 8) & 255, (n >> 16) & 255]
const head = (b: Uint8Array) => readImageHead(b.subarray(0, 64 * 1024), b.length, async (o, n) => b.subarray(o, o + n))
const chunk = (type: string, data: number[] = []): number[] => [...be32(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0]
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const png = (w: number, h: number, extra: number[] = [], end = true): Uint8Array =>
  bytes(PNG_SIG, chunk('IHDR', [...be32(w), ...be32(h), 8, 6, 0, 0, 0]), extra, chunk('IDAT', [1, 2, 3]), end ? chunk('IEND') : [])

// Header facts, by magic bytes
{
  const p = await head(png(640, 480))
  ok(p.format === 'png' && p.w === 640 && p.h === 480 && !p.animated && p.complete, 'head: a PNG and its size')
  ok((await head(png(64, 64, chunk('acTL', [0, 0, 0, 8, 0, 0, 0, 0])))).animated, 'head: acTL before IDAT makes an APNG')
  equal((await head(png(640, 480, [], false))).complete, false, 'head: a PNG cut before IEND is incomplete')
  const big = await head(png(8000, 6000))
  ok(tooLarge(big) && !tooLarge(await head(png(5480, 3650))) && MAX_PIXELS === 40_000_000, 'head: 48 MP is over the cap, 20 MP is not')

  // JPEG: EXIF orientation 6 turns 1200×800 into 800×1200
  const tiff = [...'MM'].map((c) => c.charCodeAt(0)).concat([0, 42], be32(8), [0, 1], [0x01, 0x12, 0, 3], be32(1), [0, 6, 0, 0], be32(0))
  const app1 = bytes('Exif', [0, 0], tiff)
  equal(exifOrientation(app1), 6, 'exif: orientation read from IFD0')
  const jpg = bytes([0xff, 0xd8], [0xff, 0xe1, ...[(app1.length + 2) >> 8, (app1.length + 2) & 255]], app1, [0xff, 0xc0, 0, 17, 8, ...[800 >> 8, 800 & 255], ...[1200 >> 8, 1200 & 255], 3], new Array(9).fill(0), [0xff, 0xd9])
  const j = await head(jpg)
  ok(j.format === 'jpeg' && j.w === 800 && j.h === 1200 && j.orientation === 6 && j.complete, `head: an EXIF-rotated JPEG is its shown size (${JSON.stringify(j)})`)

  const gif = await head(bytes('GIF89a', le16(120), le16(90), [0, 0, 0], [0x3b]))
  ok(gif.format === 'gif' && gif.w === 120 && gif.h === 90 && gif.animated && gif.complete, 'head: a GIF, which may animate')
  equal((await head(bytes('GIF89a', le16(120), le16(90), [0, 0, 0, 1, 2, 3]))).complete, false, 'head: a GIF with no trailer is incomplete')

  const riff = (body: number[]): Uint8Array => bytes('RIFF', [...le24(body.length + 4), 0], 'WEBP', body)
  const vp8x = await head(riff([...'VP8X'].map((c) => c.charCodeAt(0)).concat([10, 0, 0, 0, 0x02, 0, 0, 0], le24(119), le24(89), new Array(8).fill(0))))
  ok(vp8x.format === 'webp' && vp8x.w === 120 && vp8x.h === 90 && vp8x.animated && vp8x.complete, 'head: an animated WebP')
  const l = 319 | (199 << 14)
  const vp8l = await head(riff([...'VP8L'].map((c) => c.charCodeAt(0)).concat([5, 0, 0, 0, 0x2f, l & 255, (l >> 8) & 255, (l >> 16) & 255, (l >>> 24) & 255], new Array(6).fill(0))))
  ok(vp8l.w === 320 && vp8l.h === 200 && !vp8l.animated, `head: a lossless WebP (${vp8l.w}×${vp8l.h})`)
  equal((await head(bytes('RIFF', le24(5000), [0], 'WEBP', 'VP8X', new Array(20).fill(0)))).complete, false, 'head: a WebP shorter than its RIFF size is incomplete')

  const box = (type: string, body: number[]): number[] => [...be32(body.length + 8), ...[...type].map((c) => c.charCodeAt(0)), ...body]
  const ftyp = (major: string, compat: string[]): number[] => box('ftyp', [...[...major].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...compat.flatMap((b) => [...b].map((c) => c.charCodeAt(0)))])
  const ispe = (w: number, h: number): number[] => box('ispe', [0, 0, 0, 0, ...be32(w), ...be32(h)])
  const avif = await head(bytes(ftyp('avif', ['mif1', 'miaf']), box('meta', [...ispe(64, 64), ...ispe(320, 200)]), box('mdat', [1, 2, 3])))
  ok(avif.format === 'avif' && avif.w === 320 && avif.h === 200 && !avif.animated && avif.complete, 'head: an AVIF takes its largest ispe')
  ok((await head(bytes(ftyp('avis', ['avif']), box('mdat', [1])))).animated, 'head: an AVIF sequence may animate')
  const cut = bytes(ftyp('avif', []), box('mdat', new Array(40).fill(1))).subarray(0, 30)
  equal((await head(cut)).complete, false, 'head: an AVIF box past the end is incomplete')
  equal((await head(bytes(ftyp('heic', ['mif1', 'heic']), box('mdat', [1])))).format, null, 'head: HEIC is none of the shown formats')

  equal((await head(bytes('<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="x" viewBox="0 0 1 1"/>'))).format, 'svg', 'head: an SVG after a prolog and comment')
  equal((await head(bytes('<html><svg/></html>'))).format, null, 'head: HTML holding an SVG is not one')
  equal((await head(bytes('not an image at all'))).format, null, 'head: text is no image')
  ok(isSvgText('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd" [ <!ENTITY a "b"> ]>\n<svg/>') && isSvgText('<!doctype svg>\n  <svg>') && !isSvgText('<!-- open'), 'head: doctypes with and without a subset, an unclosed comment')
  const t0 = performance.now()
  const crafted = isSvgText('<!---->'.repeat(10_000) + 'x')
  const ms = performance.now() - t0
  ok(!crafted && ms < 50, `head: a run of empty comments scans in linear time (${ms.toFixed(1)}ms)`)
}

// View math
{
  const box = { w: 1000, h: 500 }
  const vp = { w: 532, h: 400 }
  equal(fitScale(box, vp), 0.5, 'fit: contain less 16px a side')
  equal(fitScale({ w: 16, h: 16 }, vp), 1, 'fit: never above 100%')
  const f = fitView(box, vp)
  ok(f.x === 16 && f.y === (400 - 250) / 2, 'fit: centred')
  equal(stepUp(0.42), 0.5, 'steps: from Fit at 42% the next stop is 50%')
  equal(stepUp(16), 16, 'steps: 1600% is the largest')
  equal(stepDown(0.1, 0.04), 0.04, 'steps: under 10% the minimum is Fit')
  equal(minScale(0.5), 0.1, 'steps: the minimum is the smaller of Fit and 10%')
  const c = clampView({ s: 2, x: 100, y: -5000 }, box, vp)
  ok(c.x === 0 && c.y === 400 - 1000, 'clamp: an overflowing axis stops at the edges')
  const z = zoomAt({ s: 1, x: -100, y: -50 }, 2, 200, 100, box, vp)
  ok(Math.abs((200 - z.x) / z.s - 300) < 1e-9 && Math.abs((100 - z.y) / z.s - 150) < 1e-9, 'zoom: the point under the cursor stays put')
  const v = viewAt(3, { x: 0.3, y: 0.6 }, box, vp)
  const back = centreOf(v, box, vp)
  ok(Math.abs(back.x - 0.3) < 1e-9 && Math.abs(back.y - 0.6) < 1e-9, 'saved place: the centre point round-trips')
  ok(percent(0.042) === '4.2%' && percent(0.4249) === '42%' && percent(16) === '1600%', 'percent: whole, one decimal under 10%')
  ok(densityOf('icon@2x.png') === 2 && densityOf('a@3x.webp') === 3 && densityOf('a@4x.png') === 1 && densityOf('plain.png') === 1, 'density: @2x and @3x names')
  ok(fileSize(84 * 1024) === '84 KB' && fileSize(2.4 * 1024 * 1024) === '2.4 MB', 'readout: file size')
  const e = easing('cubic-bezier(0.2, 0, 0, 1)')
  ok(e(0) === 0 && e(1) === 1 && e(0.5) > 0.5, 'easing: ease-snap ends and leans early')
}

// The image reference
{
  const V = `sha256:${'c'.repeat(32)}` as const
  const region = { kind: 'image', path: '/w/shot.png', sourceVersion: V, size: { w: 1280, h: 720 }, region: { x: 0.0938, y: 0.0667, w: 0.5, h: 0.4444 } } as const
  const point = { kind: 'image', path: '/w/shot.png', sourceVersion: V, size: { w: 1280, h: 720 }, point: { x: 0.3219, y: 0.1333 } } as const
  ok(isRefInput(region) && isRefInput(point), 'ref: a region and a point pass')
  ok(!isRefInput({ ...region, point: { x: 0, y: 0 } }), 'ref: never both a region and a point')
  ok(!isRefInput({ ...point, point: undefined }), 'ref: one of them')
  ok(!isRefInput({ ...region, region: { x: 0.8, y: 0, w: 0.5, h: 0.1 } }), 'ref: a region past the right edge')
  ok(!isRefInput({ ...region, region: { x: 0, y: 0, w: 0, h: 0.1 } }), 'ref: an empty region')
  ok(!isRefInput({ ...point, frame: 1 }) && isRefInput({ ...point, frame: 0 }), 'ref: only frame 0')
  ok(!isRefInput({ ...point, orientation: 1 }) && isRefInput({ ...point, orientation: 6 }), 'ref: orientation only when it is not 1')
  ok(!isRefInput({ ...point, sourceVersion: 'rev' }), 'ref: a content version, never a stat revision')
  equal(refLabel(region), 'shot.png · region 640×320 at 120,48', 'ref: label in image pixels')
  equal(refLabel(point), 'shot.png · point 412,96', 'ref: a point label')
  equal(imageTail(region, false), 'region 640×320', 'ref: the short form drops the place')
  ok(imagePx({ size: { w: 10, h: 10 }, region: { x: 0.95, y: 0, w: 0.05, h: 0.01 } }).w === 1, 'ref: at least one pixel each way')
  ok(refKey(region) !== refKey(point) && resourceOf(region) === 'image:/w/shot.png', 'ref: its own key and resource')
  const text = serializeContext([{ version: 1, ref: { ...region, id: 'r1', frame: 0, orientation: 6 }, visualAttachmentIndex: 0 }], 'what is this', { packetId: null })
  ok(text.includes('Image regions and points are 0 to 1 from the top left of the image as shown, after EXIF rotation; size is in pixels.'), 'context: the header explains the coordinates')
  const back = parseRefs(text)
  const r = back.refs[0]
  ok(r?.kind === 'current' && JSON.stringify(r.value.ref) === JSON.stringify({ id: 'r1', ...region, frame: 0, orientation: 6 }) && r.value.visualAttachmentIndex === 0, 'context: the record reads back')
  ok(isDraftVisual({ id: 'v', data: 'QUJD', mimeType: 'image/png', w: 4, h: 4 }) && !isDraftVisual({ id: 'v', data: 'QUJD', mimeType: 'image/gif', w: 4, h: 4 }), 'visual: PNG or JPEG')

  const visual = { id: 'v', data: 'QUJD', mimeType: 'image/png', w: 4, h: 4 }
  ok(!!parseOutgoing({ text: '', now: false, refs: [{ ref: { ...region, id: 'r1' }, visual }], attachments: [] }), 'packet: a region carries its picture')
  equal(parseOutgoing({ text: '', now: false, refs: [{ ref: { ...point, id: 'r1' }, visual }], attachments: [] }), null, 'packet: a point never does')
  let version = V as string
  const deps = { byteVersion: async () => ({ ok: true, version }) } as unknown as PacketDeps
  equal((await validateRefs(deps, 'h', [{ ref: { ...region, id: 'r1' } }])).length, 0, 'validate: the same bytes pass')
  version = `sha256:${'d'.repeat(32)}`
  equal((await validateRefs(deps, 'h', [{ ref: { ...region, id: 'r1' } }]))[0]?.reason, 'changed', 'validate: other bytes are a change')
}

// Kinds, presentations and saved tabs
{
  ok(['a.png', 'b.JPG', 'c.jpeg', 'd.webp', 'e.gif', 'f.avif', 'g.svg'].every((p) => kindForPath(p) === 'image'), 'kind: the shown formats open as images')
  ok(['a.ico', 'b.icns', 'c.ts', 'd.svg.txt'].every((p) => kindForPath(p) === 'file'), 'kind: icons and the rest stay files')
  ok(hasPreview('/w/a.svg') && presentationOf({ kind: 'image', key: '/w/a.svg' }, false) === 'preview', 'presentation: SVG previews by default')
  equal(presentationOf({ kind: 'image', key: '/w/a.png' }, false), null, 'presentation: a raster has no Source to swap to')
  ok(!hasFind(null, { kind: 'image', key: '/w/a.png' }) && !hasFind(null, { kind: 'image', key: '/w/a.svg' }) && hasFind(null, { kind: 'image', key: '/w/a.svg', mode: 'source' }), 'find: only an SVG Source')
  ok(opensDefault('image', null) && !opensDefault('image', 'source') && opensDefault('file', 'preview'), 'external: an image opens in its default app')
  const tab = (kind: 'file' | 'image', key: string): any => ({ id: surfaceIdOf({ kind, key }), kind, key, title: key, openedBy: 'user', openedAt: 1, lastViewedAt: 1 })
  const old: SavedSet = {
    order: ['file:/w/alpha.png', 'file:/w/a.ts', 'browser:1'],
    active: 'file:/w/alpha.png',
    tabs: { 'file:/w/alpha.png': { ...tab('file', '/w/alpha.png'), viewState: { kind: 'file', topLine: 3, offsetPx: 0, scrollLeft: 0 } }, 'file:/w/a.ts': tab('file', '/w/a.ts') }
  }
  const next = restoreKinds(old)
  ok(
    JSON.stringify(next.order) === JSON.stringify(['image:/w/alpha.png', 'file:/w/a.ts', 'browser:1']) && next.active === 'image:/w/alpha.png' && next.tabs['image:/w/alpha.png']?.kind === 'image' && !next.tabs['image:/w/alpha.png']?.viewState && !next.tabs['file:/w/alpha.png'],
    'restore: an image file tab comes back as its one image tab'
  )
  const both = restoreKinds({ ...old, order: [...old.order, 'image:/w/alpha.png'], tabs: { ...old.tabs, 'image:/w/alpha.png': tab('image', '/w/alpha.png') } })
  ok(Object.keys(both.tabs).filter((k) => k.endsWith('alpha.png')).length === 1 && both.order.filter((k) => k.endsWith('alpha.png')).length === 1, 'restore: never two tabs for one image')
  const rows = paneRows([{ ...tab('image', '/w/shot.png'), lastViewedAt: 2, selection: { region: { x: 0, y: 0, w: 0.5, h: 0.5 }, sourceVersion: `sha256:${'a'.repeat(32)}` } }], '/w', '/h', { inDraft: () => false, minted: () => false, changeRead: null })
  ok(rows.length === 1 && rows[0].input?.kind === 'file' && !('lines' in rows[0].input), 'pane rows: an image tab offers its whole file only')
  equal(restoreKinds({ order: ['file:/w/a.ts'], active: null, tabs: { 'file:/w/a.ts': tab('file', '/w/a.ts') } }).tabs['file:/w/a.ts']?.kind, 'file', 'restore: other tabs as they were')
}

// Main's image cap: the header first, then a cap bound to the bytes it hashed
{
  const fx = realpathSync(mkdtempSync('/tmp/clui-img-'))
  const pic = png(8, 8)
  writeFileSync(join(fx, 'a.png'), pic)
  writeFileSync(join(fx, 'cut.png'), png(8, 8, [], false))
  writeFileSync(join(fx, 'empty.png'), '')
  writeFileSync(join(fx, 'big.png'), png(8000, 6000))
  writeFileSync(join(fx, 'heic.jpg'), 'not a jpeg')
  const fa = createFileAccess({ cwd: () => fx, changedPaths: async () => [] })
  const resolve = (h: string, p: string) => fa.resolveAllowed(h, p, { consumer: 'file', operation: 'read-file' })
  const caps = createImageCaps(resolve)
  const sha = `sha256:${createHash('sha256').update(pic).digest('hex').slice(0, 32)}`
  const o = await caps.open('h', 'image:t', join(fx, 'a.png'))
  ok(o.ok && o.cap?.version === sha && o.head?.w === 8, 'open: the version is the hash of every byte')
  const r = await resolve('h', join(fx, 'a.png'))
  ok(r.ok && (await hashFile(r)).ok && ((await hashFile(r)) as { version: string }).version === sha.slice(7), 'hash: main hashes the same bytes again at dispatch')
  const get = (url: string) => caps.serve(new Request(url))
  const url = o.ok ? o.cap!.url : ''
  const res = await get(url)
  ok(res.status === 200 && res.headers.get('access-control-allow-origin') === '*', 'cap: serves the image, readable by the renderer')
  ok(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(pic)), 'cap: the hashed bytes')
  equal((await get(`${url}?play=1`)).status, 200, 'cap: a query, as Play adds, is ignored')
  for (const [name, want] of [['cut.png', 'no cap'], ['empty.png', 'empty'], ['big.png', 'no cap'], ['heic.jpg', 'none']] as const) {
    const x = await caps.open('h', `image:${name}`, join(fx, name))
    const got = !x.ok ? 'refused' : !x.head ? 'empty' : !x.head.format ? 'none' : x.cap ? 'cap' : 'no cap'
    equal(got, want, `open: ${name}`)
  }
  writeFileSync(join(fx, 'huge.png'), png(8, 8))
  truncateSync(join(fx, 'huge.png'), BYTES_MAX + 1)
  const huge = await caps.open('h', 'image:huge', join(fx, 'huge.png'))
  const hr = await resolve('h', join(fx, 'huge.png'))
  ok(!huge.ok && huge.reason === 'too-large' && hr.ok && !(await hashFile(hr)).ok, 'open: past the bytes a cap serves, nothing is hashed')
  writeFileSync(join(fx, 'a.png'), png(8, 9))
  equal((await get(url)).status, 404, 'cap: a changed file is never served under the old version')
  const o2 = await caps.open('h', 'image:t', join(fx, 'a.png'))
  equal((await get(url)).status, 403, 'cap: a new open revokes the last')
  caps.revoke('h', 'image:t')
  equal((await get(o2.ok ? o2.cap!.url : '')).status, 403, 'cap: revoked on close')
}
