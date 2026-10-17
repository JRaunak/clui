/** The browser pane's drive state. `user` = the person took over and Claude is paused. */
export type DriveState = 'idle' | 'driving' | 'user' | 'stopped' | 'done'

/** The right sidebar's state for this session's browser. */
export type BrowserPaneState = 'collapsed' | 'half' | 'full'

/** One tab's page. Every tab of a session shares the session's partition, site approvals and vault. */
export interface BrowserState {
  url: string
  title: string
  loading: boolean
  canBack: boolean
  canForward: boolean
  drive: DriveState
  /** Suspended by the live-page cap: only a still and the URL remain. */
  suspended: boolean
  /** A data: URL of the last capture, shown whenever the native view is hidden. */
  still: string | null
  /** A sign-in Clui can't complete (security keys, device-bound passkeys). */
  loginWall: 'hardware' | null
  /** The site whose page asked to reach the local network, until the user decides or the tab leaves that site. */
  netAsk: string | null
  /** The main frame's last load failure, until a main-frame navigation commits. */
  loadError: LoadError | null
}

/** `name` is Chromium's error name. `httpUrl` is the http form of an https URL that failed the way a
 *  plain-http server answers a TLS handshake. */
export interface LoadError { url: string; code: number; name: string; httpUrl: string | null }

export type LoginRequest =
  | { kind: 'choose'; site: string; usernames: string[] }
  | { kind: 'save'; site: string }

/** Tab ids count up from 1 per session in open order and are never reused while the process lives. */
export interface TabState extends BrowserState {
  id: number
}

/** Who opened or closed a tab. The renderer announces only Claude's changes. */
export type TabActor = 'agent' | 'user'

export type BrowserEvent =
  | { type: 'tab-state'; tab: number; patch: Partial<BrowserState> }
  /** Appended at the end of the strip. `viewed` is the session's viewed tab after the change.
   *  `url` is where Claude is opening it, which the page hasn't loaded yet. */
  | { type: 'tab-opened'; tab: TabState; by: TabActor; viewed: number; url?: string }
  /** `viewed` is the viewed tab after the close, or the closed one when it was the last. */
  | { type: 'tab-closed'; tab: number; by: TabActor; viewed: number }
  /** The tab a browser tool call ran in, keyed by the CLI's tool_use id. */
  | { type: 'tool-tab'; toolUseId: string; tab: number }
  /** `page`: the page itself tried to go there, not Claude, and the Gate says so.
   *  `from` is that page's site, null when it has none (about:blank). */
  | { type: 'site-request'; requestId: string; site: string; cause: 'agent' | 'page'; from: string | null; tab: number }
  | { type: 'login-request'; requestId: string; request: LoginRequest; tab: number }
  | { type: 'filled'; site: string; tab: number }
  /** The user's own input in a page, at most once a second; input during Claude's own dispatches doesn't count. */
  | { type: 'user-input'; tab: number }

export interface PaneBounds { x: number; y: number; width: number; height: number }

/** A saved login as the renderer may see it: never the password or the one-time-code seed. */
export interface SavedLoginInfo { id: string; site: string; username: string; hasTotp: boolean; createdMs: number }

export interface ApprovedSite { site: string; approvedMs: number }

/** What a page may reach on this Mac and its network. Separate from ApprovedSite, which is what Claude may act on. */
export interface LocalNetSite { site: string; allow: boolean; atMs: number }

/** Chromium's names for local network access across versions; one decision covers all three. */
export const LOCAL_NET_PERMS: ReadonlySet<string> = new Set(['local-network-access', 'loopback-network', 'local-network'])

/**
 * A local-network permission check or request. `decision` is the stored answer for a site: true allow,
 * false block, undefined not asked. Only a top frame asks, and a frame is granted only when it's the same
 * site as an allowed top page, so an embedded third party never rides on the page's grant.
 */
export function localNetVerdict(
  topUrl: string,
  isMainFrame: boolean,
  frameUrl: string,
  decision: (site: string) => boolean | undefined
): { grant: boolean; ask: string | null } {
  const top = siteKeyOf(isMainFrame ? frameUrl : topUrl)
  if (!top) return { grant: false, ask: null }
  const d = decision(top)
  if (isMainFrame) return { grant: d === true, ask: d === undefined ? top : null }
  return { grant: d === true && siteKeyOf(frameUrl) === top, ask: null }
}

/** What Clear browsing data would remove, shared by every session's page. */
export interface BrowsingDataInfo { cookieSites: number; cacheBytes: number; openPages: number }

export interface ClearBrowsingData { cookies: boolean; cache: boolean; history: boolean }

/**
 * The site a URL belongs to, for approvals and saved logins. Stricter than a registrable
 * domain: without the Public Suffix List every subdomain other than www counts separately,
 * so a site is asked about more often, never less. Non-http(s) URLs have no site.
 */
export function siteKeyOf(raw: string): string | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  const literal = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')
  if (literal || !host.includes('.')) return u.port ? `${host}:${u.port}` : host
  return host.startsWith('www.') ? host.slice(4) : host
}

/** A site typed by the user (host, host:port or URL) as its site key, or null when it isn't one. The URL
 *  parser percent-encodes a space rather than refusing it, so a host must be one word with a dot, unless it's
 *  localhost or an IP. */
export function siteFromInput(raw: string): string | null {
  const text = raw.trim().replace(/^https?:\/\//, '')
  const host = text.split(/[/:?#]/, 1)[0]
  if (!host || /\s/.test(text) || !(host.includes('.') || host === 'localhost' || host.startsWith('['))) return null
  return siteKeyOf(`https://${text}`)
}

export type AddressParse =
  | { url: string }
  | { file: string; dir: boolean; line?: number; endLine?: number }
  | { error: 'not-address' }
  | { error: 'unsupported'; kind: 'file'; reason: 'path' | 'malformed' }
  | { error: 'unsupported'; kind: 'scheme'; scheme: string }

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** Loopback, private IPv4 and mDNS hosts, which serve plain http as a rule. `host` is a lowercase hostname. */
export function isLocalHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '[::1]') return true
  const ip = IPV4.exec(host)?.slice(1).map(Number)
  if (!ip) return false
  const [a, b] = ip
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

/** What the address bar does with typed text. There's no search fallback: text that isn't an address is refused
 *  rather than sent to a search engine from the shared partition. A scheme is never required. */
export function parseAddress(raw: string): AddressParse {
  const v = raw.trim()
  if (/^(\/|~\/)/.test(v)) return { error: 'unsupported', kind: 'file', reason: 'path' }
  if (/^file:/i.test(v)) return fileOf(v)
  const head = v.split(/[/?#]/, 1)[0]
  if (!head || /\s/.test(head)) return { error: 'not-address' }
  // A digit after the colon is a port, so localhost:3000 isn't a scheme, and neither is a dotted host or localhost.
  const scheme = /^([a-z][a-z\d+.-]*):(\/\/|[^\d]|$)/i.exec(v)?.[1].toLowerCase()
  if (scheme && !scheme.includes('.') && scheme !== 'localhost') {
    if (scheme !== 'http' && scheme !== 'https') return { error: 'unsupported', kind: 'scheme', scheme }
    return toUrl(v) ?? { error: 'not-address' }
  }
  const m = /^(\[[\da-f:.]+\]|[^:]+)(?::(\d{0,5}))?$/i.exec(head)
  if (!m) return { error: 'not-address' }
  const host = m[1].toLowerCase()
  const single = !host.includes('.') && !host.startsWith('[')
  const ip = IPV4.exec(host)
  const ok =
    isLocalHost(host) ||
    host.startsWith('[') ||
    (ip ? ip.slice(1).every((n) => Number(n) <= 255) : /^([^.]+\.)+(\p{L}{2,}|xn--[a-z\d-]+)$/iu.test(host)) ||
    (single && /^(?!\d+$)[a-z\d-]+$/.test(host) && (!!m[2] || v.length > head.length))
  if (!ok) return { error: 'not-address' }
  return toUrl(`${single || isLocalHost(host) ? 'http' : 'https'}://${v}`) ?? { error: 'not-address' }
}

/** A local file URL's path, with a GitHub-style `#L12` or `#L12-L20` line. A host other than this machine is refused. */
function fileOf(text: string): AddressParse {
  const bad = { error: 'unsupported', kind: 'file', reason: 'malformed' } as const
  let path: string
  let hash: string
  try {
    const u = new URL(text)
    if (u.hostname && u.hostname !== 'localhost') return bad
    path = decodeURIComponent(u.pathname)
    hash = u.hash
  } catch {
    return bad
  }
  const m = /^#L(\d+)(?:-L?(\d+))?$/i.exec(hash)
  const line = m ? Number(m[1]) : 0
  const end = m?.[2] ? Number(m[2]) : 0
  const file = path.length > 1 ? path.replace(/\/+$/, '') : path
  return { file, dir: path.endsWith('/'), ...(line ? { line } : {}), ...(end > line ? { endLine: end } : {}) }
}

function toUrl(text: string): { url: string } | null {
  try {
    const u = new URL(text)
    return u.hostname ? { url: u.href } : null
  } catch {
    return null
  }
}

/** The failure panel's heading and body for a load error. `host` is null when the heading names none. */
export function loadFailureOf(e: LoadError): { pre: string; host: string | null; post: string; body: string } {
  let host = e.url
  let local = false
  try {
    const u = new URL(e.url)
    host = u.host
    local = isLocalHost(u.hostname)
  } catch {}
  const say = (pre: string, post: string, body: string) => ({ pre, host, post, body })
  if (e.httpUrl) return say("Can't make a secure connection to ", '', 'It may only serve http. Try http only if you trust this network.')
  if (e.code <= -200 && e.code >= -299)
    return say('', "'s certificate isn't valid", "Clui won't open it, since the connection can't be trusted.")
  switch (e.code) {
    case -105:
      return say("Can't find ", '', 'Check the spelling, or your connection.')
    case -102:
      return say(
        "Can't reach ",
        '',
        local
          ? 'Nothing answered at this address. If a dev server should be running here, start it and retry.'
          : 'The site refused the connection.'
      )
    case -106:
      return { pre: "You're offline", host: null, post: '', body: 'Reconnect, then retry.' }
    case -7:
    case -118:
      return say('', ' took too long to respond', 'Retry, or check your connection.')
  }
  return say("Can't open ", '', "The page didn't load.")
}
