// The HTML view's renderer rules: which presentation a tab shows, the policy line, and which strip wins.
import { markNoPreview, presentationOf, hasFind } from '../src/renderer/src/lib/presentation.ts'
import { blockedRow, hostLabel, hostsOf, noticeOf, policyParts } from '../src/renderer/src/lib/htmlView.ts'
import { equal } from './support/harness.mjs'

const same = (a: unknown, b: unknown, m: string): void => equal(JSON.stringify(a), JSON.stringify(b), m)

// Presentation
{
  const tab = (key: string, mode?: 'auto' | 'source' | 'preview', kind: 'file' | 'artifact' | 'tree' = 'file') => ({ kind, key, ...(mode ? { mode } : {}) })
  equal(presentationOf(tab('/w/a.html'), false), 'preview', 'mode: a new HTML tab previews')
  equal(presentationOf(tab('/w/a.HTM', 'auto'), false), 'preview', 'mode: auto previews .htm in any case')
  equal(presentationOf(tab('/w/a.html'), true), 'source', 'mode: auto falls back to source when the preview is unavailable')
  equal(presentationOf(tab('/w/a.html', 'preview'), true), 'preview', 'mode: an explicit preview wins over unavailable')
  equal(presentationOf(tab('/w/a.html', 'source'), false), 'source', 'mode: an explicit source wins')
  equal(presentationOf(tab('/w/a.html', undefined, 'artifact'), false), 'preview', 'mode: artifact tabs preview')
  equal(presentationOf(tab('/w/a.ts'), false), null, 'mode: a file with no preview has no presentation')
  equal(presentationOf(tab('', undefined, 'tree'), false), null, 'mode: tree has no presentation')
  equal(presentationOf(undefined, false), null, 'mode: no tab')
}

// File actions
{
  const tab = (kind: 'file' | 'artifact' | 'tree', key: string, mode?: 'auto' | 'source' | 'preview') => ({ kind, key, ...(mode ? { mode } : {}) })
  equal(hasFind('h', tab('file', '/w/a.ts')), true, 'actions: a file tab')
  equal(hasFind('h', tab('artifact', '/w/a.html', 'source')), true, 'actions: an artifact showing Source is a file tab')
  equal(hasFind('h', tab('artifact', '/w/a.html')), false, 'find: an artifact showing Preview takes none')
  equal(hasFind('h', tab('file', '/w/a.html', 'preview')), false, 'find: an HTML Preview takes none')
  equal(hasFind('h', tab('tree', '')), false, 'actions: the tree is no file')
  equal(hasFind('h', undefined), false, 'actions: no tab')
  markNoPreview('h', '/w/out.html', 'denied')
  equal(hasFind('h', tab('file', '/w/out.html')), true, 'actions: a page that cannot preview falls back to Source')
}

// Policy line
{
  const art = (remote: boolean, data: boolean) => ({ artifact: true, remote, data })
  same(policyParts({ artifact: false, remote: false, data: false }, false), ['Runs offline', 'Only files in this folder'], 'policy: ordinary HTML')
  same(policyParts(art(true, false), false), ['Made by Claude', 'Web resources on', 'Data requests off'], 'policy: artifact default')
  same(policyParts(art(true, true), false), ['Made by Claude', 'Web resources on', 'Data requests on'], 'policy: artifact both on')
  same(policyParts(art(false, false), false), ['Made by Claude', 'Web resources off', 'Data requests off'], 'policy: artifact both off')
  same(policyParts(art(false, true), false), ['Made by Claude', 'Web resources off', 'Data requests on'], 'policy: artifact data only')
  equal(policyParts(art(true, false), true)[0], 'Made by Claude, changed since', 'policy: changed since')
  equal(policyParts({ artifact: false, remote: false, data: false }, true)[0], 'Runs offline', 'policy: changed since never marks ordinary HTML')
}

// Hosts
{
  const text = (h: string[]): string => {
    const { shown, sep, rest } = hostsOf(h)
    return `${shown.join(sep)}${rest}`
  }
  equal(text([]), '', 'hosts: none')
  equal(text(['https://a.com']), 'a.com', 'hosts: one')
  equal(text(['https://a.com', 'https://b.com']), 'a.com and b.com', 'hosts: two')
  equal(text(['https://a.com', 'https://b.com', 'https://c.com']), 'a.com, b.com and 1 more', 'hosts: three')
  equal(text(['a', 'b', 'c', 'd', 'e']), 'a, b and 3 more', 'hosts: five')
  equal(text(['self', 'https://api.x']), 'this folder and api.x', 'hosts: self reads as this folder')
  equal(text(['http://a.com', 'ws://b.com', 'wss://c.com']), 'http://a.com, ws://b.com and 1 more', 'hosts: only https drops its scheme')
  equal(hostLabel('wss://c.com:8443'), 'wss://c.com:8443', 'hosts: wss keeps its scheme')
  equal(hostLabel('https://cdn.jsdelivr.net'), 'cdn.jsdelivr.net', 'hosts: https reads as the bare host')
  equal(text(Array.from({ length: 50 }, (_, i) => `h${i}`)), 'h0, h1 and 48 more', 'hosts: the 50 main sends')
}

// Blocked rows and strip priority
{
  const b = (remote: number, data: number, ev = false) => ({ remote, data, eval: ev, hosts: [] })
  const art = (remote: boolean, data: boolean) => ({ artifact: true, remote, data })
  const off = { artifact: false, remote: false, data: false }
  same(blockedRow(art(false, false), b(3, 2, true)), { cause: 'remote', count: 3 }, 'blocked: remote off wins first')
  same(blockedRow(art(true, false), b(3, 2, true)), { cause: 'data', count: 2 }, 'blocked: remote on, data off')
  same(blockedRow(art(true, true), b(0, 0, true)), { cause: 'eval', count: 0 }, 'blocked: eval on an artifact')
  same(blockedRow(art(true, true), b(1, 1)), null, 'blocked: nothing an artifact setting governs')
  same(blockedRow(off, b(0, 0, true)), { cause: 'eval', count: 0 }, 'blocked: eval beats offline on ordinary HTML')
  same(blockedRow(off, b(2, 3)), { cause: 'offline', count: 5 }, 'blocked: ordinary HTML counts every load')
  same(blockedRow(off, b(0, 0)), null, 'blocked: nothing blocked')
  equal(noticeOf({ changed: true, stuck: true, blocked: true }), 'changed', 'notice: N1 outranks the rest')
  equal(noticeOf({ changed: false, stuck: true, blocked: true }), 'stuck', 'notice: N2 outranks N3')
  equal(noticeOf({ changed: false, stuck: false, blocked: true }), 'blocked', 'notice: N3 alone')
  equal(noticeOf({ changed: false, stuck: false, blocked: false }), null, 'notice: none')
}
