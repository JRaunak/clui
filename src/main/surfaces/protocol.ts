/**
 * `clui-file:`, as two separate sets of caps on separate sessions. An HTML view's page loads from its own random
 * host, a capability whose root is the page's directory, so every page is its own origin and reaches only the files
 * beside and below it; those are handled on the artifact partitions. A Markdown preview's images each get a host
 * naming exactly one file, handled on the app's own session. Neither session can reach the other's caps, and the
 * browser partition sees neither.
 */
import { protocol } from 'electron'
import { randomBytes } from 'node:crypto'
import { basename, extname, join, relative, sep } from 'node:path'
import type { HtmlPolicy } from '../../shared/html-view'
import { IMAGE_PATHS_MAX, type FileStat, type ImageCap } from '../../shared/files'
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
    return new Response(bytesOf(r, s, () => caps.get(host) === cap), { headers })
  }

  return { issue, revoke, serve }
}

function bytesOf(r: FileResource, s: FileStat, live: () => boolean): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      if (offset >= s.size) return c.close()
      const chunk = await readBytes(r, { revision: s.revision, offset, length: Math.min(CHUNK, s.size - offset) })
      // Revoked mid-stream, or the file changed under the read: never finish it with another version's bytes.
      if (!live()) return c.error(new Error('revoked'))
      if (!chunk.ok) return c.error(new Error(chunk.reason))
      if (!chunk.bytes.length) return c.close()
      offset += chunk.bytes.length
      c.enqueue(chunk.bytes)
    }
  })
}

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico'])
export const isImagePath = (p: string): boolean => IMAGE.has(extname(p).toLowerCase())

/** A cap's URL path: the file's own name, the one path its host serves. */
export function imageCapPath(pathname: string, path: string): boolean {
  const segs = capPath(pathname)
  return segs?.length === 1 && segs[0] === basename(path)
}

interface ImageGrant {
  handleId: string
  /** `${handleId}\0${owner}`: the preview that minted it. */
  owner: string
  /** Canonical, as authorized. */
  path: string
}

/**
 * Exact-file image caps for the renderer. `resolve` authorizes a path as the File surface reads it, so a cap reaches
 * nothing a Source view of the same file couldn't, and every request resolves it again.
 */
export function createImageCaps(resolve: (handleId: string, path: string) => Promise<FileResource | Refusal>) {
  const caps = new Map<string, ImageGrant>()
  // The newest mint per owner; a mint that finishes after a newer one or a revoke issues nothing.
  const latest = new Map<string, number>()
  let seq = 0

  function drop(test: (g: ImageGrant) => boolean): void {
    for (const [host, g] of caps) if (test(g)) caps.delete(host)
  }

  function revoke(handleId: unknown, owner: unknown): void {
    const key = `${handleId}\0${owner}`
    latest.delete(key)
    drop((g) => g.owner === key)
  }

  async function mint(handleId: unknown, owner: unknown, paths: unknown): Promise<ImageCap[]> {
    if (typeof handleId !== 'string' || typeof owner !== 'string' || !owner || owner.length > 200 || !Array.isArray(paths) || paths.length > IMAGE_PATHS_MAX) return []
    const key = `${handleId}\0${owner}`
    const gen = ++seq
    latest.set(key, gen)
    const found = await Promise.all(
      paths.map(async (p): Promise<string | ImageCap> => {
        const r = typeof p === 'string' ? await resolve(handleId, p) : ({ ok: false, reason: 'invalid' } as const)
        if (!r.ok) return { ok: false, outside: r.reason === 'denied' }
        // The canonical name, so a symlinked `x.png` naming another kind of file isn't served as an image.
        return isImagePath(r.path) ? r.path : { ok: false, outside: false }
      })
    )
    if (latest.get(key) !== gen) return paths.map(() => ({ ok: false, outside: false }))
    drop((g) => g.owner === key)
    return found.map((f) => {
      if (typeof f !== 'string') return f
      const host = randomBytes(16).toString('hex')
      caps.set(host, { handleId, owner: key, path: f })
      return { ok: true, url: `${SCHEME}://${host}/${encodeURIComponent(basename(f))}` }
    })
  }

  async function serve(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const host = url.hostname
    const g = caps.get(host)
    if (!g) return status(403)
    if (req.method !== 'GET' && req.method !== 'HEAD') return status(405)
    if (!imageCapPath(url.pathname, g.path)) return status(404)
    const r = await resolve(g.handleId, g.path)
    if (caps.get(host) !== g) return status(403)
    if (!r.ok || r.path !== g.path) return status(404)
    const s = await statFile(r)
    if (caps.get(host) !== g) return status(403)
    if (!s.ok) return status(404)
    const headers = { 'content-type': MIME[extname(r.path).toLowerCase()]!, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' }
    if (req.method === 'HEAD') return new Response(null, { headers })
    return new Response(bytesOf(r, s, () => caps.get(host) === g), { headers })
  }

  return {
    mint,
    revoke,
    serve,
    /** A session's caps, when it's disposed. */
    dispose: (handleId: string) => {
      for (const k of latest.keys()) if (k.startsWith(`${handleId}\0`)) latest.delete(k)
      drop((g) => g.handleId === handleId)
    },
    /** Every cap, when the renderer that holds them goes away. */
    clear: () => {
      latest.clear()
      caps.clear()
    }
  }
}
