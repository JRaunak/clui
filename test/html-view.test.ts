// Boundary: HTML views' capability scheme, page policy and the checks that decide what a page may run.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createFileAccess, readText, TEXT_MAX } from '../src/main/surfaces/files.ts'
import { capPath, climbOf, cspFor, createCaps, pageHref, pageUrlPath, rangeOf } from '../src/main/surfaces/protocol.ts'
import { claudeRecord, gesture, holdsClaudes, isClaudes, movedOf, refusalOf, superseding } from '../src/main/surfaces/html-view.ts'
import { isHtml } from '../src/shared/html-view.ts'
import type { TextRead } from '../src/shared/files.ts'
import { equal, ok } from './support/harness.mjs'

// Paths
{
  equal(JSON.stringify(capPath('/index.html')), '["index.html"]', 'cap path: a page')
  equal(JSON.stringify(capPath('/a%20b/c.css')), '["a b","c.css"]', 'cap path: decoded')
  equal(capPath('/%2e%2e%2fother%2ff.txt'), null, 'cap path: encoded traversal inside a segment')
  equal(capPath('/x/%2e%2e/y'), null, 'cap path: encoded .. segment')
  equal(capPath('/%2eenv'), null, 'cap path: encoded dotfile')
  equal(capPath('/.git/config'), null, 'cap path: dot directory')
  equal(capPath('/'), null, 'cap path: the root lists nothing')
  equal(capPath('/%E0%A4%A'), null, 'cap path: malformed escape')
  const root = '/w/proj/site'
  equal(pageUrlPath(root, 'm', 'a b.html'), '/m/m/m/a%20b.html', 'page url: a mask per folder, then the name')
  const climb = (p: string) => JSON.stringify(climbOf(p, 'm', root))
  equal(climb('/m/m/m/docs/x.html'), '{"up":0,"segs":["docs","x.html"]}', 'climb: below the page')
  equal(climb('/m/m/up.html'), '{"up":1,"segs":["up.html"]}', 'climb: one folder up survives the URL')
  equal(climb('/up.html'), '{"up":0,"segs":["up.html"]}', 'climb: no mask is rooted at the page, as a site root')
  equal(climb('/m/m/m/m/x'), '{"up":0,"segs":["m","x"]}', 'climb: a mask below the page is a name')
  equal(pageHref('clui-file://other/h/h/h/x.html', 'h', root), null, 'href: another host is not this page')
  equal(pageHref('clui-file://h/h/h/h/docs/x.html?q=1#setup', 'h', root), './docs/x.html#setup', 'href: query dropped, fragment kept')
  equal(pageHref('clui-file://h/h/up.html', 'h', root), '../../up.html', 'href: climb kept')
  equal(pageHref('clui-file://h/h/h/h/a%20b.html', 'h', root), './a%20b.html', 'href: stays encoded for resolveHref')
  equal(pageHref('file:///etc/hosts', 'h', root), 'file:///etc/hosts', 'href: file URL as written')
  equal(pageHref('mailto:a@b.c', 'h', root), null, 'href: other schemes are no file link')
}

// Policies
{
  const base =
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'"
  for (const remote of [false, true]) for (const data of [false, true]) equal(cspFor({ artifact: false, remote, data }), base, `csp: ordinary HTML is offline (remote ${remote}, data ${data})`)
  equal(cspFor({ artifact: true, remote: false, data: false }), base, 'csp: artifact with both off is the base')
  const remoteOn = cspFor({ artifact: true, remote: true, data: false })
  ok(remoteOn.includes("script-src 'self' 'unsafe-inline' https:") && remoteOn.includes("style-src 'self' 'unsafe-inline' https:") && remoteOn.includes("font-src 'self' data: https:"), 'csp: remote on adds https: to script, style and font')
  ok(remoteOn.includes("connect-src 'none'") && remoteOn.includes("img-src 'self' data: blob:;"), 'csp: remote on leaves connect and img alone')
  const dataOn = cspFor({ artifact: true, remote: false, data: true })
  ok(dataOn.includes("connect-src 'self' https: wss: http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*"), 'csp: data on opens connect-src to https, wss and localhost')
  ok(dataOn.includes("script-src 'self' 'unsafe-inline';"), 'csp: data on adds no script origins')
  const both = cspFor({ artifact: true, remote: true, data: true })
  ok(both.includes('https:;') && both.includes("connect-src 'self' https:"), 'csp: both on')
  for (const remote of [false, true]) for (const data of [false, true]) ok(!cspFor({ artifact: true, remote, data }).includes('unsafe-eval'), `csp: never unsafe-eval (remote ${remote}, data ${data})`)
}

// Gestures
{
  let t = 0
  const g = gesture(() => t)
  const key = { via: 'keyboard', meta: true, middle: false } as const
  equal(g.take(), null, 'gesture: none before any input')
  g.mark(key)
  t = 900
  equal(g.take(), key, 'gesture: a navigation within the second counts, with how it was made')
  equal(g.take(), null, 'gesture: consumed by the first navigation')
  g.mark(key)
  t = 1900
  equal(g.take(), key, 'gesture: exactly one second still counts')
  g.mark(key)
  t = 2901
  equal(g.take(), null, 'gesture: expires after one second')
}

// The artifact rule and changed-since
{
  const created = [{ created: true, after: '<p>1</p>' }, { created: false, after: '<p>2</p>' }]
  equal(JSON.stringify(claudeRecord('/w/a.html', created)), '{"artifact":true,"after":"<p>2</p>"}', 'artifact: a created .html, last write is the latest segment')
  equal(claudeRecord('/w/a.HTM', created).artifact, true, 'artifact: .htm in any case')
  equal(claudeRecord('/w/a.md', created).artifact, false, 'artifact: only HTML')
  equal(claudeRecord('/w/a.svg', created).artifact, false, 'artifact: SVG waits for 7B')
  equal(claudeRecord('/w/a.html', [{ created: false, after: 'x' }]).artifact, false, 'artifact: edited but not created by Claude')
  equal(claudeRecord('/w/a.html', [{ created: false, after: 'x' }, { created: true, after: 'y' }]).artifact, false, 'artifact: only a create in the first segment counts, as the tab strip reads it')
  equal(isHtml('/w/a.html.bak'), false, 'artifact: only a trailing .html counts')
  equal(JSON.stringify(claudeRecord('/w/a.html', null)), '{"artifact":false,"after":null}', 'artifact: unknown to the ledger')
  const read = (text: string, o: Partial<TextRead> = {}): TextRead => ({ ok: true, text, size: text.length, mtimeMs: 0, binary: false, truncated: false, unsupportedEncoding: false, revision: '', ...o })
  equal(isClaudes('<p>2</p>', read('<p>2</p>')), true, "changed-since: Claude's bytes")
  equal(isClaudes('<p>2</p>', read('<p>2</p>\n')), false, 'changed-since: any byte differs')
  equal(isClaudes('<p>2</p>', read('<p>2</p>', { truncated: true })), false, 'changed-since: a partial read never matches')
  equal(isClaudes(null, read('')), false, 'changed-since: no recorded write')
  equal(isClaudes('', read('')), true, 'changed-since: an empty write is still a write')
  equal(isClaudes('x', { ok: false, reason: 'missing' }), false, 'changed-since: unreadable')
}

// Opens of one tab
{
  const open = superseding()
  const first = open('h\0t')
  const second = open('h\0t')
  const elsewhere = open('h\0u')
  equal(first(), false, 'open: an earlier open in flight yields to the newer one')
  equal(second(), true, 'open: the newest leads')
  equal(second(), false, 'open: and says so once')
  equal(elsewhere(), true, 'open: another tab is its own sequence')
  const third = open('h\0t')
  equal(third(), true, 'open: a later open after one finished leads')
}

// Changes count only what the page loaded
{
  const seen = new Map([['/w/index.html', 'a'], ['/w/style.css', 'b'], ['/w/gone.js', 'c']])
  const now = new Map([['/w/index.html', 'a'], ['/w/style.css', 'b2'], ['/w/gone.js', ''], ['/w/notes.txt', 'z']])
  equal(JSON.stringify(movedOf(seen, now)), '["/w/style.css","/w/gone.js"]', 'served: a changed and a deleted asset count, a file the page never loaded does not')
  equal(movedOf(seen, new Map(seen)).length, 0, 'served: nothing moved')
}

// CSP refusals from the console
{
  const cap = 'ab'.repeat(16)
  const r = (m: string, artifact = true) => JSON.stringify(refusalOf(m, cap, artifact))
  equal(
    r(`Loading the script 'https://cdn.x.com/a.js' violates the following Content Security Policy directive: "script-src 'self' 'unsafe-inline'". Note that 'script-src-elem' was not explicitly set, so 'script-src' is used as a fallback. The action has been blocked.`),
    '{"group":"remote","host":"https://cdn.x.com"}',
    'refusal: a CDN script'
  )
  equal(r(`Connecting to 'clui-file://${cap}/data.json' violates the following Content Security Policy directive: "connect-src 'none'". The action has been blocked.`), '{"group":"data","host":"self"}', 'refusal: an adjacent fetch')
  equal(r(`Connecting to 'wss://api.x.com/s' violates the following Content Security Policy directive: "connect-src 'none'". The action has been blocked.`), '{"group":"data","host":"wss://api.x.com"}', 'refusal: a socket')
  equal(r(`Uncaught EvalError: Evaluating a string as JavaScript violates the following Content Security Policy directive because 'unsafe-eval' is not an allowed source of script: script-src 'self' 'unsafe-inline'".`), '{"group":"eval"}', 'refusal: eval')
  const img = `Loading the image 'https://x.com/a.png' violates the following Content Security Policy directive: "img-src 'self' data: blob:". The action has been blocked.`
  equal(r(img), 'null', 'refusal: an artifact image is no setting of the user')
  equal(r(img, false), '{"group":"remote","host":"https://x.com"}', 'refusal: an ordinary page counts every load')
  equal(r('Uncaught TypeError: x is not a function'), 'null', 'refusal: other console output')
  equal(r(`Fetch API cannot load https://api.x.com/z. Refused to connect because it violates the document's Content Security Policy.`), 'null', 'refusal: the fetch echo of a counted connect')
}

// Caps
{
  const fx = mkdtempSync('/tmp/clui-html-')
  const ws = join(realpathSync(fx), 'ws')
  const page = join(ws, 'site')
  mkdirSync(join(page, 'assets'), { recursive: true })
  mkdirSync(join(ws, 'other'))
  writeFileSync(join(page, 'index.html'), '<p>hi</p>')
  writeFileSync(join(page, 'assets', 'a.css'), 'p{}')
  writeFileSync(join(page, '.env'), 'SECRET=1')
  writeFileSync(join(ws, 'other', 'f.txt'), 'sibling')
  writeFileSync(join(fx, 'outside.html'), '<p>out</p>')
  symlinkSync(join(ws, 'other', 'f.txt'), join(page, 'escape.txt'))
  const cwds = new Map([['h1', ws]])
  const fa = createFileAccess({ cwd: (h) => cwds.get(h) ?? null, changedPaths: async () => [join(fx, 'outside.html')] })
  const caps = createCaps((h, p) => fa.resolveAllowed(h, p, { consumer: 'web', operation: 'read-file' }))
  const policy = { artifact: true, remote: true, data: false }
  const served = new Map<string, string>()
  const host = caps.issue({ handleId: 'h1', root: page, policy, served })
  const get = (path: string, method = 'GET', h = host) => caps.serve(new Request(`clui-file://${h}${path}`, { method }))

  equal(host.length, 32, 'cap: 128 random bits')
  const res = await get('/index.html')
  equal(res.status, 200, 'cap: serves the page')
  equal(await res.text(), '<p>hi</p>', 'cap: the page bytes')
  equal(res.headers.get('content-type'), 'text/html', 'cap: MIME type')
  equal(res.headers.get('x-content-type-options'), 'nosniff', 'cap: nosniff')
  equal(res.headers.get('content-security-policy'), cspFor(policy), "cap: the view's CSP")
  equal((await get('/assets/a.css')).headers.get('content-type'), 'text/css', 'cap: an asset below the page')
  equal((await get('/')).status, 404, 'cap: no directory listing')
  equal((await get('/assets')).status, 404, 'cap: a folder is not a file')
  equal((await get('/%2eenv')).status, 404, 'cap: dotfile')
  equal((await get('/%2e%2e%2fother%2ff.txt')).status, 404, 'cap: sibling folder through encoded traversal')
  equal((await get('/escape.txt')).status, 404, 'cap: a symlink out of the root')
  equal((await get('/index.html', 'POST')).status, 405, 'cap: reads only')
  const masked = pageUrlPath(page, host, 'index.html')
  equal(await (await get(masked)).text(), '<p>hi</p>', 'cap: the page at its masked path')
  equal((await get(masked.replace('index.html', 'assets/a.css'))).status, 200, 'cap: an asset beside the masked page')
  equal((await get(masked.replace(`${host}/index.html`, 'other/f.txt'))).status, 404, "cap: a climb out of the page's folder")
  equal((await get(masked.replace(`${host}/index.html`, 'site/index.html'))).status, 200, "cap: a climb back into the page's folder")
  equal(JSON.stringify([...served.keys()].sort()), JSON.stringify([join(page, 'assets', 'a.css'), join(page, 'index.html')]), 'cap: records what it served, never a refused path')
  const ranged = (range: string) => caps.serve(new Request(`clui-file://${host}/index.html`, { headers: { range } }))
  const part = await ranged('bytes=3-5')
  equal(`${part.status} ${part.headers.get('content-range')} ${await part.text()}`, '206 bytes 3-5/9 hi<', 'cap: a byte range')
  equal(await (await ranged('bytes=-4')).text(), '</p>', 'cap: a suffix range')
  equal(await (await ranged('bytes=6-')).text(), '/p>', 'cap: an open range')
  const past = await ranged('bytes=9-')
  equal(`${past.status} ${past.headers.get('content-range')}`, '416 bytes */9', 'cap: a range past the end')
  equal((await ranged('bytes=0-1,4-5')).status, 200, 'cap: multiple ranges get the whole file')
  equal((await get('/index.html')).headers.get('accept-ranges'), 'bytes', 'cap: says it takes ranges')
  equal(JSON.stringify(rangeOf('bytes=0-99', 10)), '[0,10]', 'range: clamped to the size')
  equal(rangeOf('bytes=5-2', 10), null, 'range: reversed is ignored')
  equal(rangeOf('bytes=-0', 10), 'unsatisfiable', 'range: an empty suffix')
  equal(rangeOf('items=0-1', 10), null, 'range: another unit is ignored')
  const head = await get('/index.html', 'HEAD')
  equal(head.status === 200 && head.body === null, true, 'cap: HEAD has headers only')
  equal((await get('/index.html', 'GET', 'cd'.repeat(16))).status, 403, 'cap: unknown cap')
  ok(!(await fa.resolveAllowed('h1', join(fx, 'outside.html'), { consumer: 'web', operation: 'read-file' })).ok, 'cap: a ledger file outside the workspace has no web grant')
  ok((await fa.resolveAllowed('h1', join(fx, 'outside.html'), { consumer: 'file', operation: 'read-file' })).ok, 'cap: while the File surface may read it')

  const other = caps.issue({ handleId: 'h1', root: join(ws, 'other'), policy, served: new Map() })
  ok(other !== host && (await get('/f.txt', 'GET', other)).status === 200, 'cap: each view its own host')
  // Past TEXT_MAX the read is partial, so the whole file is compared with Claude's write.
  const big = `<p>${'é'.repeat(TEXT_MAX / 2)}</p>`
  writeFileSync(join(page, 'big.html'), big)
  const bigR = await fa.resolveAllowed('h1', join(page, 'big.html'), { consumer: 'file', operation: 'read-file' })
  ok(bigR.ok, 'changed-since: the big page resolves')
  if (bigR.ok) {
    const bigRead = await readText(bigR)
    ok(bigRead.ok && bigRead.truncated, 'changed-since: the big page reads partial')
    equal(await holdsClaudes(bigR, big, bigRead), true, "changed-since: a big page holding Claude's bytes")
    equal(await holdsClaudes(bigR, big.replace('</p>', '</b>'), bigRead), false, 'changed-since: a big page whose tail differs')
    equal(await holdsClaudes(bigR, `${big}\n`, bigRead), false, 'changed-since: a big page of another size')
  }
  caps.revoke(host)
  equal((await get('/index.html')).status, 403, 'cap: revoked, a late request fails')
  equal((await get('/f.txt', 'GET', other)).status, 200, 'cap: revoking one leaves another')
  cwds.delete('h1')
  equal((await get('/f.txt', 'GET', other)).status, 404, 'cap: a gone session reads nothing')
  cwds.set('home', homedir())
  const inHome = join(homedir(), 'clui-no-such-page.html')
  equal((await fa.resolveAllowed('home', inHome, { consumer: 'web', operation: 'read-file' }) as { reason?: string }).reason, 'too-broad', 'cap: a page under a home cwd is refused as too broad, not outside')
  equal((await fa.resolveAllowed('home', inHome, { consumer: 'file', operation: 'read-file' }) as { reason?: string }).reason, 'denied', 'cap: other consumers there stay denied')
  rmSync(fx, { recursive: true, force: true })
}
