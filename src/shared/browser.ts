/** The browser pane's drive state. `user` = the person took over and Claude is paused. */
export type DriveState = 'idle' | 'driving' | 'user' | 'stopped' | 'done'

/** The right sidebar's state for this session's browser. */
export type BrowserPaneState = 'collapsed' | 'half' | 'full'

export interface BrowserState {
  /** Tools are attached to the CLI session. */
  enabled: boolean
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
}

export type LoginRequest =
  | { kind: 'choose'; site: string; usernames: string[] }
  | { kind: 'save'; site: string }

export type BrowserEvent =
  | { type: 'state'; patch: Partial<BrowserState> }
  /** `page`: the page itself tried to go there, not Claude, and the Gate says so.
   *  `from` is that page's site, null when it has none (about:blank). */
  | { type: 'site-request'; requestId: string; site: string; cause: 'agent' | 'page'; from: string | null }
  | { type: 'login-request'; requestId: string; request: LoginRequest }
  | { type: 'filled'; site: string }

export interface PaneBounds { x: number; y: number; width: number; height: number }

/** A saved login as the renderer may see it: never the password or the one-time-code seed. */
export interface SavedLoginInfo { id: string; site: string; username: string; hasTotp: boolean; createdMs: number }

export interface ApprovedSite { site: string; approvedMs: number }

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
