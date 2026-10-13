// Boundary: the site key decides which Gate and which saved login apply, and the one-time
// code must match what an authenticator shows, so both are pinned here.
import { localNetVerdict, siteKeyOf } from '../src/shared/browser.ts'
import { totp } from '../src/main/browser/totp.ts'
import { equal } from './support/harness.mjs'

equal(siteKeyOf('https://github.com/org/repo'), 'github.com', 'site: plain host')
equal(siteKeyOf('https://www.GitHub.com/'), 'github.com', 'site: www and case fold')
equal(siteKeyOf('https://docs.github.com/x'), 'docs.github.com', 'site: other subdomains stay separate')
equal(siteKeyOf('http://localhost:5173/'), 'localhost:5173', 'site: single-label host keeps its port')
equal(siteKeyOf('http://127.0.0.1:8080/a'), '127.0.0.1:8080', 'site: IP literal keeps its port')
equal(siteKeyOf('file:///etc/passwd'), null, 'site: file URLs have no site')
equal(siteKeyOf('javascript:alert(1)'), null, 'site: javascript URLs have no site')
equal(siteKeyOf('not a url'), null, 'site: garbage has no site')
// Boundary: local network access is per site, asked only by a top frame, and an embedded frame
// never rides on its page's grant.
const decided = (m: Record<string, boolean>) => (site: string): boolean | undefined => m[site]
const top = 'https://www.example.com/login'
equal(JSON.stringify(localNetVerdict(top, true, 'https://www.example.com', decided({}))), JSON.stringify({ grant: false, ask: 'example.com' }), 'net: undecided top frame asks under the site key')
equal(JSON.stringify(localNetVerdict(top, true, 'https://example.com', decided({ 'example.com': true }))), JSON.stringify({ grant: true, ask: null }), 'net: allowed top frame is granted')
equal(JSON.stringify(localNetVerdict(top, true, 'https://example.com', decided({ 'example.com': false }))), JSON.stringify({ grant: false, ask: null }), 'net: blocked top frame is denied without asking')
equal(JSON.stringify(localNetVerdict(top, false, 'https://example.com', decided({ 'example.com': true }))), JSON.stringify({ grant: true, ask: null }), 'net: same-site frame of an allowed page is granted')
equal(JSON.stringify(localNetVerdict(top, false, 'https://evil.test', decided({ 'example.com': true, 'evil.test': true }))), JSON.stringify({ grant: false, ask: null }), 'net: cross-site frame is denied even when its own site is allowed')
equal(JSON.stringify(localNetVerdict(top, false, 'https://example.com', decided({}))), JSON.stringify({ grant: false, ask: null }), 'net: a frame never asks')
equal(JSON.stringify(localNetVerdict('https://a.test/', false, 'https://example.com', decided({ 'example.com': true }))), JSON.stringify({ grant: false, ask: null }), 'net: a frame is judged by the top site, not its own')
equal(JSON.stringify(localNetVerdict('about:blank', true, 'null', decided({}))), JSON.stringify({ grant: false, ask: null }), 'net: an opaque origin has no site and never asks')
// RFC 6238 appendix B: secret "12345678901234567890", T=59s gives 94287082 at 8 digits.
equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000, 8), '94287082', 'totp: RFC 6238 vector')
equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000), '287082', 'totp: six digits')

// Boundary: the vault is the only store of secrets. The renderer-facing list must never carry
// a password or seed, an edit with no password keeps it, and an unreadable file must never
// read as empty (the next save would overwrite the user's logins).
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from './support/electron-stub.mjs'
import { listLogins, saveLogin, secretOf, loginsForSite, removeLogin } from '../src/main/browser/vault.ts'
import { ok } from './support/harness.mjs'

let threw = ''
const saved = await saveLogin({ site: 'https://www.Example.com/login', username: 'a@example.com', password: 'pw-1', totpSeed: 'GEZDGNBV' })
equal(saved.site, 'example.com', 'vault: site normalised through the site key')
equal(saved.hasTotp, true, 'vault: seed flagged, not returned')
ok(!JSON.stringify(await listLogins()).includes('pw-1') && !JSON.stringify(await listLogins()).includes('GEZDGNBV'), 'vault: list carries no password or seed')
await saveLogin({ id: saved.id, site: 'example.com', username: 'b@example.com', password: '' })
equal((await secretOf(saved.id, 'example.com'))?.password, 'pw-1', 'vault: edit with a blank password keeps it')
equal(await secretOf(saved.id, 'evil.example'), null, 'vault: a secret is only released for its own site')
threw = ''
await saveLogin({ id: saved.id, site: 'evil.example', username: 'b@example.com', password: '' }).catch((e) => (threw = e.message))
equal(threw, 'Enter the password again to use this login on another site.', 'vault: moving a login to another site needs a new password')
equal((await loginsForSite('example.com'))[0]?.username, 'b@example.com', 'vault: edit updates the username')
threw = ''
await saveLogin({ site: 'example.com', username: 'c', password: 'x', totpSeed: 'not base32!' }).catch((e) => (threw = e.message))
equal(threw, 'Not a base32 setup key', 'vault: a bad seed is refused without echoing it')
threw = ''
await saveLogin({ site: 'file:///etc', username: 'c', password: 'x' }).catch((e) => (threw = e.message))
equal(threw, 'Enter a site like github.com.', 'vault: a site with no key is refused')
await removeLogin(saved.id)
equal((await listLogins()).length, 0, 'vault: remove')
await writeFile(join(app.getPath('userData'), 'browser-vault.bin'), 'garbage')
threw = ''
await listLogins().catch((e) => (threw = e.message))
ok(threw.length > 0, 'vault: an undecryptable file throws instead of reading as empty')

// Boundary: the MCP server is reachable by anything on localhost, so the Origin/Host/token
// gates and the JSON-RPC shapes the CLI relies on are pinned here against a stub manager.
import { request } from 'node:http'
import { BrowserMcpServer, fillAllowed, pressKeys, targetTab, TOOLS } from '../src/main/browser/mcp.ts'
import { keyEvent } from '../src/main/browser/cdp.ts'

// Boundary: press sends real key events, so a page's keydown handler sees the key, code and keyCode
// a keyboard would give it, and only printables carry text (text is what makes a character).
equal(JSON.stringify(keyEvent('Enter')), JSON.stringify({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }), 'key: Enter types a carriage return')
equal(JSON.stringify(keyEvent('ArrowLeft')), JSON.stringify({ key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, }), 'key: arrows carry no text')
// No physical-key code rides along: macOS would read it as a Globe shortcut (emoji picker, Dictation).
ok(['a', 'e', 'Enter', 'ArrowLeft', ' ', '5'].every((k) => keyEvent(k) && !('nativeVirtualKeyCode' in keyEvent(k)!)), 'key: no nativeVirtualKeyCode')
equal(keyEvent('Backspace')?.windowsVirtualKeyCode, 8, 'key: Backspace')
equal(keyEvent('Tab')?.text, undefined, 'key: Tab carries no text')
equal(JSON.stringify(keyEvent('a')), JSON.stringify({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, text: 'a' }), 'key: a lowercase letter')
equal(keyEvent('A')?.modifiers, 8, 'key: an uppercase letter holds shift')
equal(keyEvent('a')?.modifiers, undefined, 'key: a lowercase letter holds nothing')
equal(keyEvent('1')?.code, 'Digit1', 'key: digit code')
equal(keyEvent(' ')?.code, 'Space', 'key: space')
equal(keyEvent('é')?.text, 'é', 'key: any single character types itself')
equal(keyEvent('Enterr'), null, 'key: an unknown name is refused')
equal(keyEvent('hello'), null, 'key: a word is not a key')

equal(JSON.stringify(pressKeys('Enter')), '["Enter"]', 'press: one key as a string')
equal(JSON.stringify(pressKeys(['a', '+', ' '])), '["a","+"," "]', 'press: a lone plus is the plus key')
ok(typeof pressKeys(['Control+a']) === 'string' && (pressKeys(['Control+a']) as string).includes('modifier'), 'press: a combination is refused')
equal(pressKeys(Array(51).fill('a')), 'press takes at most 50 keys per call.', 'press: more than 50 keys is refused')
equal((pressKeys(Array(50).fill('a')) as string[]).length, 50, 'press: 50 keys pass')
ok(typeof pressKeys([]) === 'string' && typeof pressKeys(undefined) === 'string' && typeof pressKeys([1]) === 'string', 'press: no keys or non-strings are refused')
ok(typeof pressKeys(['hello']) === 'string', 'press: text is refused toward type')

ok(fillAllowed('https://example.com/login') && fillAllowed('http://127.0.0.1:8080/') && fillAllowed('http://localhost/'), 'fill: https and this machine')
ok(!fillAllowed('http://example.com/login') && !fillAllowed('http://127.0.0.1.evil.example/'), 'fill: plain http elsewhere is refused')

// Boundary: every page tool takes a tab, and a call lands in the tab it names, else the one Claude
// last used, else the viewed one. A tab that isn't open is refused, never silently redirected.
const PAGE = ['navigate', 'snapshot', 'click', 'type', 'scroll', 'press', 'hover', 'back', 'autofill_login']
ok(TOOLS.filter((t) => PAGE.includes(t.name)).every((t) => (t.inputSchema.properties as Record<string, { type?: string }>).tab?.type === 'number'), 'tabs: every page tool takes an optional tab')
ok(TOOLS.filter((t) => PAGE.includes(t.name)).every((t) => !('required' in t.inputSchema) || !(t.inputSchema.required as string[]).includes('tab')), 'tabs: tab is never required on a page tool')
equal(JSON.stringify((TOOLS.find((t) => t.name === 'close_tab')?.inputSchema as { required?: string[] }).required), '["tab"]', 'tabs: close_tab requires its tab')
equal(targetTab(undefined, [1, 2, 3], 2, 1), 2, 'tabs: no tab goes to the one last used')
equal(targetTab(3, [1, 2, 3], 2, 1), 3, 'tabs: a named open tab wins')
equal(targetTab(undefined, [1, 3], 2, 3), 3, 'tabs: a closed last-used tab falls back to the viewed one')
equal(targetTab(2, [1, 3], 1, 1), "There's no tab 2. Call tabs to see the open tabs.", 'tabs: a closed tab is refused')
ok(typeof targetTab('1', [1], 1, 1) === 'string', 'tabs: a non-number tab is refused')

const stubManager = { tabsOf: () => null, beginTool: () => 'The browser is off for this session.', endTool: () => {} }
const mcp = new BrowserMcpServer(stubManager as never)
const { url, token } = await mcp.endpoint('h1')
const { port, pathname } = new URL(url)

function call(opts: { method?: string; headers?: Record<string, string>; body?: unknown; path?: string }): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: opts.path ?? pathname, method: opts.method ?? 'POST', headers: { 'content-type': 'application/json', ...opts.headers } },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null }))
      }
    )
    req.on('error', reject)
    req.end(opts.body === undefined ? undefined : JSON.stringify(opts.body))
  })
}
const auth = { authorization: `Bearer ${token}` }
const rpc = (method: string, params?: unknown, id: number | null = 1) => ({ jsonrpc: '2.0', method, ...(id === null ? {} : { id }), ...(params ? { params } : {}) })

equal((await call({ body: rpc('tools/list') })).status, 401, 'mcp: no token is 401')
equal((await call({ headers: { authorization: 'Bearer ' + 'f'.repeat(64) }, body: rpc('tools/list') })).status, 401, 'mcp: wrong token is 401')
equal((await call({ headers: { authorization: 'Bearer ' + 'é' + token.slice(1) }, body: rpc('tools/list') })).status, 401, 'mcp: a same-length token of other byte length is 401, not a throw')
equal((await call({ headers: { ...auth, origin: 'https://example.com' }, body: rpc('tools/list') })).status, 403, 'mcp: any Origin is 403')
equal((await call({ headers: { ...auth, host: `localhost:${port}` }, body: rpc('tools/list') })).status, 403, 'mcp: a Host other than 127.0.0.1:<port> is 403')
equal((await call({ headers: auth, path: '/mcp/other', body: rpc('tools/list') })).status, 401, "mcp: one session's token can't reach another handle")
equal((await call({ method: 'GET', headers: { ...auth, accept: 'text/event-stream' } })).status, 405, 'mcp: GET is 405')
equal((await call({ headers: auth, body: rpc('notifications/initialized', undefined, null) })).status, 202, 'mcp: a notification is 202')
const init = await call({ headers: auth, body: rpc('initialize', { protocolVersion: '2099-01-01' }) })
equal(init.json?.result?.protocolVersion, '2099-01-01', 'mcp: initialize echoes the protocol version')
equal((await call({ headers: auth, body: rpc('server/discover') })).json?.error?.code, -32601, 'mcp: an unknown method is -32601')
const listed = await call({ headers: auth, body: rpc('tools/list') })
equal(listed.json?.result?.tools?.map((t: { name: string }) => t.name).join(','), 'navigate,snapshot,click,type,scroll,press,hover,back,autofill_login,console,network,network_body,cookies,storage,tabs,new_tab,close_tab', 'mcp: tools/list')
const called = await call({ headers: auth, body: rpc('tools/call', { name: 'snapshot', arguments: {} }) })
equal(called.json?.result?.content?.[0]?.text, 'The browser is off for this session.', 'mcp: a refused call answers with text')
mcp.revoke('h1')
equal((await call({ headers: auth, body: rpc('tools/list') })).status, 401, 'mcp: a revoked token is 401')

// Boundary: tab calls run in parallel across tabs but in order within one, the CLI's tool_use id
// reaches the renderer with the tab the call resolved to, and closing a tab answers its pending
// call at once instead of leaving it on page work that will never finish.
const closers = new Map<number, Set<(by: 'agent' | 'user') => void>>()
const close = (tab: number, by: 'agent' | 'user'): void => closers.get(tab)?.forEach((fn) => fn(by))
const toolTabs: string[] = []
const begun: number[] = []
const tabsStub = {
  tabsOf: () => ({ viewed: 1, lastUsed: 2, tabs: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
  used: () => {},
  toolTab: (_h: string, id: string, tab: number) => toolTabs.push(`${id}:${tab}`),
  onTabClosed: (_h: string, tab: number, fn: (by: 'agent' | 'user') => void) => {
    if (!closers.has(tab)) closers.set(tab, new Set())
    closers.get(tab)?.add(fn)
    return () => closers.get(tab)?.delete(fn)
  },
  beginTool: (_h: string, tab: number) => {
    begun.push(tab)
    return new Promise(() => {})
  },
  endTool: () => {}
}
const tabsMcp = new BrowserMcpServer(tabsStub as never)
const pending2 = tabsMcp.callTool('h2', 'snapshot', {}, 'toolu_1')
const pending3 = tabsMcp.callTool('h2', 'snapshot', { tab: 3 })
const queued2 = tabsMcp.callTool('h2', 'click', { tab: 2 })
await new Promise((r) => setTimeout(r, 0))
equal(toolTabs.join(','), 'toolu_1:2', 'tabs: tool-tab carries the resolved default tab')
equal(begun.join(','), '2,3', 'tabs: calls in different tabs run in parallel, one at a time within a tab')
const said = (r: { content: Array<{ type: string; text?: string }>; isError?: boolean }): string => `${r.isError ? 'error: ' : ''}${r.content[0]?.text}`
close(2, 'user')
equal(said(await pending2), 'error: The user closed tab 2.', 'tabs: the user closing a tab answers its pending call')
equal(said(await queued2), 'error: The user closed tab 2.', 'tabs: and the call queued behind it')
close(3, 'agent')
equal(said(await pending3), 'error: Tab 3 was closed.', "tabs: Claude's own close answers a call queued in that tab")
equal(said(await tabsMcp.callTool('h2', 'click', { tab: 9 })), "error: There's no tab 9. Call tabs to see the open tabs.", 'tabs: a call naming a closed tab is refused')

// The debug tools put page data into the transcript, so what they hide is pinned here.
import { requestUrl, scrub, isLocal } from '../src/main/browser/mcp.ts'
equal(requestUrl('https://cdn.example.com/a.js?sig=SECRET&exp=1&exp=2'), 'https://cdn.example.com/a.js?sig=…&exp=…', 'debug: off-machine query keeps names only')
equal(requestUrl('https://user:pw@example.com/x'), 'https://example.com/x', 'debug: userinfo never shown')
equal(requestUrl('http://localhost:5173/api?token=abc'), 'http://localhost:5173/api?token=abc', 'debug: localhost keeps query values')
equal(requestUrl('https://example.com/p#frag'), 'https://example.com/p', 'debug: fragment dropped')
equal(requestUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,…', 'debug: data URL shows only its type')
equal(scrub('pw=hunter 2&x hunter%202', new Set(['hunter 2'])), 'pw=•••&x •••', 'debug: a filled password is scrubbed raw and URL-encoded')
ok(isLocal(new URL('http://127.0.0.1:8080/')) && isLocal(new URL('http://[::1]/')) && isLocal(new URL('http://app.localhost/')), 'debug: loopback hosts are local')
ok(!isLocal(new URL('https://localhost.evil.com/')) && !isLocal(new URL('https://example.com/')), 'debug: lookalike hosts are not local')

// A typed site for the per-site clear and the login form: one word with a dot, or localhost or an IP.
import { siteFromInput } from '../src/shared/browser.ts'
equal(siteFromInput('localhost:5173'), 'localhost:5173', 'site input: localhost keeps its port')
equal(siteFromInput('https://www.GitHub.com/org'), 'github.com', 'site input: URL folds to its site')
equal(siteFromInput('127.0.0.1:8080'), '127.0.0.1:8080', 'site input: IP with port')
equal(siteFromInput('not a site'), null, 'site input: words with spaces are not a site')
equal(siteFromInput('intranet'), null, 'site input: a bare word is not a site')
equal(siteFromInput('   '), null, 'site input: blank is not a site')

// Boundary: browser-sites.json carries Claude's approvals and the pages' local network decisions
// side by side; an older file loads unchanged and the new map never reads as an approved site.
{
  const { readFile: read } = await import('node:fs/promises')
  const path = join(app.getPath('userData'), 'browser-sites.json')
  await writeFile(path, JSON.stringify({ 'github.com': { approvedMs: 5 } }))
  const sites = await import('../src/main/browser/sites.ts')
  equal(await sites.listLocalNet().then(() => sites.localNetCached('github.com')), undefined, 'sites: an old file has no local network decisions')
  await sites.decideLocalNet('example.com', true)
  await sites.decideLocalNet('evil.test', false)
  const onDisk = JSON.parse(await read(path, 'utf8'))
  equal(JSON.stringify(onDisk['github.com']), '{"approvedMs":5}', 'sites: approvals keep their old shape')
  equal(Object.keys(onDisk.localNetwork).sort().join(), 'evil.test,example.com', 'sites: decisions live under localNetwork')
  equal((await sites.listSites()).map((s) => s.site).join(), 'github.com', 'sites: a decision is not an approval')
  equal(`${sites.localNetCached('example.com')} ${sites.localNetCached('evil.test')}`, 'true false', 'sites: allow and block read back')
  await sites.forgetLocalNet('example.com')
  equal(sites.localNetCached('example.com'), undefined, 'sites: forget makes the site ask again')
  equal((await sites.listLocalNet()).map((s) => s.site).join(), 'evil.test', 'sites: forget removes the row')
}

// Boundary: a ref names one element in one tab's one document. A stale ref must fail with the reason,
// never land on whatever the new page numbered the same, and the element is re-read before input lands.
{
  const { parseRef, formatRef, refTarget, PAGE_REFS } = await import('../src/main/browser/cdp.ts')
  const { refMiss, badRef } = await import('../src/main/browser/mcp.ts')
  const r = { tab: 2, doc: '0123abcd', n: 12 }
  equal(formatRef(r), 't2:d0123abcd:e12', 'ref: spelling')
  equal(JSON.stringify(parseRef('t2:d0123abcd:e12')), JSON.stringify(r), 'ref: round trip')
  ok([12, '12', 'e12', 't2:e12', 't2:d0123ABCD:e12', 't2:d0123abc:e12', ' t2:d0123abcd:e12', null].every((v) => parseRef(v) === null), 'ref: numbers, bare locals and near misses are refused')
  equal(refMiss(r, 'tab', ''), 'Ref 12 is from tab 2.', 'ref: wrong tab')
  equal(refMiss(r, 'gone', 'https://x.test/'), 'Ref 12 is no longer on the page. Take a new snapshot.', 'ref: removed')
  equal(refMiss(r, 'page', 'https://x.test/b'), 'Ref 12 belongs to the previous page (now https://x.test/b). Take a new snapshot.', 'ref: new document')
  equal(refMiss(r, 'hidden', ''), 'Ref 12 has no visible box (hidden or zero-size).', 'ref: zero size')
  equal(badRef(12), "12 isn't a snapshot ref. Pass a ref exactly as snapshot lists it, like t1:d0f3a9c2e:e12.", 'ref: a number is not a ref')
  ok(parseRef('t1:d0f3a9c2e:e12') !== null, 'ref: the example in the refusal parses')
  ok(TOOLS.filter((t) => ['click', 'type', 'press', 'hover'].includes(t.name)).every((t) => (t.inputSchema.properties as Record<string, { type?: string }>).ref?.type === 'string'), 'ref: every tool takes refs as strings')

  // The world's table, run against plain objects: numbers stick while the table is for the current document.
  const table = new Function(`return ${PAGE_REFS}`)() as (w: object, cur: string | null, next: string) => { doc: string; id: (e: object) => number }
  const w = {}
  const [a, b, c] = [{}, {}, {}]
  const t1 = table(w, null, 'aaaaaaaa')
  equal(`${t1.doc} ${t1.id(a)} ${t1.id(b)}`, 'aaaaaaaa 1 2', 'ref table: a fresh world adopts the next nonce')
  const t2 = table(w, 'aaaaaaaa', 'bbbbbbbb')
  equal(`${t2.doc} ${t2.id(b)} ${t2.id(c)} ${t2.id(a)}`, 'aaaaaaaa 2 3 1', 'ref table: a re-snapshot keeps numbers and extends them')
  const t3 = table(w, 'zzzzzzzz', 'cccccccc')
  equal(`${t3.doc} ${t3.id(c)}`, 'cccccccc 1', 'ref table: a world from another document restarts under a new nonce')
  equal(refTarget(3), 'window.__cluiRefs?.els.get(3)?.deref()', 'ref: pill target dereferences the WeakRef')

  // actOnRef against a stub page: every refusal happens before input, and input lands at the re-read box.
  type Spot = { x: number; y: number; password: boolean } | { why: string }
  let spots: Spot[] = []
  const clicks: string[] = []
  const worldCode: string[] = []
  const wc = {
    isLoading: () => false,
    isDestroyed: () => false,
    getURL: () => 'https://example.com/b',
    getTitle: () => 'B',
    executeJavaScriptInIsolatedWorld: (_w: number, [{ code }]: { code: string }[]) => (worldCode.push(code), Promise.resolve(false))
  }
  const cdp = {
    locate: () => Promise.resolve(spots.shift() ?? { why: 'gone' }),
    click: (x: number, y: number) => (clicks.push(`${x},${y}`), Promise.resolve()),
    hover: (x: number, y: number) => (clicks.push(`hover ${x},${y}`), Promise.resolve()),
    focusedIsPassword: () => Promise.resolve(false),
    insertText: () => Promise.resolve(),
    listInteractive: () => Promise.resolve({ doc: '0123abcd', items: [[3, 'button "Go"'], [7, 'input "Q"']], shown: true, keys: 0 })
  }
  const pageStub = {
    tabsOf: () => ({ viewed: 1, lastUsed: 1, tabs: [{ id: 1 }] }),
    used: () => {},
    toolTab: () => {},
    onTabClosed: () => () => {},
    beginTool: () => Promise.resolve(null),
    endTool: () => {},
    page: () => ({ wc, cdp, view: {} })
  }
  const pm = new BrowserMcpServer(pageStub as never)
  const go = async (name: string, args: Record<string, unknown>, queued: Spot[] = []): Promise<string> => {
    spots = queued
    clicks.length = 0
    return said(await pm.callTool('h3', name, args))
  }
  const ref = 't1:d0123abcd:e3'
  const snapText = await go('snapshot', {})
  ok(snapText.endsWith('\n\nt1:d0123abcd:e3 button "Go"\nt1:d0123abcd:e7 input "Q"'), 'act: snapshot lists full refs')
  equal(await go('click', { ref: 3 }), `error: ${badRef(3)}`, 'act: a numeric ref is refused')
  equal(await go('click', { ref: 't2:d0123abcd:e3' }), 'error: Ref 3 is from tab 2.', 'act: a ref from another tab is refused')
  equal(await go('click', { ref }, [{ why: 'page' }]), 'error: Ref 3 belongs to the previous page (now https://example.com/b). Take a new snapshot.', 'act: a ref from the previous page names it')
  equal(await go('hover', { ref }, [{ why: 'hidden' }]), 'error: Ref 3 has no visible box (hidden or zero-size).', 'act: zero size')
  equal(await go('click', { ref }, [{ x: 1, y: 1, password: false }, { why: 'gone' }]), 'error: Ref 3 is no longer on the page. Take a new snapshot.', 'act: removed during the cursor glide')
  equal(clicks.length, 0, 'act: and nothing was clicked')
  equal(await go('click', { ref }, [{ x: 1, y: 1, password: false }, { x: 5, y: 6, password: false }]), 'clicked', 'act: click by ref')
  equal(clicks.join(' '), '5,6', 'act: input lands at the re-read box')
  equal(await go('hover', { ref }, [{ x: 1, y: 1, password: false }, { x: 2, y: 2, password: false }]), 'Hovering over 3.', 'act: hover by ref')
  worldCode.length = 0
  const refused = await go('type', { ref, text: 'x' }, [{ x: 1, y: 1, password: true }])
  ok(refused.startsWith('error: Typing into password fields is blocked.') && clicks.length === 0, 'act: type into a password field is refused before any input')
  ok(worldCode.some((c) => c.includes(`pill(${refTarget(3)}, `)), 'act: the refusal pill points at the ref')
  ok((await go('press', { keys: 'x', ref }, [{ x: 1, y: 1, password: false }, { x: 1, y: 1, password: true }])).startsWith('error: Pressing keys in password fields is blocked.') && clicks.length === 0, 'act: a field that turned into a password field is refused at the re-read')
  equal(await go('type', { ref, text: 'x' }, [{ x: 1, y: 1, password: false }, { x: 1, y: 1, password: false }]), 'Typed into 3.', 'act: type by ref')
}
