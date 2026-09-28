/**
 * One browser page per session, each a WebContentsView sharing the 'persist:clui-browser'
 * partition so a single sign-in covers every session. Only the active session's view is
 * ever a child of the window. Every new address loads through navigate(); ensureView only loads
 * about:blank or the URL a suspended page already had.
 */
import { session, WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import {
  siteKeyOf,
  type BrowserEvent,
  type BrowserState,
  type BrowsingDataInfo,
  type ClearBrowsingData,
  type DriveState,
  type PaneBounds
} from '../../shared/browser'
import type { DomainEvent } from '../../shared/events'
import { Cdp } from './cdp'
import { hideCursor, injectCursor, restCursor } from './cursor'
import { approve, isApproved, isApprovedCached, listSites } from './sites'
import { IpcChannels, type CluiApi } from '../../shared/ipc'
import { saveLogin } from './vault'

type LoginVerdict = Parameters<CluiApi['browserLoginVerdict']>[2]

const PARTITION = 'persist:clui-browser'
const MAX_LIVE = 3
/** The CLI abandons an MCP tool call after about 60s, so a Gate wait must answer before that. */
const GATE_WAIT_MS = 50_000
const LOAD_WAIT_MS = 20_000
const QUIET_MS = 150
const BOUNDS_WAIT_MS = 300

export const TEXT = {
  refused: 'Only http(s) pages can be opened.',
  stopped: "The user stopped browser control. Don't retry unless they ask.",
  userDriving: 'The user is still driving the browser. Wait for them to hand it back.',
  off: 'The browser is off for this session.',
  declined: (site: string) => `The user declined opening ${site}.`,
  siteWaiting: 'Waiting for the user to answer the approval in Clui. Call the tool again after they answer.'
} as const

/** A login Gate's answer, stripped of anything secret: a save has already been written to the vault. */
export type LoginOutcome = { action: 'fill'; loginId: string } | { action: 'decline' } | { action: 'self' } | { action: 'failed' }

const WAITING = Symbol('waiting')

interface Ask<T> {
  handleId: string
  requestId: string
  key: string
  site: string
  promise: Promise<T>
  resolve: (v: T) => void
}

interface Entry {
  view: WebContentsView | null
  cdp: Cdp | null
  state: BrowserState
  lastViewedMs: number
  bounds: PaneBounds | null
  shown: boolean
  /** Currently a child of the window (re-adding a child reorders it, so it's tracked). */
  attached: boolean
  deniedSites: Set<string>
  /** Sites the user opened from the address bar this session, which Claude may act on unasked. */
  userSites: Set<string>
  agentActingUntil: number
  stillTimer: ReturnType<typeof setTimeout> | null
  /** Resolves the wait for the renderer's next bounds report. */
  onBounds: (() => void) | null
}

const USER_INPUT = new Set(['mouseDown', 'keyDown', 'rawKeyDown', 'mouseWheel'])

function initialState(): BrowserState {
  return {
    url: 'about:blank',
    title: '',
    loading: false,
    canBack: false,
    canForward: false,
    drive: 'idle',
    suspended: false,
    still: null,
    loginWall: null
  }
}

function within<T>(p: Promise<T>, ms: number): Promise<T | typeof WAITING> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(WAITING), ms)
    void p.then((v) => {
      clearTimeout(t)
      resolve(v)
    })
  })
}

export class BrowserManager {
  private readonly entries = new Map<string, Entry>()
  private readonly asks = new Map<string, Ask<unknown>>()
  private seq = 0

  private readonly window: () => BrowserWindow | null
  private readonly background: () => string

  constructor(window: () => BrowserWindow | null, background: () => string) {
    this.window = window
    this.background = background
    const ses = session.fromPartition(PARTITION)
    ses.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'clipboard-sanitized-write' || perm === 'fullscreen'))
    ses.setPermissionCheckHandler((_wc, perm) => perm === 'clipboard-sanitized-write' || perm === 'fullscreen')
    ses.on('will-download', (_e, item) => item.cancel())
    // Warm the approvals cache so the synchronous in-page navigation guard can read it.
    void listSites()
  }

  private emit(handleId: string, e: BrowserEvent): void {
    try {
      const win = this.window()
      if (!win || win.isDestroyed()) return
      const wc = win.webContents
      if (!wc.isDestroyed()) wc.send(IpcChannels.browserEvent, handleId, e)
    } catch {
      /* window torn down mid-send */
    }
  }

  private patch(handleId: string, e: Entry, patch: Partial<BrowserState>): void {
    Object.assign(e.state, patch)
    this.emit(handleId, { type: 'state', patch })
  }

  /** A session that starts with the tools. Its page is created the first time it's shown or driven. */
  enable(handleId: string): void {
    if (this.entries.has(handleId)) return
    this.entries.set(handleId, {
      view: null,
      cdp: null,
      state: initialState(),
      lastViewedMs: Date.now(),
      bounds: null,
      shown: false,
      attached: false,
      deniedSites: new Set(),
      userSites: new Set(),
      agentActingUntil: 0,
      stillTimer: null,
      onBounds: null
    })
  }

  /** Create the view for a new or suspended entry, suspending the stalest page past the cap. */
  private ensureView(handleId: string, e: Entry): WebContentsView {
    if (e.view) return e.view
    this.enforceCap(handleId)
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false
      }
    })
    view.setBorderRadius(12)
    view.setBackgroundColor(this.background())
    e.view = view
    const wc = view.webContents
    e.cdp = new Cdp(
      wc,
      () => {
        e.agentActingUntil = Date.now() + QUIET_MS
      },
      () => {
        if (e.view?.webContents === wc) this.patch(handleId, e, { loginWall: 'hardware' })
      }
    )
    this.wire(handleId, e, wc)
    const resume = e.state.suspended && siteKeyOf(e.state.url) ? e.state.url : 'about:blank'
    void wc.loadURL(resume).catch(() => {})
    if (e.state.suspended) this.patch(handleId, e, { suspended: false })
    this.sync(e)
    return view
  }

  private enforceCap(except: string): void {
    const live = [...this.entries].filter(([, x]) => x.view)
    if (live.length < MAX_LIVE) return
    const victim = live
      .filter(([h, x]) => h !== except && !x.shown && x.state.drive !== 'driving' && x.state.drive !== 'user')
      .sort(([, a], [, b]) => a.lastViewedMs - b.lastViewedMs)[0]
    // With every other page shown or driven, the cap is exceeded rather than closing one of them.
    if (victim) void this.suspend(victim[0], victim[1])
  }

  private async suspend(handleId: string, e: Entry): Promise<void> {
    const view = e.view
    if (!view) return
    const still = await this.capture(e)
    // The capture yields, and the page may have been shown or taken over meanwhile.
    if (e.view !== view || e.shown || e.state.drive === 'driving' || e.state.drive === 'user') return
    this.detach(e)
    e.view = null
    e.cdp = null
    if (!view.webContents.isDestroyed()) view.webContents.close()
    this.patch(handleId, e, { suspended: true, loading: false, ...(still ? { still } : {}) })
  }

  private wire(handleId: string, e: Entry, wc: WebContents): void {
    const mine = (): boolean => e.view?.webContents === wc
    wc.setWindowOpenHandler(({ url }) => {
      void this.navigate(handleId, url, 'page')
      return { action: 'deny' }
    })
    const guard = (ev: Electron.Event, url: string, isMainFrame: boolean): void => {
      if (!isMainFrame) return
      const site = siteKeyOf(url)
      if (!site) return ev.preventDefault()
      if (e.state.drive !== 'driving' || isApprovedCached(site) || e.userSites.has(site)) return
      ev.preventDefault()
      if (e.deniedSites.has(site)) return
      void this.siteGate(handleId, e, site, null, 'page').then((refusal) => {
        if (!refusal && mine()) void this.navigate(handleId, url, 'user')
      })
    }
    wc.on('will-navigate', (ev) => guard(ev, ev.url, ev.isMainFrame))
    wc.on('will-redirect', (ev) => guard(ev, ev.url, ev.isMainFrame))
    wc.on('did-start-loading', () => mine() && this.patch(handleId, e, { loading: true }))
    wc.on('did-stop-loading', () => {
      if (!mine()) return
      this.patch(handleId, e, { loading: false })
      void this.refreshStill(handleId, e)
    })
    const navigated = (url: string): void => {
      if (!mine()) return
      const h = wc.navigationHistory
      this.patch(handleId, e, { url, canBack: h.canGoBack(), canForward: h.canGoForward() })
    }
    wc.on('did-navigate', (_ev, url) => {
      navigated(url)
      if (mine() && e.state.loginWall) this.patch(handleId, e, { loginWall: null })
      void injectCursor(wc)
    })
    wc.on('did-navigate-in-page', (_ev, url, isMainFrame) => isMainFrame && navigated(url))
    wc.on('dom-ready', () => void injectCursor(wc))
    wc.on('page-title-updated', (_ev, title) => mine() && this.patch(handleId, e, { title }))
    wc.on('render-process-gone', () => mine() && this.setDrive(handleId, e, 'stopped'))
    // CDP mouse input also raises input-event, so only input outside the quiet window
    // around our own dispatches counts as the user. before-input-event never fires for CDP.
    wc.on('input-event', (_ev, input) => {
      if (USER_INPUT.has(input.type) && Date.now() > e.agentActingUntil) this.userActed(handleId, e)
    })
    wc.on('before-input-event', (_ev, input) => {
      if (input.type === 'keyDown' && !input.meta && !input.control) this.userActed(handleId, e)
    })
  }

  private userActed(handleId: string, e: Entry): void {
    if (e.state.drive === 'driving') this.setDrive(handleId, e, 'user')
    if (e.state.drive === 'user') this.scheduleStill(handleId, e, 500)
  }

  private setDrive(handleId: string, e: Entry, drive: DriveState): void {
    if (e.state.drive === drive) return
    this.patch(handleId, e, { drive })
    const wc = e.view?.webContents
    if (drive !== 'driving' && wc) void hideCursor(wc)
  }

  // --- showing, bounds, stills ---

  /** Attach the view only while the renderer wants it shown and has told us where. */
  private sync(e: Entry): void {
    const win = this.window()
    if (!e.view || !win || win.isDestroyed()) return
    if (e.shown && e.bounds) {
      const z = win.webContents.getZoomFactor()
      const b = e.bounds
      e.view.setBounds(
        z === 1 ? b : { x: Math.round(b.x * z), y: Math.round(b.y * z), width: Math.round(b.width * z), height: Math.round(b.height * z) }
      )
      if (!e.attached) win.contentView.addChildView(e.view)
      e.attached = true
    } else {
      this.detach(e)
    }
  }

  private detach(e: Entry): void {
    const win = this.window()
    if (e.view && e.attached && win && !win.isDestroyed()) win.contentView.removeChildView(e.view)
    e.attached = false
  }

  /** A blank or transparent page shows the view's own background, so it follows the theme. */
  repaint(): void {
    const bg = this.background()
    for (const e of this.entries.values()) if (e.view && !e.view.webContents.isDestroyed()) e.view.setBackgroundColor(bg)
  }

  setBounds(handleId: string, b: PaneBounds | null): void {
    const e = this.entries.get(handleId)
    if (!e) return
    e.bounds = b
    this.sync(e)
    e.onBounds?.()
    if (b) this.scheduleStill(handleId, e, 300)
  }

  async setVisible(handleId: string, visible: boolean): Promise<string | null> {
    const e = this.entries.get(handleId)
    if (!e) return null
    if (visible) {
      for (const [h, other] of this.entries) if (h !== handleId && other.shown) await this.setVisible(h, false)
      // A suspended page waits for Reload rather than coming back on its own.
      if (!e.state.suspended) this.ensureView(handleId, e)
      e.shown = true
      e.lastViewedMs = Date.now()
      this.sync(e)
      return null
    }
    const still = e.shown ? await this.refreshStill(handleId, e) : e.state.still
    e.shown = false
    this.sync(e)
    return still
  }

  private async capture(e: Entry): Promise<string | null> {
    const wc = e.view?.webContents
    if (!wc || wc.isDestroyed()) return null
    try {
      const img = await wc.capturePage()
      return img.isEmpty() ? null : img.toDataURL()
    } catch {
      return null
    }
  }

  private async refreshStill(handleId: string, e: Entry): Promise<string | null> {
    if (e.stillTimer) clearTimeout(e.stillTimer)
    e.stillTimer = null
    const still = await this.capture(e)
    if (still && this.entries.get(handleId) === e) this.patch(handleId, e, { still })
    return still ?? e.state.still
  }

  private scheduleStill(handleId: string, e: Entry, ms: number): void {
    if (e.stillTimer) clearTimeout(e.stillTimer)
    e.stillTimer = setTimeout(() => void this.refreshStill(handleId, e), ms)
  }

  // --- navigation ---

  async navigate(handleId: string, url: string, cause: 'agent' | 'user' | 'page'): Promise<string | null> {
    const site = siteKeyOf(url)
    if (!site) return TEXT.refused
    const e = this.entries.get(handleId)
    if (!e) return TEXT.off
    if (cause === 'user') e.userSites.add(site)
    else if (cause === 'agent' || e.state.drive === 'driving') {
      const refusal = await this.siteGate(handleId, e, site, cause === 'agent' ? GATE_WAIT_MS : null, cause)
      if (refusal) return refusal
    }
    const wc = this.ensureView(handleId, e).webContents
    const load = wc.loadURL(url)
    if (cause !== 'agent') {
      void load.catch(() => {})
      return null
    }
    try {
      await Promise.race([load, new Promise((r) => setTimeout(r, LOAD_WAIT_MS))])
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code && code !== 'ERR_ABORTED') return `Couldn't open ${url} (${code}).`
    }
    return null
  }

  async nav(handleId: string, action: 'back' | 'forward' | 'reload' | 'stop'): Promise<void> {
    const e = this.entries.get(handleId)
    if (!e) return
    if (!e.view) {
      if (action === 'reload') this.ensureView(handleId, e)
      return
    }
    const wc = e.view.webContents
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    else if (action === 'reload') wc.reload()
    else if (action === 'stop') wc.stop()
  }

  // --- Gates ---

  private ask<T>(handleId: string, key: string, site: string, event: (requestId: string) => BrowserEvent): Ask<T> {
    const existing = this.asks.get(key)
    if (existing) return existing as Ask<T>
    let resolve!: (v: T) => void
    const promise = new Promise<T>((r) => (resolve = r))
    const a: Ask<T> = { handleId, requestId: `br-${++this.seq}`, key, site, promise, resolve }
    this.asks.set(key, a as Ask<unknown>)
    this.emit(handleId, event(a.requestId))
    return a
  }

  private findAsk(handleId: string, requestId: string): Ask<unknown> | undefined {
    for (const a of this.asks.values()) if (a.handleId === handleId && a.requestId === requestId) return a
    return undefined
  }

  /**
   * Null when the site may load, else the text for the model. `waitMs` bounds the wait for a
   * tool call; the Gate stays up past it, and the verdict is recorded so the retry resolves at once.
   */
  private async siteGate(
    handleId: string,
    e: Entry,
    site: string,
    waitMs: number | null,
    cause: 'agent' | 'page'
  ): Promise<string | null> {
    if (e.deniedSites.has(site)) return TEXT.declined(site)
    if (await isApproved(site)) return null
    const from = cause === 'page' ? siteKeyOf(e.state.url) : null
    // The cursor's light goes out while the Gate is open; the sprite stays where Claude was.
    const wc = e.view?.webContents
    if (wc) void restCursor(wc, true)
    const a = this.ask<boolean>(handleId, `${handleId}\nsite\n${site}`, site, (requestId) => ({ type: 'site-request', requestId, site, cause, from }))
    if (wc) void a.promise.then(() => restCursor(wc, false))
    const allow = waitMs === null ? await a.promise : await within(a.promise, waitMs)
    if (allow === WAITING) return TEXT.siteWaiting
    if (e.state.drive === 'stopped') return TEXT.stopped
    return allow ? null : TEXT.declined(site)
  }

  async siteVerdict(handleId: string, requestId: string, allow: boolean): Promise<void> {
    const a = this.findAsk(handleId, requestId)
    if (!a) return
    // Applied now, not by the waiting tool call, so an answer that lands after the call gave up still counts.
    if (allow) await approve(a.site)
    else this.entries.get(handleId)?.deniedSites.add(a.site)
    this.asks.delete(a.key)
    a.resolve(allow)
  }

  /** Ask the user which login to fill, or to save one. Resolves to WAITING past the tool-call budget. */
  async loginGate(
    handleId: string,
    site: string,
    usernames: string[]
  ): Promise<LoginOutcome | typeof WAITING> {
    const key = `${handleId}\nlogin\n${site}`
    const a = this.ask<LoginOutcome>(handleId, key, site, (requestId) => ({
      type: 'login-request',
      requestId,
      request: usernames.length ? { kind: 'choose', site, usernames } : { kind: 'save', site }
    }))
    const out = await within(a.promise, GATE_WAIT_MS)
    if (out !== WAITING) this.asks.delete(key)
    return out
  }

  /** A login Gate still open (or answered but not yet picked up) for this site. */
  pendingLogin(handleId: string, site: string): boolean {
    return this.asks.has(`${handleId}\nlogin\n${site}`)
  }

  async loginVerdict(handleId: string, requestId: string, verdict: LoginVerdict): Promise<void> {
    const a = this.findAsk(handleId, requestId) as Ask<LoginOutcome> | undefined
    if (!a) return
    if (verdict.action === 'save') {
      try {
        const saved = await saveLogin({ site: a.site, username: verdict.username, password: verdict.password, totpSeed: verdict.totpSeed })
        a.resolve({ action: 'fill', loginId: saved.id })
      } catch (err) {
        // Dropped so the next autofill_login raises a fresh Gate; the renderer shows the error.
        this.asks.delete(a.key)
        a.resolve({ action: 'failed' })
        throw err
      }
      return
    }
    if (verdict.action === 'self') {
      const e = this.entries.get(handleId)
      if (e) this.setDrive(handleId, e, 'user')
    }
    a.resolve(verdict)
  }

  // --- drive state and tool calls ---

  drive(handleId: string, action: 'stop' | 'handback' | 'takeover' | 'reset'): void {
    const e = this.entries.get(handleId)
    if (!e) return
    const d = e.state.drive
    if (action === 'stop') this.setDrive(handleId, e, 'stopped')
    else if (action === 'handback' && d === 'user') this.setDrive(handleId, e, 'driving')
    else if (action === 'takeover' && d === 'driving') this.setDrive(handleId, e, 'user')
    else if (action === 'reset' && (d === 'stopped' || d === 'done')) this.setDrive(handleId, e, 'idle')
  }

  /** Null when Claude may act on a page at `url`: blank, opened by the user from the address bar, or approved. */
  async allowAgentAt(handleId: string, url: string): Promise<string | null> {
    const e = this.entries.get(handleId)
    if (!e) return TEXT.off
    if (url === 'about:blank') return null
    const site = siteKeyOf(url)
    if (!site) return TEXT.refused
    if (e.userSites.has(site)) return null
    return this.siteGate(handleId, e, site, GATE_WAIT_MS, 'agent')
  }

  /** Null when a tool call may run (the page is live and Claude is driving), else the text for the model. */
  async beginTool(handleId: string, tool: string): Promise<string | null> {
    const e = this.entries.get(handleId)
    if (!e) return TEXT.off
    if (e.state.drive === 'stopped') return TEXT.stopped
    if (e.state.drive === 'user') return TEXT.userDriving
    // navigate gates its own target. Every other tool acts on the page as it is now, and between
    // turns nothing stops a page from moving itself to a site nobody approved.
    if (tool !== 'navigate') {
      const refusal = await this.allowAgentAt(handleId, e.state.url)
      if (refusal) return refusal
      // The Gate can wait for a while, and the user may have stopped or taken over meanwhile.
      const now = this.entries.get(handleId)
      if (now !== e) return TEXT.off
      if (now.state.drive === 'stopped') return TEXT.stopped
      if (now.state.drive === 'user') return TEXT.userDriving
    }
    this.ensureView(handleId, e)
    const strip = e.state.drive === 'idle' || e.state.drive === 'done'
    this.setDrive(handleId, e, 'driving')
    // The status strip that comes with driving shortens the page a frame or two later, and a tool
    // reading the page before then would aim at the old, taller viewport.
    if (strip && e.shown) await this.nextBounds(e)
    return null
  }

  private nextBounds(e: Entry): Promise<void> {
    return new Promise((ok) => {
      const done = (): void => {
        clearTimeout(t)
        if (e.onBounds === done) e.onBounds = null
        ok()
      }
      const t = setTimeout(done, BOUNDS_WAIT_MS)
      e.onBounds?.()
      e.onBounds = done
    })
  }

  endTool(handleId: string): void {
    const e = this.entries.get(handleId)
    if (e) void this.refreshStill(handleId, e)
  }

  /** The live page and its CDP channel, for the tools. */
  page(handleId: string): { wc: WebContents; cdp: Cdp; view: WebContentsView } | null {
    const e = this.entries.get(handleId)
    return e?.view && e.cdp && !e.view.webContents.isDestroyed() ? { wc: e.view.webContents, cdp: e.cdp, view: e.view } : null
  }

  isStopped(handleId: string): boolean {
    return this.entries.get(handleId)?.state.drive === 'stopped'
  }

  emitFilled(handleId: string, site: string): void {
    this.emit(handleId, { type: 'filled', site })
  }

  onSessionEvent(handleId: string, ev: DomainEvent): void {
    const e = this.entries.get(handleId)
    if (e && ev.type === 'result' && e.state.drive === 'driving') this.setDrive(handleId, e, 'done')
  }

  // --- browsing data ---

  private liveViews(): WebContents[] {
    return [...this.entries.values()].flatMap((e) => (e.view && !e.view.webContents.isDestroyed() ? [e.view.webContents] : []))
  }

  async dataInfo(): Promise<BrowsingDataInfo> {
    const ses = session.fromPartition(PARTITION)
    const [cookies, cacheBytes] = await Promise.all([ses.cookies.get({}), ses.getCacheSize()])
    return {
      cookieSites: new Set(cookies.map((c) => (c.domain ?? '').replace(/^\./, ''))).size,
      cacheBytes,
      openPages: this.liveViews().length
    }
  }

  async clearData(what: ClearBrowsingData): Promise<void> {
    // The renderer disables the action while Claude drives; this holds if a drive starts mid-click.
    for (const e of this.entries.values()) {
      if (e.state.drive === 'driving' || e.state.drive === 'user') throw new Error('browser in use')
    }
    const ses = session.fromPartition(PARTITION)
    if (what.cookies) {
      await ses.clearData({
        dataTypes: ['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'fileSystems', 'webSQL', 'backgroundFetch']
      })
    }
    if (what.cache) await ses.clearCache()
    for (const [handleId, e] of this.entries) {
      const wc = e.view?.webContents
      if (!wc || wc.isDestroyed()) continue
      if (what.history) {
        wc.navigationHistory.clear()
        this.patch(handleId, e, { canBack: false, canForward: false })
      }
      wc.reload()
    }
  }

  disposeAll(): void {
    for (const h of [...this.entries.keys()]) this.dispose(h)
  }

  dispose(handleId: string): void {
    const e = this.entries.get(handleId)
    if (!e) return
    this.entries.delete(handleId)
    if (e.stillTimer) clearTimeout(e.stillTimer)
    for (const [key, a] of this.asks) {
      if (a.handleId !== handleId) continue
      this.asks.delete(key)
      a.resolve(key.includes('\nsite\n') ? false : { action: 'decline' })
    }
    if (e.view) {
      this.detach(e)
      if (!e.view.webContents.isDestroyed()) e.view.webContents.close()
    }
  }
}

export { WAITING }
