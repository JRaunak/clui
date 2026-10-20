// Boundary: one localhost listener carries every Clui MCP server, so the gates hold per route:
// a token opens only its own route and handle, and the JSON-RPC shapes the CLI relies on hold on each.
import { request } from 'node:http'
import { mcpListener, type McpHandler } from '../src/main/lib/mcp-route.ts'
import { equal, ok } from './support/harness.mjs'

const stub = (name: string): McpHandler => ({
  name,
  tools: (h) => [{ name: `${name}:${h}` }],
  call: async (h, tool, args, toolUseId) => ({ content: [{ type: 'text', text: JSON.stringify({ h, tool, args, toolUseId }) }] })
})
const listener = mcpListener()
const browser = listener.route('mcp', stub('clui-browser'))
const surface = listener.route('mcp-surface', stub('clui-surface'))
const b1 = await browser.endpoint('h1')
const s1 = await surface.endpoint('h1')
const s2 = await surface.endpoint('h2')
const { port } = new URL(b1.url)
const path = (u: string): string => new URL(u).pathname

equal(new URL(s1.url).port, port, 'route: both routes share one listener')
equal(path(s1.url), '/mcp-surface/h1', 'route: the surface path')
ok(b1.token !== s1.token && s1.token !== s2.token && /^[0-9a-f]{64}$/.test(s1.token), 'route: a fresh 32-byte token per route and handle')
equal((await surface.endpoint('h1')).token, s1.token, 'route: endpoint reuses the minted token')
equal(JSON.stringify(await surface.entry('h1')), JSON.stringify({ type: 'http', url: s1.url, headers: { Authorization: `Bearer ${s1.token}` } }), 'route: entry is the --mcp-config server entry')

function call(opts: { path: string; token?: string; method?: string; headers?: Record<string, string>; body?: unknown; raw?: string }): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: opts.path,
        method: opts.method ?? 'POST',
        headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers }
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null }))
      }
    )
    // The 413 answers before the body is read, so the upload can be cut off after the reply.
    req.on('error', (e: NodeJS.ErrnoException) => (e.code === 'EPIPE' || e.code === 'ECONNRESET' ? undefined : reject(e)))
    req.end(opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)))
  })
}
const rpc = (method: string, params?: unknown, id: number | null = 1) => ({ jsonrpc: '2.0', method, ...(id === null ? {} : { id }), ...(params ? { params } : {}) })
const S = { path: path(s1.url), token: s1.token }
const list = rpc('tools/list')

equal((await call({ ...S, headers: { origin: 'https://example.com' }, body: list })).status, 403, 'route: any Origin is 403')
equal((await call({ ...S, headers: { host: `localhost:${port}` }, body: list })).status, 403, 'route: a Host other than 127.0.0.1:<port> is 403')
equal((await call({ ...S, path: '/mcp-other/h1', body: list })).status, 404, 'route: an unregistered segment is 404')
equal((await call({ ...S, path: '/mcp-surface/h1/x', body: list })).status, 404, 'route: an unmatched path is 404')
equal((await call({ path: S.path, body: list })).status, 401, 'route: no token is 401')
equal((await call({ path: S.path, token: 'f'.repeat(64), body: list })).status, 401, 'route: a wrong token is 401')
equal((await call({ path: S.path, token: b1.token, body: list })).status, 401, 'route: a browser token on the surface route is 401')
equal((await call({ path: path(b1.url), token: s1.token, body: list })).status, 401, 'route: a surface token on the browser route is 401')
equal((await call({ path: path(s2.url), token: s1.token, body: list })).status, 401, "route: handle h1's token on h2's path is 401")
equal((await call({ ...S, method: 'GET', headers: { accept: 'text/event-stream' } })).status, 405, 'route: GET is 405')
equal((await call({ ...S, raw: ' '.repeat((1 << 20) + 1) })).status, 413, 'route: a body over 1 MiB is 413')
equal((await call({ ...S, raw: ' '.repeat(1 << 20) })).json?.error?.code, -32700, 'route: a 1 MiB body is read')
equal((await call({ ...S, raw: '{nope' })).json?.error?.code, -32700, 'route: bad JSON is -32700')
equal((await call({ ...S, body: [list] })).json?.error?.code, -32600, 'route: an array body is -32600')
equal((await call({ ...S, body: rpc('notifications/initialized', undefined, null) })).status, 202, 'route: a notification is 202')
equal((await call({ ...S, body: rpc('server/discover') })).json?.error?.code, -32601, 'route: server/discover is -32601')

const init = (p: { path: string; token: string }, params?: unknown) => call({ ...p, body: rpc('initialize', params) }).then((r) => r.json?.result)
equal((await init(S))?.serverInfo?.name, 'clui-surface', "route: initialize names the route's server")
equal((await init({ path: path(b1.url), token: b1.token }))?.serverInfo?.name, 'clui-browser', 'route: and the browser route its own')
equal((await init(S, { protocolVersion: '2099-01-01' }))?.protocolVersion, '2099-01-01', 'route: initialize echoes the protocol version')
equal((await init(S))?.protocolVersion, '2025-06-18', 'route: or defaults it')
equal(JSON.stringify((await call({ ...S, body: rpc('ping') })).json?.result), '{}', 'route: ping')
equal((await call({ ...S, body: list })).json?.result?.tools?.[0]?.name, 'clui-surface:h1', 'route: tools/list asks the handler for that handle')
const called = await call({ ...S, body: rpc('tools/call', { name: 'change_read', arguments: { ref: 'c_1' }, _meta: { 'claudecode/toolUseId': 'toolu_1' } }) })
equal(called.json?.result?.content?.[0]?.text, JSON.stringify({ h: 'h1', tool: 'change_read', args: { ref: 'c_1' }, toolUseId: 'toolu_1' }), 'route: tools/call passes the handle, name, args and tool_use id')

surface.revoke('h1')
equal((await call({ ...S, body: list })).status, 401, 'route: a revoked token is 401')
equal((await call({ path: path(s2.url), token: s2.token, body: list })).status, 200, "route: revoke leaves another handle's token")
equal((await call({ path: path(b1.url), token: b1.token, body: list })).status, 200, "route: and another route's token for the same handle")
