/**
 * `clui-file:` for HTML views. Each view's page loads from its own random host, a capability whose root is
 * the page's directory, so every page is its own origin and reaches only the files beside and below it.
 * Handled on the artifact partition alone: the browser partition and the app's own session never see it.
 */
import { protocol } from 'electron'
import { randomBytes } from 'node:crypto'
import { extname, join, relative, sep } from 'node:path'
import type { HtmlPolicy } from '../../shared/html-view'
import { readBytes, statFile, within, type FileResource, type Refusal } from './files'

export const SCHEME = 'clui-file'
const CHUNK = 1024 * 1024

/** Before app ready. Same-origin fetch() needs supportFetchAPI; connect-src still decides per page whether it may. */
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])
}

const LOCAL = 'http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*'

/** Only an artifact gets the settings' origins; any other page gets the offline base. Never unsafe-eval. */
export function cspFor({ artifact, remote, data }: HtmlPolicy): string {
  const web = artifact && remote ? ' https:' : ''
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${web}`,
    `style-src 'self' 'unsafe-inline'${web}`,
    `font-src 'self' data:${web}`,
    "img-src 'self' data: blob:",
    `connect-src ${artifact && data ? `'self' https: wss: ${LOCAL}` : "'none'"}`,
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'"
  ].join('; ')
}

/**
 * The cap-relative segments of a request path, or null. Chromium collapses a literal `..` before the handler
 * runs but passes `%2e%2e%2f` and `%2eenv` through encoded, so the deny comes after decoding. The root itself
 * is null too: there are no directory listings.
 */
export function capPath(pathname: string): string[] | null {
  let rel: string
  try {
    rel = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const segs = rel.split('/').filter(Boolean)
  return segs.length && !segs.some((s) => s.startsWith('.')) ? segs : null
}

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav'
}

export interface Cap {
  handleId: string
  /** Canonical. */
  root: string
  policy: HtmlPolicy
  /** Each canonical path served, at its identity then; the view's changes count only these. */
  served: Map<string, string>
}

const status = (n: number): Response => new Response(null, { status: n })

/** `resolve` authorizes one path for the web consumer's reads; every request goes through it. */
export function createCaps(resolve: (handleId: string, path: string) => Promise<FileResource | Refusal>) {
  const caps = new Map<string, Cap>()

  function issue(cap: Cap): string {
    const host = randomBytes(16).toString('hex')
    caps.set(host, cap)
    return host
  }

  function revoke(host: string): void {
    caps.delete(host)
  }

  async function serve(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const host = url.hostname
    const cap = caps.get(host)
    if (!cap) return status(403)
    if (req.method !== 'GET' && req.method !== 'HEAD') return status(405)
    const segs = capPath(url.pathname)
    if (!segs) return status(404)
    const r = await resolve(cap.handleId, join(cap.root, ...segs))
    // The canonical path, so a symlink beside the page can't reach the rest of the workspace, or a dotfile.
    if (!r.ok || !within(cap.root, r.path) || relative(cap.root, r.path).split(sep).some((x) => x.startsWith('.'))) return status(caps.get(host) === cap ? 404 : 403)
    const s = await statFile(r)
    if (caps.get(host) !== cap) return status(403)
    if (!s.ok) return status(404)
    cap.served.set(r.path, s.revision)
    const headers = {
      'content-type': MIME[extname(r.path).toLowerCase()] ?? 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'content-security-policy': cspFor(cap.policy),
      'cache-control': 'no-store'
    }
    if (req.method === 'HEAD') return new Response(null, { headers })
    let offset = 0
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        if (offset >= s.size) return c.close()
        const chunk = await readBytes(r, { revision: s.revision, offset, length: Math.min(CHUNK, s.size - offset) })
        // Revoked mid-stream, or the file changed under the read: never finish it with another version's bytes.
        if (caps.get(host) !== cap) return c.error(new Error('revoked'))
        if (!chunk.ok) return c.error(new Error(chunk.reason))
        if (!chunk.bytes.length) return c.close()
        offset += chunk.bytes.length
        c.enqueue(chunk.bytes)
      }
    })
    return new Response(body, { headers })
  }

  return { issue, revoke, serve }
}
