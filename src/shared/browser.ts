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
}

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
  /** `viewed` is the viewed tab after the close; closing the last tab opens a fresh one first. */
  | { type: 'tab-closed'; tab: number; by: TabActor; viewed: number }
  /** The tab a browser tool call ran in, keyed by the CLI's tool_use id. */
  | { type: 'tool-tab'; toolUseId: string; tab: number }
  /** `page`: the page itself tried to go there, not Claude, and the Gate says so.
   *  `from` is that page's site, null when it has none (about:blank). */
  | { type: 'site-request'; requestId: string; site: string; cause: 'agent' | 'page'; from: string | null; tab: number }
  | { type: 'login-request'; requestId: string; request: LoginRequest; tab: number }
  | { type: 'filled'; site: string; tab: number }

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
