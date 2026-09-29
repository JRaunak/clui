// Boundary: the site key decides which Gate and which saved login apply, and the one-time
// code must match what an authenticator shows, so both are pinned here.
import { siteKeyOf } from '../src/shared/browser.ts'
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
import { BrowserMcpServer, fillAllowed, pressKeys } from '../src/main/browser/mcp.ts'
import { keyEvent } from '../src/main/browser/cdp.ts'

// Boundary: press sends real key events, so a page's keydown handler sees the key, code and keyCode
// a keyboard would give it, and only printables carry text (text is what makes a character).
equal(JSON.stringify(keyEvent('Enter')), JSON.stringify({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' }), 'key: Enter types a carriage return')
equal(JSON.stringify(keyEvent('ArrowLeft')), JSON.stringify({ key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 }), 'key: arrows carry no text')
equal(keyEvent('Backspace')?.windowsVirtualKeyCode, 8, 'key: Backspace')
equal(keyEvent('Tab')?.text, undefined, 'key: Tab carries no text')
equal(JSON.stringify(keyEvent('a')), JSON.stringify({ key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, text: 'a' }), 'key: a lowercase letter')
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

const stubManager = { beginTool: () => 'The browser is off for this session.', endTool: () => {} }
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
equal(listed.json?.result?.tools?.map((t: { name: string }) => t.name).join(','), 'navigate,snapshot,click,type,scroll,press,hover,back,autofill_login', 'mcp: tools/list')
const called = await call({ headers: auth, body: rpc('tools/call', { name: 'snapshot', arguments: {} }) })
equal(called.json?.result?.content?.[0]?.text, 'The browser is off for this session.', 'mcp: a refused call answers with text')
mcp.revoke('h1')
equal((await call({ headers: auth, body: rpc('tools/list') })).status, 401, 'mcp: a revoked token is 401')
