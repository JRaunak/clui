/**
 * Browser tabs per session, each a WebContentsView sharing the 'persist:clui-browser' partition
 * so a single sign-in covers every session. A view is a child of the window while the user views
 * it, or while it's parked: Claude acting in a tab nobody sees. Every new address loads through
 * navigate(); ensureView only loads about:blank or the URL a suspended tab already had.
 */
import { session, WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import {
  siteKeyOf,
  type BrowserEvent,
  type BrowserState,
  type BrowsingDataInfo,
  type ClearBrowsingData,
  type DriveState,
  type PaneBounds,
  type TabActor,
  type TabState
} from '../../shared/browser'
import type { DomainEvent } from '../../shared/events'
import { Cdp } from './cdp'
import { hideCursor, injectCursor, restCursor } from './cursor'
import { approve, isApproved, isApprovedCached, listSites } from './sites'
import { IpcChannels, type CluiApi } from '../../shared/ipc'
import { saveLogin } from './vault'

type LoginVerdict = Parameters<CluiApi['browserLoginVerdict']>[2]

const PARTITION = 'persist:clui-browser'
/** Tabs with a live page across every session, at about 85MB each. */
const MAX_LIVE = 6
/** The CLI abandons an MCP tool call after about 60s, so a Gate wait must answer before that. */
const GATE_WAIT_MS = 50_000
const LOAD_WAIT_MS = 20_000
const QUIET_MS = 150
const BOUNDS_WAIT_MS = 300
/** A view just added to the window paints its first frame a few ms later; reads before it see nothing. */
const FRAME_MS = 32
const PARK_SIZE = { width: 800, height: 600 }

export const TEXT = {
  refused: 'Only http(s) pages can be opened.',
  stopped: "The user stopped browser control. Don't retry unless they ask.",
  userDriving: 'The user is still driving the browser. Wait for them to hand it back.',
  off: 'The browser is off for this session.',
  declined: (site: string) => `The user declined opening ${site}.`,
  siteWaiting: 'Waiting for the user to answer the approval in Clui. Call the tool again after they answer.',
  noTab: (tab: unknown) => `There's no tab ${String(tab)}. Call tabs to see the open tabs.`,
  closed: (tab: number, by: TabActor) => (by === 'user' ? `The user closed tab ${tab}.` : `Tab ${tab} was closed.`)
} as const

/** A login Gate's answer, stripped of anything secret: a save has already been written to the vault. */
export type LoginOutcome = { action: 'fill'; loginId: string } | { action: 'decline' } | { action: 'self' } | { action: 'failed' }

const WAITING = Symbol('waiting')

interface Ask<T> {
  handleId: string
  tab: number
  requestId: string
  key: string
  site: string
  promise: Promise<T>
  resolve: (v: T) => void
}

interface Tab {
  id: number
  view: WebContentsView | null
  cdp: Cdp | null
  state: BrowserState
  lastViewedMs: number
  /** Currently a child of the window (re-adding a child reorders it, so it's tracked). */
  attached: boolean
  /** Reasons to keep the view in the window while nobody views it, so its page has a real viewport. */
  parks: number
  agentActingUntil: number
  stillTimer: ReturnType<typeof setTimeout> | null
  /** Resolves the wait for the renderer's next bounds report. */
  onBounds: (() => void) | null
  closers: Set<(by: TabActor) => void>
}

interface Entry {
  /** Open order, which is also id order. */
  tabs: Tab[]
  viewed: number
  /** The tab Claude acts in when a call names none. */
  lastUsed: number
  nextId: number
  bounds: PaneBounds | null
  shown: boolean
  /** Stop covers every tab, including ones opened before the next reset. */
  stopped: boolean
  deniedSites: Set<string>
  /** Sites the user opened from the address bar this session, which Claude may act on unasked. */
  userSites: Set<string>
}

export interface TabsInfo {
  viewed: number
  lastUsed: number
  tabs: Array<TabState & { attached: boolean; parked: boolean }>
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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

  private patch(handleId: string, t: Tab, patch: Partial<BrowserState>): void {
    Object.assign(t.state, patch)
    this.emit(handleId, { type: 'tab-state', tab: t.id, patch })
  }

  private find(handleId: string, id: number): [Entry, Tab] | null {
    const e = this.entries.get(handleId)
    const t = e?.tabs.find((x) => x.id === id)
    return e && t ? [e, t] : null
  }

  private addTab(e: Entry): Tab {
    const t: Tab = {
      id: e.nextId++,
      view: null,
      cdp: null,
      state: { ...initialState(), drive: e.stopped ? 'stopped' : 'idle' },
      lastViewedMs: Date.now(),
      attached: false,
      parks: 0,
      agentActingUntil: 0,
      stillTimer: null,
      onBounds: null,
      closers: new Set()
    }
    e.tabs.push(t)
    return t
  }

  /** A session that starts with the tools, on tab 1. Its page is created the first time it's shown or driven. */
  enable(handleId: string): void {
    if (this.entries.has(handleId)) return
    const e: Entry = {
      tabs: [],
      viewed: 1,
      lastUsed: 1,
      nextId: 1,
      bounds: null,
      shown: false,
      stopped: false,
      deniedSites: new Set(),
      userSites: new Set()
    }
    this.addTab(e)
    this.entries.set(handleId, e)
  }

  /** Create the view for a new or suspended tab, suspending the stalest page past the cap. */
  private ensureView(handleId: string, e: Entry, t: Tab): WebContentsView {
    if (t.view) return t.view
    this.enforceCap()
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
    t.view = view
    const wc = view.webContents
    t.cdp = new Cdp(
      wc,
      () => {
        t.agentActingUntil = Date.now() + QUIET_MS
      },
      () => {
        if (t.view?.webContents === wc) this.patch(handleId, t, { loginWall: 'hardware' })
      }
    )
    this.wire(handleId, e, t, wc)
    const resume = t.state.suspended && siteKeyOf(t.state.url) ? t.state.url : 'about:blank'
    void wc.loadURL(resume).catch(() => {})
    if (t.state.suspended) this.patch(handleId, t, { suspended: false })
    this.sync(e)
    return view
  }

  private busy(e: Entry, t: Tab): boolean {
    return (e.shown && e.viewed === t.id) || t.parks > 0 || t.state.drive === 'driving' || t.state.drive === 'user'
  }

  private enforceCap(): void {
    const live = [...this.entries].flatMap(([h, e]) => e.tabs.filter((t) => t.view).map((t) => ({ h, e, t })))
    if (live.length < MAX_LIVE) return
    const victim = live.filter(({ e, t }) => !this.busy(e, t)).sort((a, b) => a.t.lastViewedMs - b.t.lastViewedMs)[0]
    // With every other tab viewed, parked or driven, the cap is exceeded rather than closing one of them.
    if (victim) void this.suspend(victim.h, victim.e, victim.t)
  }

  private async suspend(handleId: string, e: Entry, t: Tab): Promise<void> {
    const view = t.view
    if (!view) return
    const still = await this.capture(t)
    // The capture yields, and the tab may have been viewed, driven or closed meanwhile.
    if (t.view !== view || this.busy(e, t)) return
    this.detach(t)
    t.view = null
    t.cdp = null
    if (!view.webContents.isDestroyed()) view.webContents.close()
    this.patch(handleId, t, { suspended: true, loading: false, ...(still ? { still } : {}) })
  }

  private wire(handleId: string, e: Entry, t: Tab, wc: WebContents): void {
    const mine = (): boolean => t.view?.webContents === wc
    wc.setWindowOpenHandler(({ url }) => {
      void this.navigate(handleId, t.id, url, 'page')
      return { action: 'deny' }
    })
    const guard = (ev: Electron.Event, url: string, isMainFrame: boolean): void => {
      if (!isMainFrame) return
      const site = siteKeyOf(url)
      if (!site) return ev.preventDefault()
      if (t.state.drive !== 'driving' || isApprovedCached(site) || e.userSites.has(site)) return
      ev.preventDefault()
      if (e.deniedSites.has(site)) return
      void this.siteGate(handleId, e, t, site, null, 'page').then((refusal) => {
        if (!refusal && mine()) void this.navigate(handleId, t.id, url, 'user')
      })
    }
    wc.on('will-navigate', (ev) => guard(ev, ev.url, ev.isMainFrame))
    wc.on('will-redirect', (ev) => guard(ev, ev.url, ev.isMainFrame))
    wc.on('did-start-loading', () => mine() && this.patch(handleId, t, { loading: true }))
    wc.on('did-stop-loading', () => {
      if (!mine()) return
      this.patch(handleId, t, { loading: false })
      void this.refreshStill(handleId, t)
    })
    const navigated = (url: string): void => {
      if (!mine()) return
      const h = wc.navigationHistory
      this.patch(handleId, t, { url, canBack: h.canGoBack(), canForward: h.canGoForward() })
    }
    wc.on('did-navigate', (_ev, url) => {
      navigated(url)
      if (mine() && t.state.loginWall) this.patch(handleId, t, { loginWall: null })
      void injectCursor(wc)
    })
    wc.on('did-navigate-in-page', (_ev, url, isMainFrame) => isMainFrame && navigated(url))
    wc.on('dom-ready', () => void injectCursor(wc))
    wc.on('page-title-updated', (_ev, title) => mine() && this.patch(handleId, t, { title }))
    wc.on('render-process-gone', () => mine() && this.setDrive(handleId, t, 'stopped'))
    // CDP mouse and key events raise these the same as real input, so only input outside the
    // quiet window around our own dispatches counts as the user.
    wc.on('input-event', (_ev, input) => {
      if (!USER_INPUT.has(input.type) || Date.now() <= t.agentActingUntil) return
      // macOS scrolls whatever window is under the pointer, so a wheel over Clui while another app
      // is frontmost is the user passing by, not taking over.
      if (input.type === 'mouseWheel' && !this.window()?.isFocused()) return
      this.userActed(handleId, t)
    })
    wc.on('before-input-event', (_ev, input) => {
      if (input.type === 'keyDown' && !input.meta && !input.control && Date.now() > t.agentActingUntil) this.userActed(handleId, t)
    })
  }

  private userActed(handleId: string, t: Tab): void {
    if (t.state.drive === 'driving') this.setDrive(handleId, t, 'user')
    if (t.state.drive === 'user') this.scheduleStill(handleId, t, 500)
  }

  private setDrive(handleId: string, t: Tab, drive: DriveState): void {
    if (t.state.drive === drive) return
    this.patch(handleId, t, { drive })
    const wc = t.view?.webContents
    if (drive !== 'driving' && wc) void hideCursor(wc)
  }

  // --- tabs ---

  tabsOf(handleId: string): TabsInfo | null {
    const e = this.entries.get(handleId)
    if (!e) return null
    return {
      viewed: e.viewed,
      lastUsed: e.lastUsed,
      tabs: e.tabs.map((t) => ({ ...t.state, id: t.id, attached: t.attached, parked: t.parks > 0 }))
    }
  }

  /** Records the tab a tool call resolved to, which later calls default to. */
  used(handleId: string, tab: number): void {
    const e = this.entries.get(handleId)
    if (e?.tabs.some((t) => t.id === tab)) e.lastUsed = tab
  }

  toolTab(handleId: string, toolUseId: string, tab: number): void {
    this.emit(handleId, { type: 'tool-tab', toolUseId, tab })
  }

  /** Calls `fn` once if the tab closes. Returns the unsubscribe. */
  onTabClosed(handleId: string, tab: number, fn: (by: TabActor) => void): () => void {
    const t = this.find(handleId, tab)?.[1]
    if (!t) return () => {}
    t.closers.add(fn)
    return () => t.closers.delete(fn)
  }

  private show(handleId: string, e: Entry, t: Tab): void {
    const now = Date.now()
    const prev = e.tabs.find((x) => x.id === e.viewed)
    if (prev) prev.lastViewedMs = now
    e.viewed = t.id
    t.lastViewedMs = now
    if (e.shown) this.ensureView(handleId, e, t)
    this.sync(e)
  }

  viewTab(handleId: string, tab: number): void {
    const f = this.find(handleId, tab)
    if (f) this.show(handleId, f[0], f[1])
  }

  /** The user's tab is viewed at once; Claude's opens behind the one the user is looking at. */
  async newTab(handleId: string, by: TabActor, url?: string): Promise<number | null> {
    const e = this.entries.get(handleId)
    if (!e) return null
    const t = this.addTab(e)
    if (by === 'user') this.show(handleId, e, t)
    this.emit(handleId, { type: 'tab-opened', tab: { ...t.state, id: t.id }, by, viewed: e.viewed, ...(url ? { url } : {}) })
    if (by === 'user') return t.id
    this.ensureView(handleId, e, t)
    t.parks++
    this.sync(e)
    await sleep(FRAME_MS)
    t.parks--
    this.sync(e)
    return t.id
  }

  /** Closing the last tab opens a fresh one first, so a session always has a tab to view. */
  closeTab(handleId: string, tab: number, by: TabActor): void {
    const f = this.find(handleId, tab)
    if (!f) return
    const [e, t] = f
    const i = e.tabs.indexOf(t)
    // Focus inside a closing page would stay with the dead view, where the renderer can't move it.
    const hadFocus = !!t.view && !t.view.webContents.isDestroyed() && t.view.webContents.isFocused()
    if (e.tabs.length === 1) {
      const fresh = this.addTab(e)
      this.show(handleId, e, fresh)
      this.emit(handleId, { type: 'tab-opened', tab: { ...fresh.state, id: fresh.id }, by, viewed: fresh.id })
    } else if (e.viewed === tab) {
      this.show(handleId, e, e.tabs[i + 1] ?? e.tabs[i - 1])
    }
    e.tabs.splice(i, 1)
    this.drop(handleId, t)
    if (hadFocus) this.window()?.webContents.focus()
    this.emit(handleId, { type: 'tab-closed', tab, by, viewed: e.viewed })
    for (const fn of t.closers) fn(by)
  }

  /**
   * Tears down one tab's page and answers its login Gates. A site Gate belongs to the session, and
   * another tab may be waiting on the same answer, so it stays up.
   */
  private drop(handleId: string, t: Tab): void {
    if (t.stillTimer) clearTimeout(t.stillTimer)
    t.stillTimer = null
    t.onBounds?.()
    for (const [key, a] of this.asks) {
      if (a.handleId !== handleId || a.tab !== t.id || key.includes('\nsite\n')) continue
      this.asks.delete(key)
      a.resolve({ action: 'decline' })
    }
    if (t.view) {
      this.detach(t)
      if (!t.view.webContents.isDestroyed()) t.view.webContents.close()
    }
    t.view = null
    t.cdp = null
  }

  // --- showing, bounds, stills ---

  /**
   * The viewed tab sits in the pane while the pane is shown and its bounds are known. A parked
   * tab sits with only its top-left pixel inside the window's bottom-right corner, under the rounded mask:
   * the page gets a full viewport and paints, and nobody sees it.
   */
  private sync(e: Entry): void {
    const win = this.window()
    if (!win || win.isDestroyed()) return
    const z = win.webContents.getZoomFactor()
    const pane = e.bounds
      ? z === 1
        ? e.bounds
        : { x: Math.round(e.bounds.x * z), y: Math.round(e.bounds.y * z), width: Math.round(e.bounds.width * z), height: Math.round(e.bounds.height * z) }
      : null
    for (const t of e.tabs) {
      if (!t.view) continue
      let rect: PaneBounds | null = null
      if (e.shown && pane && t.id === e.viewed) rect = pane
      else if (t.parks > 0) {
        const [w, h] = win.getContentSize()
        rect = { x: w - 1, y: h - 1, width: pane?.width ?? PARK_SIZE.width, height: pane?.height ?? PARK_SIZE.height }
      }
      if (!rect) {
        this.detach(t)
        continue
      }
      t.view.setBounds(rect)
      if (!t.attached) win.contentView.addChildView(t.view)
      t.attached = true
    }
  }

  private detach(t: Tab): void {
    const win = this.window()
    if (t.view && t.attached && win && !win.isDestroyed()) win.contentView.removeChildView(t.view)
    t.attached = false
  }

  /** A parked view's corner moves with the window's size, and a window that grew would show it. */
  relayout(): void {
    for (const e of this.entries.values()) this.sync(e)
  }

  /** A blank or transparent page shows the view's own background, so it follows the theme. */
  repaint(): void {
    const bg = this.background()
    for (const e of this.entries.values()) {
      for (const t of e.tabs) if (t.view && !t.view.webContents.isDestroyed()) t.view.setBackgroundColor(bg)
    }
  }

  setBounds(handleId: string, b: PaneBounds | null): void {
    const e = this.entries.get(handleId)
    if (!e) return
    e.bounds = b
    this.sync(e)
    const t = e.tabs.find((x) => x.id === e.viewed)
    if (!t) return
    t.onBounds?.()
    if (b) this.scheduleStill(handleId, t, 300)
  }

  async setVisible(handleId: string, visible: boolean): Promise<string | null> {
    const e = this.entries.get(handleId)
    const t = e?.tabs.find((x) => x.id === e.viewed)
    if (!e || !t) return null
    if (visible) {
      for (const [h, other] of this.entries) if (h !== handleId && other.shown) await this.setVisible(h, false)
      e.shown = true
      t.lastViewedMs = Date.now()
      this.ensureView(handleId, e, t)
      this.sync(e)
      return null
    }
    if (!e.shown) return t.state.still
    // Whatever asked to hide the page is about to draw where it sits, so it goes first. A capture
    // straight after the detach still returns the last frame that was on screen.
    e.shown = false
    t.lastViewedMs = Date.now()
    this.sync(e)
    return this.refreshStill(handleId, t)
  }

  private async capture(t: Tab): Promise<string | null> {
    const wc = t.view?.webContents
    if (!wc || wc.isDestroyed()) return null
    try {
      const img = await wc.capturePage()
      return img.isEmpty() ? null : img.toDataURL()
    } catch {
      return null
    }
  }

  private async refreshStill(handleId: string, t: Tab): Promise<string | null> {
    if (t.stillTimer) clearTimeout(t.stillTimer)
    t.stillTimer = null
    const still = await this.capture(t)
    if (still && this.find(handleId, t.id)?.[1] === t) this.patch(handleId, t, { still })
    return still ?? t.state.still
  }

  private scheduleStill(handleId: string, t: Tab, ms: number): void {
    if (t.stillTimer) clearTimeout(t.stillTimer)
    t.stillTimer = setTimeout(() => void this.refreshStill(handleId, t), ms)
  }

  // --- navigation ---

  async navigate(handleId: string, tab: number, url: string, cause: 'agent' | 'user' | 'page'): Promise<string | null> {
    const site = siteKeyOf(url)
    if (!site) return TEXT.refused
    const f = this.find(handleId, tab)
    if (!f) return this.entries.has(handleId) ? TEXT.noTab(tab) : TEXT.off
    const [e, t] = f
    if (cause === 'user') e.userSites.add(site)
    else if (cause === 'agent' || t.state.drive === 'driving') {
      const refusal = await this.siteGate(handleId, e, t, site, cause === 'agent' ? GATE_WAIT_MS : null, cause)
      if (refusal) return refusal
      if (!this.find(handleId, tab)) return TEXT.noTab(tab)
    }
    const wc = this.ensureView(handleId, e, t).webContents
    const load = wc.loadURL(url)
    if (cause !== 'agent') {
      void load.catch(() => {})
      return null
    }
    try {
      await Promise.race([load, sleep(LOAD_WAIT_MS)])
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code && code !== 'ERR_ABORTED') return `Couldn't open ${url} (${code}).`
    }
    return null
  }

  async nav(handleId: string, tab: number, action: 'back' | 'forward' | 'reload' | 'stop'): Promise<void> {
    const f = this.find(handleId, tab)
    if (!f) return
    const [e, t] = f
    if (!t.view) {
      if (action === 'reload') this.ensureView(handleId, e, t)
      return
    }
    const wc = t.view.webContents
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    else if (action === 'reload') wc.reload()
    else if (action === 'stop') wc.stop()
  }

  // --- Gates ---

  private ask<T>(handleId: string, tab: number, key: string, site: string, event: (requestId: string) => BrowserEvent): Ask<T> {
    const existing = this.asks.get(key)
    if (existing) return existing as Ask<T>
    let resolve!: (v: T) => void
    const promise = new Promise<T>((r) => (resolve = r))
    const a: Ask<T> = { handleId, tab, requestId: `br-${++this.seq}`, key, site, promise, resolve }
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
    t: Tab,
    site: string,
    waitMs: number | null,
    cause: 'agent' | 'page'
  ): Promise<string | null> {
    if (e.deniedSites.has(site)) return TEXT.declined(site)
    if (await isApproved(site)) return null
    const from = cause === 'page' ? siteKeyOf(t.state.url) : null
    // The cursor's light goes out while the Gate is open; the sprite stays where Claude was.
    const wc = t.view?.webContents
    if (wc) void restCursor(wc, true)
    const a = this.ask<boolean>(handleId, t.id, `${handleId}\nsite\n${site}`, site, (requestId) => ({
      type: 'site-request',
      requestId,
      site,
      cause,
      from,
      tab: t.id
    }))
    if (wc) void a.promise.then(() => restCursor(wc, false))
    const allow = waitMs === null ? await a.promise : await within(a.promise, waitMs)
    if (allow === WAITING) return TEXT.siteWaiting
    if (t.state.drive === 'stopped') return TEXT.stopped
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
    tab: number,
    site: string,
    usernames: string[]
  ): Promise<LoginOutcome | typeof WAITING> {
    const key = `${handleId}\nlogin\n${site}`
    const a = this.ask<LoginOutcome>(handleId, tab, key, site, (requestId) => ({
      type: 'login-request',
      requestId,
      request: usernames.length ? { kind: 'choose', site, usernames } : { kind: 'save', site },
      tab
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
      const t = this.find(handleId, a.tab)?.[1]
      if (t) this.setDrive(handleId, t, 'user')
    }
    a.resolve(verdict)
  }

  // --- drive state and tool calls ---

  /** stop and reset cover every tab of the session; handback and takeover only `tab`. */
  drive(handleId: string, action: 'stop' | 'handback' | 'takeover' | 'reset', tab?: number): void {
    const e = this.entries.get(handleId)
    if (!e) return
    if (action === 'stop' || action === 'reset') {
      e.stopped = action === 'stop'
      for (const t of e.tabs) {
        const d = t.state.drive
        if (action === 'stop') this.setDrive(handleId, t, 'stopped')
        else if (d === 'stopped' || d === 'done') this.setDrive(handleId, t, 'idle')
      }
      return
    }
    const t = e.tabs.find((x) => x.id === tab)
    if (!t) return
    if (action === 'handback' && t.state.drive === 'user') this.setDrive(handleId, t, 'driving')
    else if (action === 'takeover' && t.state.drive === 'driving') this.setDrive(handleId, t, 'user')
  }

  /** For the test harness: any drive state, bypassing the transitions the UI allows. */
  setTabDrive(handleId: string, tab: number, drive: DriveState): void {
    const t = this.find(handleId, tab)?.[1]
    if (t) this.setDrive(handleId, t, drive)
  }

  /** For the test harness: suspends the tab unless it's viewed, parked or driven. */
  suspendTab(handleId: string, tab: number): Promise<void> {
    const f = this.find(handleId, tab)
    return f ? this.suspend(handleId, f[0], f[1]) : Promise.resolve()
  }

  /** Null when Claude may act on a page at `url`: blank, opened by the user from the address bar, or approved. */
  async allowAgentAt(handleId: string, tab: number, url: string): Promise<string | null> {
    const f = this.find(handleId, tab)
    if (!f) return this.entries.has(handleId) ? TEXT.noTab(tab) : TEXT.off
    if (url === 'about:blank') return null
    const site = siteKeyOf(url)
    if (!site) return TEXT.refused
    if (f[0].userSites.has(site)) return null
    return this.siteGate(handleId, f[0], f[1], site, GATE_WAIT_MS, 'agent')
  }

  /**
   * Null when a tool call may run (the page is live and Claude is driving), else the text for
   * the model. On null the tab stays parked until endTool, unless the user is viewing it.
   */
  async beginTool(handleId: string, tab: number, tool: string): Promise<string | null> {
    const f = this.find(handleId, tab)
    if (!f) return this.entries.has(handleId) ? TEXT.noTab(tab) : TEXT.off
    const [e, t] = f
    if (t.state.drive === 'stopped') return TEXT.stopped
    if (t.state.drive === 'user') return TEXT.userDriving
    // navigate gates its own target. Every other tool acts on the page as it is now, and between
    // turns nothing stops a page from moving itself to a site nobody approved.
    if (tool !== 'navigate') {
      const refusal = await this.allowAgentAt(handleId, tab, t.state.url)
      if (refusal) return refusal
      // The Gate can wait for a while, and the user may have stopped, taken over or closed the tab meanwhile.
      const now = this.find(handleId, tab)?.[1]
      if (now !== t) return TEXT.noTab(tab)
      if (now.state.drive === 'stopped') return TEXT.stopped
      if (now.state.drive === 'user') return TEXT.userDriving
    }
    this.ensureView(handleId, e, t)
    const strip = t.state.drive === 'idle' || t.state.drive === 'done'
    this.setDrive(handleId, t, 'driving')
    const fresh = !t.attached
    t.parks++
    this.sync(e)
    // The status strip that comes with driving shortens the page a frame or two later, and a tool
    // reading the page before then would aim at the old, taller viewport.
    if (strip && e.shown && e.viewed === tab) await this.nextBounds(t)
    else if (fresh && t.attached) await sleep(FRAME_MS)
    return null
  }

  private nextBounds(t: Tab): Promise<void> {
    return new Promise((ok) => {
      const done = (): void => {
        clearTimeout(timer)
        if (t.onBounds === done) t.onBounds = null
        ok()
      }
      const timer = setTimeout(done, BOUNDS_WAIT_MS)
      t.onBounds?.()
      t.onBounds = done
    })
  }

  /** Captures the still while the page can still paint, then unparks it. */
  endTool(handleId: string, tab: number): void {
    const f = this.find(handleId, tab)
    if (!f) return
    const [e, t] = f
    void this.refreshStill(handleId, t).then(() => {
      t.parks = Math.max(0, t.parks - 1)
      this.sync(e)
    })
  }

  /** The live page and its CDP channel, for the tools. */
  page(handleId: string, tab: number): { wc: WebContents; cdp: Cdp; view: WebContentsView } | null {
    const t = this.find(handleId, tab)?.[1]
    return t?.view && t.cdp && !t.view.webContents.isDestroyed() ? { wc: t.view.webContents, cdp: t.cdp, view: t.view } : null
  }

  isStopped(handleId: string, tab: number): boolean {
    return this.find(handleId, tab)?.[1].state.drive === 'stopped'
  }

  /** Stop covers the session, so a tab opened after it is stopped too. */
  sessionStopped(handleId: string): boolean {
    return !!this.entries.get(handleId)?.stopped
  }

  emitFilled(handleId: string, tab: number, site: string): void {
    this.emit(handleId, { type: 'filled', site, tab })
  }

  onSessionEvent(handleId: string, ev: DomainEvent): void {
    const e = this.entries.get(handleId)
    if (!e || ev.type !== 'result') return
    for (const t of e.tabs) if (t.state.drive === 'driving') this.setDrive(handleId, t, 'done')
  }

  // --- browsing data ---

  private liveTabs(): Array<[string, Tab, WebContents]> {
    return [...this.entries].flatMap(([h, e]) =>
      e.tabs.flatMap((t): Array<[string, Tab, WebContents]> => (t.view && !t.view.webContents.isDestroyed() ? [[h, t, t.view.webContents]] : []))
    )
  }

  async dataInfo(): Promise<BrowsingDataInfo> {
    const ses = session.fromPartition(PARTITION)
    const [cookies, cacheBytes] = await Promise.all([ses.cookies.get({}), ses.getCacheSize()])
    return {
      cookieSites: new Set(cookies.map((c) => (c.domain ?? '').replace(/^\./, ''))).size,
      cacheBytes,
      openPages: this.liveTabs().length
    }
  }

  async clearData(what: ClearBrowsingData): Promise<void> {
    // The renderer disables the action while Claude drives; this holds if a drive starts mid-click.
    for (const e of this.entries.values()) {
      if (e.tabs.some((t) => t.state.drive === 'driving' || t.state.drive === 'user')) throw new Error('browser in use')
    }
    const ses = session.fromPartition(PARTITION)
    if (what.cookies) {
      await ses.clearData({
        dataTypes: ['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'fileSystems', 'webSQL', 'backgroundFetch']
      })
    }
    if (what.cache) await ses.clearCache()
    for (const [handleId, t, wc] of this.liveTabs()) {
      if (what.history) {
        wc.navigationHistory.clear()
        this.patch(handleId, t, { canBack: false, canForward: false })
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
    for (const [key, a] of this.asks) {
      if (a.handleId !== handleId) continue
      this.asks.delete(key)
      a.resolve(key.includes('\nsite\n') ? false : { action: 'decline' })
    }
    for (const t of e.tabs) this.drop(handleId, t)
  }
}

export { WAITING }
