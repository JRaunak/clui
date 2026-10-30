// PDFs: the doc reference on the wire and in the UI's copy, the quote and how it's found again, the view math, saved
// tabs mapped to the doc kind, and main's reads bound to the revision a PDF opened at.
import { createHash } from 'node:crypto'
import { appendFileSync, mkdtempSync, realpathSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { docPagesShort, docTail, isRefInput, parseRefs, quoteOf, QUOTE_MAX, refKey, refLabel, resourceOf, serializeContext, type RefInput } from '../src/shared/context.ts'
import { kindForPath, restoreKinds, type SavedSet } from '../src/shared/surfaces.ts'
import { addedText, removalSpoken, shortLabel, spokenRef } from '../src/renderer/src/lib/refCopy.ts'
import { paneRows } from '../src/renderer/src/lib/composerRefs.ts'
import { hasFind, opensDefault, presentationOf } from '../src/renderer/src/lib/presentation.ts'
import { stepDown, stepUp, clampScale, minScale } from '../src/renderer/src/lib/imageView.ts'
import { collapse, fitPage, fitWidth, linesOf, locate, nextPage, offsetIn, pageAt, PDF_STEPS, prevPage, quoteBetween, zoomSaid } from '../src/renderer/src/lib/pdfView.ts'
import { BYTES_MAX, CHUNK_MAX, createFileAccess, docHead, hashFile, readBytes, statFile } from '../src/main/surfaces/files.ts'
import { parseEntry } from '../src/main/surfaces/persist.ts'
import { equal, ok } from './support/harness.mjs'

const V = `sha256:${'a'.repeat(32)}` as const
const base = { kind: 'doc' as const, path: '/w/paper.pdf', sourceVersion: V, pages: 300, page: 12 }
const text: RefInput = { ...base, endPage: 14, text: { quote: 'the latency table', nth: 1 } }
const region: RefInput = { ...base, pageSize: { w: 612, h: 792 }, region: { x: 0.1176, y: 0.1768, w: 0.3431, h: 0.1212 } }
const point: RefInput = { ...base, pageSize: { w: 612, h: 792 }, point: { x: 0.4902, y: 0.5202 } }

// The doc reference: exactly one of text, region and point, its pages in range
{
  ok(isRefInput(text) && isRefInput(region) && isRefInput(point), 'ref: text, region and point are valid')
  const bad: [unknown, string][] = [
    [{ ...base }, 'none of text, region or point'],
    [{ ...base, text: { quote: 'a', nth: 0 }, point: { x: 0, y: 0 }, pageSize: { w: 1, h: 1 } }, 'two of them'],
    [{ ...base, page: 301, text: { quote: 'a', nth: 0 } }, 'a page past the count'],
    [{ ...base, endPage: 12, text: { quote: 'a', nth: 0 } }, 'an endPage that is the page'],
    [{ ...base, endPage: 13, pageSize: { w: 1, h: 1 }, point: { x: 0, y: 0 } }, 'an endPage on a point'],
    [{ ...base, point: { x: 0, y: 0 } }, 'a point without its page size'],
    [{ ...base, text: { quote: '', nth: 0 } }, 'an empty quote'],
    [{ ...base, text: { quote: 'x'.repeat(QUOTE_MAX + 8), nth: 0 } }, 'a quote past the elided length'],
    [{ ...base, pageSize: { w: 1, h: 1 }, region: { x: 0.9, y: 0, w: 0.2, h: 0.1 } }, 'a region past the edge'],
    [{ ...base, sourceVersion: 'rev:1', text: { quote: 'a', nth: 0 } }, 'a stat revision as the version']
  ]
  for (const [x, label] of bad) ok(!isRefInput(x), `ref: refuses ${label}`)
  equal(resourceOf({ id: 'r1', ...text }), 'doc:/w/paper.pdf', 'ref: its own resource, versioned by every byte')
  ok(refKey(text) !== refKey({ ...text, text: { quote: 'the latency table', nth: 0 } }), 'key: another occurrence is another reference')
  equal(refLabel(text), 'paper.pdf · pages 12 to 14 · text', 'label: text across pages')
  equal(refLabel(region), 'paper.pdf · page 12 · region 210×96 pt at 72,140', 'label: a region in points')
  equal(refLabel(point), 'paper.pdf · page 12 · point 300,412 pt', 'label: a point in points')
  equal(`${docPagesShort(text)} ${docTail(region)}`, 'p.12-14 page 12 · region 210×96 pt at 72,140', 'label: short pages and the tail')
}

// Copy: what the notices, the live region and the chip say
{
  equal(shortLabel({ id: 'r1', ...text }), 'text on pages 12 to 14', 'copy: short label of text')
  equal(shortLabel({ id: 'r1', ...region }), 'a region on page 12', 'copy: short label of a region')
  equal(shortLabel({ id: 'r1', ...point }), 'a point on page 12', 'copy: short label of a point')
  equal(addedText(region), 'Added a region on page 12 of paper.pdf to the message.', 'copy: added')
  equal(spokenRef(point), 'paper.pdf, page 12, point', 'copy: spoken point')
  equal(spokenRef({ ...base, text: { quote: 'x'.repeat(100), nth: 0 } }), `paper.pdf, page 12, text "${'x'.repeat(80)}…"`, 'copy: spoken text keeps its first 80 characters')
  equal(removalSpoken([{ id: 'r1', ...region }], 'changed'), 'paper.pdf changed. A region on page 12 was removed from the message.', 'copy: removal')
}

// The quote: whitespace collapsed, and past 2,000 characters its first and last thousand
{
  equal(JSON.stringify(quoteOf('  the\n\tlatency   table ')), JSON.stringify({ quote: 'the latency table' }), 'quote: whitespace collapses')
  const long = `${'a'.repeat(2500)}${'b'.repeat(2500)}`
  const q = quoteOf(long)
  ok(q.elided === true && q.quote === `${'a'.repeat(1000)} [...] ${'b'.repeat(1000)}`, 'quote: 5,000 characters keep 1,000 + [...] + 1,000')
  equal(quoteOf('x'.repeat(2000)).elided, undefined, 'quote: 2,000 characters stay whole')
  equal(JSON.stringify(quoteOf(q.quote)), JSON.stringify(q), 'quote: an elided quote elides to itself')
  const e = q.quote.length
  ok(isRefInput({ ...base, text: { ...q, nth: 0 } }) && e === 2007, 'quote: an elided quote is a valid reference')
}

// The wire: the record round trips, and the header explains pages and points
{
  const out = serializeContext([{ version: 1, ref: { id: 'r1', ...region, path: 'paper.pdf' } }], 'what is this?', { packetId: null })
  ok(out.includes('PDF pages count from 1 in file order.') && out.includes('A quote marked elided keeps only its start and end.'), 'wire: the doc sentence')
  const back = parseRefs(out).refs[0]
  ok(back?.kind === 'current' && JSON.stringify(back.value.ref) === JSON.stringify({ id: 'r1', ...region, path: 'paper.pdf' }), 'wire: the record parses back as sent')
  const t = serializeContext([{ version: 1, ref: { id: 'r2', ...text, path: 'paper.pdf', note: 'why' } }], '', { packetId: null })
  const r = parseRefs(t).refs[0]
  ok(r?.kind === 'current' && r.value.ref.kind === 'doc' && r.value.ref.text?.nth === 1 && r.value.ref.endPage === 14, 'wire: a text record keeps its pages and occurrence')
}

// Text: the pages' text collapsed, a selection's quote and occurrence, and finding it again
{
  const pages = [
    { page: 12, text: 'Latency rose.\nThe latency table\nshows it.' },
    { page: 13, text: 'More on the latency table here.' }
  ]
  const c = collapse(pages)
  equal(c.text, 'Latency rose. The latency table shows it. More on the latency table here.', 'text: line breaks and the page break are one space')
  const q = quoteBetween(pages, { i: 1, off: 8 }, { i: 1, off: 25 })
  ok(q?.text === 'the latency table' && q.nth === 0 && q.i === 1, 'text: a quote on page 13 is its first there')
  const twice = [{ page: 1, text: 'a b a b a' }]
  equal(quoteBetween(twice, { i: 0, off: 8 }, { i: 0, off: 9 })?.nth, 2, 'text: the third "a" is occurrence 2')
  const across = quoteBetween(pages, { i: 0, off: 32 }, { i: 1, off: 4 })
  ok(across?.text === 'shows it. More' && across.i === 0 && across.endI === 1, 'text: a quote across the page break')
  const at = locate(pages, 'latency table', 0, 1)
  ok(at?.a.i === 1 && at.a.off === 12 && at.b.off === 25, 'locate: the occurrence that starts on the asked page')
  const elided = locate([{ page: 1, text: 'start of it, middle, the end' }], 'start [...] the end', 0, 0)
  ok(elided?.a.off === 0 && elided.b.off === 28, 'locate: an elided quote by its start and end')
  equal(locate(pages, 'nowhere', 0, 0), null, 'locate: a missing quote finds nothing')
  equal(JSON.stringify(linesOf('one\n\ntwo \nthree')), JSON.stringify([[0, 3], [5, 9], [10, 15]]), 'lines: blank lines skipped')
}

// The view: current page, paging, fits and zoom stops
{
  const b = [
    { top: 16, h: 1056 },
    { top: 1084, h: 1056 },
    { top: 2152, h: 816 }
  ]
  equal(pageAt(b, 500), 0, 'page: the page under the centre')
  equal(pageAt(b, 1076), 1, 'page: in the gap, the page below')
  equal(pageAt(b, 99999), 2, 'page: past the end, the last')
  equal(nextPage(b, 16), 1, 'paging: PageDown from page 1 top goes to page 2')
  equal(nextPage(b, 2152), 2, 'paging: PageDown on the last page stays')
  equal(prevPage(b, 1084), 0, 'paging: PageUp from page 2 top goes to page 1')
  equal(offsetIn(b[1], 1084 + 528), 0.5, 'place: halfway down page 2')
  equal(fitWidth([816, 1056], 472), (472 - 32) / 1056, 'fit width: the widest page in view')
  equal(fitWidth([100], 4000), 4, 'fit width: never past 400%')
  equal(fitPage({ w: 816, h: 1056 }, { w: 1000, h: 600 }), (600 - 32) / 1056, 'fit page: the tighter side')
  equal(stepUp(0.42, PDF_STEPS), 0.5, 'steps: from a fit at 42%, up to 50%')
  equal(stepUp(4, PDF_STEPS), 4, 'steps: 400% is the top')
  equal(stepDown(0.3, 0.2, PDF_STEPS), 0.25, 'steps: down to 25%')
  equal(minScale(0.2, PDF_STEPS), 0.2, 'range: a Fit page under 25% is the floor')
  equal(clampScale(9, 0.5, PDF_STEPS), 4, 'range: 400% at most')
  equal(stepUp(0.42), 0.5, 'steps: the image list is still the default')
  const pct = (s: number): string => `${Math.round(s * 100)}%`
  equal(zoomSaid(0.84, 'fit-width', 0.25, pct), 'Fit width, 84%', 'say: fit width')
  equal(zoomSaid(4, 4, 0.25, pct), 'Zoom 400%, the largest', 'say: the largest')
  equal(zoomSaid(1.5, 1.5, 0.25, pct), 'Zoom 150%', 'say: a stop')
}

// Kinds: .pdf opens as doc, a saved file tab comes back as one, and the doc tab finds and opens externally
{
  ok(kindForPath('/w/a.PDF') === 'doc' && kindForPath('/w/a.pdf.txt') === 'file', 'kind: .pdf is a doc')
  const tab = (kind: 'file' | 'doc', key: string) => ({ id: `${kind}:${key}`, kind, key, title: 'a.pdf', openedBy: 'user' as const, openedAt: 1, lastViewedAt: 1 })
  const set: SavedSet = { order: ['file:/w/a.pdf'], active: 'file:/w/a.pdf', tabs: { 'file:/w/a.pdf': { ...tab('file', '/w/a.pdf'), viewState: { kind: 'file', topLine: 4, offsetPx: 0, scrollLeft: 0 } } } }
  const r = restoreKinds(set)
  ok(r.active === 'doc:/w/a.pdf' && r.tabs['doc:/w/a.pdf']?.kind === 'doc' && !r.tabs['doc:/w/a.pdf']?.viewState, 'restore: a file tab of a PDF is its doc tab, view state dropped')
  equal(presentationOf({ kind: 'doc', key: '/w/a.pdf' }, false), null, 'presentation: one, no Source')
  ok(hasFind(null, { kind: 'doc', key: '/w/a.pdf' }) && opensDefault('doc', null), 'doc: takes find, opens in its default app')
  const rows = paneRows([{ ...tab('doc', '/w/a.pdf'), selection: { page: 2, text: 'x', nth: 0 } }], '/w', '/Users/me', { inDraft: () => false, minted: () => false, changeRead: null })
  ok(rows.length === 1 && rows[0].input?.kind === 'file', 'pane rows: a PDF tab offers its whole file')
  const e = (viewState: unknown) => parseEntry({ set: { order: ['doc:/w/a.pdf'], active: null, tabs: { 'doc:/w/a.pdf': { ...tab('doc', '/w/a.pdf'), viewState } } }, open: true, full: false, browserTabs: null })
  const kept = e({ kind: 'doc', page: 3, zoom: 'fit-page', offset: 0.25, pages: 9, find: 'latency' })?.set.tabs['doc:/w/a.pdf']?.viewState
  equal(JSON.stringify(kept), JSON.stringify({ kind: 'doc', page: 3, zoom: 'fit-page', offset: 0.25, pages: 9, find: 'latency' }), 'persist: the doc place, zoom and count')
  equal(e({ kind: 'doc', page: 3, zoom: 1.5, offsetPx: 40 }), null, 'persist: the old offsetPx shape is refused')
}

// Main: the head before any range, reads bound to that revision, and the hash of what it opened
{
  const fx = realpathSync(mkdtempSync('/tmp/clui-pdf-'))
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(100 * 1024, 0x20)])
  writeFileSync(join(fx, 'a.pdf'), pdf)
  writeFileSync(join(fx, 'empty.pdf'), '')
  writeFileSync(join(fx, 'huge.pdf'), '%PDF-')
  truncateSync(join(fx, 'huge.pdf'), BYTES_MAX + 1)
  const fa = createFileAccess({ cwd: () => fx, changedPaths: async () => [] })
  const res = (p: string) => fa.resolveAllowed('h', join(fx, p), { consumer: 'file', operation: 'read-file' })
  const r = await res('a.pdf')
  if (!r.ok) throw new Error('fixture unreadable')
  const h = await docHead(r, 64 * 1024)
  ok(h.ok && h.size === pdf.length && h.head?.length === 64 * 1024 && Buffer.from(h.head).subarray(0, 5).toString() === '%PDF-', 'head: size and the first 64 KiB')
  const e = await res('empty.pdf')
  const eh = e.ok ? await docHead(e, 64 * 1024) : e
  ok(eh.ok && eh.size === 0 && eh.head === null, 'head: an empty file reads nothing')
  const hg = await res('huge.pdf')
  const hh = hg.ok ? await docHead(hg, 64 * 1024) : hg
  ok(hh.ok && hh.size === BYTES_MAX + 1 && hh.head === null, 'head: past 200 MB nothing is read')
  ok(!(await docHead(r, CHUNK_MAX + 1)).ok, 'head: at most CHUNK_MAX')
  const st = await statFile(r)
  if (!st.ok) throw new Error('fixture unstattable')
  const sha = createHash('sha256').update(pdf).digest('hex').slice(0, 32)
  const v = await hashFile(r, st.revision)
  ok(v.ok && v.version === sha, 'hash: every byte, at the revision it opened')
  const chunk = await readBytes(r, { revision: st.revision, offset: 64 * 1024, length: CHUNK_MAX })
  ok(chunk.ok && chunk.bytes.length === pdf.length - 64 * 1024, 'range: a read past the end clamps')
  ok(!(await readBytes(r, { revision: st.revision, offset: 0, length: CHUNK_MAX + 1 })).ok, 'range: more than CHUNK_MAX is refused')
  appendFileSync(join(fx, 'a.pdf'), 'x')
  const stale = await readBytes(r, { revision: st.revision, offset: 0, length: 1 })
  ok(!stale.ok && stale.reason === 'changed', 'range: a stale revision is refused')
  const sv = await hashFile(r, st.revision)
  ok(!sv.ok && sv.reason === 'changed', 'hash: a stale revision is refused')
}

// Claude: surface_open takes page for a PDF and line for anything else; surface_state reports pages, never a quote
{
  const { surfaceServer, stateText } = await import('../src/main/surfaces/mcp-surface.ts')
  const { ChangeRefs } = await import('../src/main/surfaces/change-refs.ts')
  const sent: unknown[] = []
  const srv = surfaceServer(new ChangeRefs(), {
    cwd: () => '/w',
    authorize: async (_h, p) => (p === '/w/paper.pdf' || p === '/w/a.ts' ? 'file' : 'denied'),
    changed: async () => false,
    browserTabs: () => null,
    request: async (_h, op) => (sent.push(op), { ok: true, value: { outcome: 'shown' } })
  })
  srv.setPresentation('h', true)
  const said = async (args: Record<string, unknown>): Promise<string> => ((await srv.call('h', 'surface_open', args)).content[0] as { text: string }).text
  const both = 'surface_open takes page for a PDF and line for other files.'
  equal(await said({ path: 'paper.pdf', line: 3 }), both, 'claude: line on a PDF is refused')
  equal(await said({ path: 'a.ts', page: 2 }), both, 'claude: page on another file is refused')
  equal(await said({ path: 'paper.pdf', page: 0 }), 'page is a whole number from 1 to 1000000.', 'claude: page from 1')
  await said({ path: 'paper.pdf', page: 40, focus: true })
  equal(JSON.stringify((sent.at(-1) as { args: unknown }).args), JSON.stringify({ kind: 'file', path: '/w/paper.pdf', page: 40, focus: true }), 'claude: the page reaches the renderer')
  const line = stateText(
    { pane: 'open', width: 'half', session: 'shown', tabs: [], active: { kind: 'doc', path: '/w/paper.pdf', claude: true, unseen: false, page: 40, pages: 300, selection: { page: 12, endPage: 14, what: 'text' }, highlight: { page: 40 } } },
    { rel: (p) => p.replace('/w/', ''), browser: null }
  )
  equal(line?.split('\n')[0], 'Pane: open (half), session shown · active: doc paper.pdf page 40 of 300 (user selection text on pages 12 to 14, Claude highlight page 40, opened by Claude)', 'claude: a PDF tab by its pages')

  const { useSession, openForClaude, paneFacts, notePaneInput } = await import('../src/renderer/src/store.ts')
  notePaneInput(0)
  const w = globalThis as { window?: unknown }
  const prev = w.window
  w.window = { clui: new Proxy({}, { get: () => async () => true }) }
  const slice = { handleId: 'd1', cwd: '/w', browser: null, paneOpen: true, surfacePaneFull: false, paneAutoOpen: false, paneAutoOpenSuppressed: false, pendingPermissions: [], annotate: { at: null, note: null }, changes: [], restoreNote: null, surfaces: { order: [], active: null, tabs: {}, browserLastViewedAt: {}, browserUnseen: {} } }
  useSession.setState({ sessions: { d1: slice } as never, activeHandleId: 'd1', viewingSubagent: null, settingsSection: null, stageWide: true })
  openForClaude('d1', { kind: 'file', path: '/w/paper.pdf', page: 400, focus: true })
  const t = useSession.getState().sessions.d1.surfaces.tabs['doc:/w/paper.pdf']
  ok(t?.kind === 'doc' && t.location?.page === 400 && t.highlight?.page === 400 && !t.selection, "claude: a page opens the doc tab there, as Claude's highlight")
  useSession.getState().setSurfaceView('d1', 'doc:/w/paper.pdf', { viewState: { kind: 'doc', page: 300, zoom: 'fit-width', offset: 0, pages: 300 }, selection: { page: 12, text: 'the latency table', nth: 0 } })
  const f = (paneFacts('d1') as { active?: Record<string, unknown> }).active
  equal(JSON.stringify(f), JSON.stringify({ kind: 'doc', path: '/w/paper.pdf', claude: true, unseen: false, page: 300, pages: 300, selection: { page: 12, what: 'text' }, highlight: { page: 400 } }), 'claude: facts carry pages and what, never the quote')
  w.window = prev
}
