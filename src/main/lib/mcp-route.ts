/**
 * Clui's own MCP servers over HTTP JSON-RPC, all on one 127.0.0.1 listener. Each server is a route
 * with its own bearer token per session handle, so a token opens one server for one session only.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/jpeg' }
export interface ToolResult { content: Content[]; isError?: boolean }

export interface McpHandler {
  /** serverInfo.name */
  name: string
  /** tools/list, already filtered for the handle. */
  tools(handleId: string): object[]
  call(handleId: string, name: string, args: Record<string, unknown>, toolUseId?: string): Promise<ToolResult>
}

export interface McpRoute {
  /** Where a session's CLI reaches this server. Mints the token on first use. */
  endpoint(handleId: string): Promise<{ url: string; token: string }>
  entry(handleId: string): Promise<{ type: 'http'; url: string; headers: { Authorization: string } }>
  revoke(handleId: string): void
}

interface Route { handler: McpHandler; tokens: Map<string, string> }

const MAX_BODY = 1 << 20

function authorized(tokens: Map<string, string>, handleId: string, header: string | undefined): boolean {
  const want = tokens.get(handleId)
  if (!want || !header?.startsWith('Bearer ')) return false
  // Compared as bytes: a non-ASCII header of the right string length has a different byte length.
  const got = Buffer.from(header.slice(7))
  return got.length === want.length && timingSafeEqual(got, Buffer.from(want))
}

function reply(res: ServerResponse, id: unknown, result?: unknown, error?: { code: number; message: string }): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }))
}

export function mcpListener(): { route(segment: 'mcp' | 'mcp-surface', handler: McpHandler): McpRoute } {
  const routes = new Map<string, Route>()
  let port: Promise<number> | null = null

  const listen = (): Promise<number> =>
    (port ??= new Promise((resolve, reject) => {
      const server = createServer((req, res) => void onRequest(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end()
      }))
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') resolve(addr.port)
        else reject(new Error('The MCP listener has no port.'))
      })
    }))

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const p = await listen()
    // No browser page may reach this listener: pages always send Origin on cross-origin requests,
    // and a DNS-rebinding page can't make its Host header read 127.0.0.1.
    if (req.headers.origin !== undefined || req.headers.host !== `127.0.0.1:${p}`) return void res.writeHead(403).end()
    const m = /^\/([\w-]+)\/([\w-]+)$/.exec(req.url ?? '')
    const route = m ? routes.get(m[1]) : undefined
    if (!m || !route) return void res.writeHead(404).end()
    const handleId = m[2]
    if (!authorized(route.tokens, handleId, req.headers.authorization)) return void res.writeHead(401).end()
    // The CLI probes for a server-sent event stream with GET; it works without one.
    if (req.method !== 'POST') return void res.writeHead(405).end()

    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length
      if (size > MAX_BODY) return void res.writeHead(413).end()
      chunks.push(chunk)
    }
    let msg: { id?: unknown; method?: unknown; params?: Record<string, unknown> }
    try {
      msg = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return reply(res, null, undefined, { code: -32700, message: 'Parse error' })
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return reply(res, null, undefined, { code: -32600, message: 'Invalid request' })
    if (msg.id === undefined) return void res.writeHead(202).end()

    const params = msg.params ?? {}
    switch (msg.method) {
      case 'initialize':
        return reply(res, msg.id, {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: route.handler.name, version: '1.0.0' }
        })
      case 'ping':
        return reply(res, msg.id, {})
      case 'tools/list':
        return reply(res, msg.id, { tools: route.handler.tools(handleId) })
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : ''
        const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {}
        const meta = params._meta && typeof params._meta === 'object' ? (params._meta as Record<string, unknown>)['claudecode/toolUseId'] : undefined
        return reply(res, msg.id, await route.handler.call(handleId, name, args, typeof meta === 'string' ? meta : undefined))
      }
      default:
        return reply(res, msg.id, undefined, { code: -32601, message: 'Method not found' })
    }
  }

  return {
    route(segment, handler) {
      const tokens = new Map<string, string>()
      routes.set(segment, { handler, tokens })
      const endpoint = async (handleId: string): Promise<{ url: string; token: string }> => {
        const p = await listen()
        let token = tokens.get(handleId)
        if (!token) {
          token = randomBytes(32).toString('hex')
          tokens.set(handleId, token)
        }
        return { url: `http://127.0.0.1:${p}/${segment}/${handleId}`, token }
      }
      return {
        endpoint,
        async entry(handleId) {
          const { url, token } = await endpoint(handleId)
          return { type: 'http', url, headers: { Authorization: `Bearer ${token}` } }
        },
        revoke: (handleId) => void tokens.delete(handleId)
      }
    }
  }
}
