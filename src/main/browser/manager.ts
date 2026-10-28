/**
 * Browser tabs per session, each a WebContentsView sharing the 'persist:clui-browser' partition
 * so a single sign-in covers every session. A view is a child of the window while the user views
 * it, or while it's parked: Claude acting in a tab nobody sees. Every new address loads through
 * navigate(); ensureView only loads about:blank or the URL a suspended or restored tab already had.
 */
import { session, WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import {
  LOCAL_NET_PERMS,
  localNetVerdict,
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
import type { SavedBrowser } from '../../shared/surfaces'
import { Cdp } from './cdp'
import { hideCursor, injectCursor, restCursor } from './cursor'
import { approve, decideLocalNet, forgetLocalNet, isApproved, isApprovedCached, listSites, localNetCached } from './sites'
import { IpcChannels, type CluiApi } from '../../shared/ipc'
import { saveLogin } from './vault'
import { NativeViewSlot, stillOf } from '../surfaces/native-slot'

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

export const TEXT = {
  refused: 'Only http(s) pages can be opened.',
  stopped: "The user stopped browser control. Don't retry unless they ask.",
  userDriving: 'The user is still driving the browser. Wait for them to hand it back.',
  off: 'The browser is off for this session.',
  declined: (site: string) => `The user declined opening ${site}.`,
  siteWaiting: 'Waiting for the user to answer the approval in Clui. Call the tool again after they answer.',
  noTab: (tab: unknown) => `There's no tab ${String(tab)}. Call tabs to see the open tabs.`,
  noTabs: 'No tabs are open. Open one with new_tab.',
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
  /** Reasons to keep the view in the window while nobody views it, so its page has a real viewport. */
  parks: number
  agentActingUntil: number
  /** When the last user-input event went out, so a drag or a held key sends one a second. */
  inputSentAt: number
  stillTimer: ReturnType<typeof setTimeout> | null
  /** Resolves the wait for the renderer's next bounds report. */
  onBounds: (() => void) | null
  closers: Set<(by: TabActor) => void>
  /** Sites this tab has asked about local network access, so a page that re-checks doesn't ask again. */
  netAsked: Set<string>
}

interface Entry {
  /** Open order, which is also id order. */
  tabs: Tab[]
  viewed: number
  /** The tab Claude acts in when a call names none. */
  lastUsed: number
  nextId: number
  slot: NativeViewSlot
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
/** SSL_PROTOCOL_ERROR, CONNECTION_CLOSED, CONNECTION_RESET, EMPTY_RESPONSE: how a plain-http server answers a TLS handshake. */
const HTTP_SHAPED = new Set([-107, -100, -101, -324])

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
    loginWall: null,
    netAsk: null,
    loadError: null
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
  /** Told when a tab can't be annotated any more: Claude starts driving it, or the user views another tab. */
  onLeave: ((handleId: string, tab: number, why: 'driving' | 'away') => void) | null = null
  /** Told when a tab's document is gone: a cross-document load, close, suspend or renderer crash. */
  onDocumentGone: ((handleId: string, tab: number, reason: 'navigated' | 'closed') => void) | null = null
  /** A tab holding pins for a message isn't suspended, which would silently drop them. */
  holdsPins: ((handleId: string, tab: number) => boolean) | null = null

  private readonly window: () => BrowserWindow | null
  private readonly background: () => string

  constructor(window: () => BrowserWindow | null, background: () => string) {
    this.window = window
    this.background = background
    const ses = session.fromPartition(PARTITION)
    ses.setPermissionRequestHandler((wc, perm, cb, d) =>
      cb(LOCAL_NET_PERMS.has(perm) ? this.localNet(wc, d.isMainFrame, d.requestingUrl) : perm === 'clipboard-sanitized-write' || perm === 'fullscreen')
    )
    ses.setPermissionCheckHandler((wc, perm, origin, d) =>
      LOCAL_NET_PERMS.has(perm) ? this.localNet(wc, d.isMainFrame, origin) : perm === 'clipboard-sanitized-write' || perm === 'fullscreen'
    )
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

  private addTab(e: Entry, saved?: SavedBrowser['tabs'][number]): Tab {
    const t: Tab = {
      id: saved?.id ?? e.nextId++,
      view: null,
      cdp: null,
      state: { ...initialState(), drive: e.stopped ? 'stopped' : 'idle', ...(saved ? { url: saved.url } : {}) },
      lastViewedMs: saved?.lastViewedAt ?? Date.now(),
      parks: 0,
      agentActingUntil: 0,
      inputSentAt: 0,
      stillTimer: null,
      onBounds: null,
      closers: new Set(),
      netAsked: new Set()
    }
    e.tabs.push(t)
    return t
  }

  /** A session that starts with the tools, with no tabs or the tabs it saved. A page is created the first time
   *  its tab is shown or driven, and a saved tab loads its address then. */
  enable(handleId: string, saved?: SavedBrowser | null): void {
    if (this.entries.has(handleId)) return
    const e: Entry = {
      tabs: [],
      viewed: 1,
      lastUsed: 1,
      nextId: 1,
      slot: new NativeViewSlot(this.window, () => this.setVisible(handleId, false)),
      stopped: false,
      deniedSites: new Set(),
      userSites: new Set()
    }
    if (saved) {
      for (const t of saved.tabs) this.addTab(e, t)
      e.nextId = saved.nextId
      e.viewed = e.lastUsed = saved.tabs.some((t) => t.id === saved.viewed) ? saved.viewed : (saved.tabs.at(-1)?.id ?? 1)
    }
    this.entries.set(handleId, e)
  }

  /** The session's tabs by id and address, for the Surfaces sidecar. */
  records(handleId: string): SavedBrowser | null {
    const e = this.entries.get(handleId)
    if (!e) return null
    return { tabs: e.tabs.map((t) => ({ id: t.id, url: t.state.url, lastViewedAt: t.lastViewedMs })), nextId: e.nextId, viewed: e.viewed }
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
    const resume = siteKeyOf(t.state.url) ? t.state.url : 'about:blank'
    void wc.loadURL(resume).catch(() => {})
    if (t.state.suspended) this.patch(handleId, t, { suspended: false })
    this.sync(e)
    return view
  }

  private busy(handleId: string, e: Entry, t: Tab, pins = true): boolean {
    return (
      (e.slot.shown && e.viewed === t.id) ||
      t.parks > 0 ||
      t.state.drive === 'driving' ||
      t.state.drive === 'user' ||
      (pins && !!this.holdsPins?.(handleId, t.id))
    )
  }

  private enforceCap(): void {
    const live = [...this.entries].flatMap(([h, e]) => e.tabs.filter((t) => t.view).map((t) => ({ h, e, t })))
    if (live.length < MAX_LIVE) return
    const oldest = (pins: boolean) => live.filter(({ h, e, t }) => !this.busy(h, e, t, pins)).sort((a, b) => a.t.lastViewedMs - b.t.lastViewedMs)[0]
    // Pins only delay a suspend, or the renderer could hold every tab live. With every other tab viewed, parked
    // or driven, the cap is exceeded rather than closing one of them.
    const victim = oldest(true) ?? oldest(false)
    if (victim) void this.suspend(victim.h, victim.e, victim.t)
  }

  private async suspend(handleId: string, e: Entry, t: Tab): Promise<void> {
    const view = t.view
    if (!view) return
    const still = await stillOf(t.view?.webContents)
    // The capture yields, and the tab may have been viewed, driven or closed meanwhile.
    if (t.view !== view || this.busy(handleId, e, t)) return
    e.slot.place(view, null)
    t.view = null
    t.cdp = null
    if (!view.webContents.isDestroyed()) view.webContents.close()
    this.patch(handleId, t, { suspended: true, loading: false, ...(still ? { still } : {}) })
    this.onDocumentGone?.(handleId, t.id, 'closed')
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
      if (mine()) this.onDocumentGone?.(handleId, t.id, 'navigated')
      if (mine() && t.state.loginWall) this.patch(handleId, t, { loginWall: null })
      // Cleared on commit, not on start, so a retry that fails again never shows the view in between.
      // An error page's commit doesn't raise did-navigate.
      if (mine() && t.state.loadError) this.patch(handleId, t, { loadError: null })
      if (mine() && t.state.netAsk && t.state.netAsk !== siteKeyOf(url)) this.patch(handleId, t, { netAsk: null })
      void injectCursor(wc)
    })
    wc.on('did-navigate-in-page', (_ev, url, isMainFrame) => isMainFrame && navigated(url))
    // -3 is ERR_ABORTED: Stop, or a newer load replacing this one. An HTTP error status isn't a failure; its page renders.
    wc.on('did-fail-load', (_ev, code, name, url, isMainFrame) => {
      if (!isMainFrame || code === -3 || !mine()) return
      const httpUrl = HTTP_SHAPED.has(code) && url.startsWith('https:') ? `http:${url.slice(6)}` : null
      this.patch(handleId, t, { loadError: { url, code, name, httpUrl } })
    })
    wc.on('dom-ready', () => void injectCursor(wc))
    wc.on('page-title-updated', (_ev, title) => mine() && this.patch(handleId, t, { title }))
    wc.on('render-process-gone', () => {
      if (!mine()) return
      this.setDrive(handleId, t, 'stopped')
      this.onDocumentGone?.(handleId, t.id, 'closed')
    })
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

  /** Why a tool can't reach `tab`. */
  private missing(handleId: string, tab: number): string {
    const e = this.entries.get(handleId)
    return !e ? TEXT.off : e.tabs.length ? TEXT.noTab(tab) : TEXT.noTabs
  }

  private userActed(handleId: string, t: Tab): void {
    const now = Date.now()
    if (now - t.inputSentAt >= 1000) {
      t.inputSentAt = now
      this.emit(handleId, { type: 'user-input', tab: t.id })
    }
    if (t.state.drive === 'driving') this.setDrive(handleId, t, 'user')
    if (t.state.drive === 'user') this.scheduleStill(handleId, t, 500)
  }

  private setDrive(handleId: string, t: Tab, drive: DriveState): void {
    if (t.state.drive === drive) return
    if (drive === 'driving') this.onLeave?.(handleId, t.id, 'driving')
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
      tabs: e.tabs.map((t) => ({ ...t.state, id: t.id, attached: e.slot.holds(t.view), parked: t.parks > 0 }))
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
    if (prev && prev !== t) this.onLeave?.(handleId, prev.id, 'away')
    e.viewed = t.id
    t.lastViewedMs = now
    if (e.slot.shown) this.ensureView(handleId, e, t)
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
    // With no tab left to stand behind, Claude's becomes the viewed one, though nothing shows it yet.
    if (by === 'user') this.show(handleId, e, t)
    else if (e.tabs.length === 1) e.viewed = t.id
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

  /** Closing the last tab leaves none and hides the view; "+" or Show Browser opens a new one. */
  closeTab(handleId: string, tab: number, by: TabActor): void {
    const f = this.find(handleId, tab)
    if (!f) return
    const [e, t] = f
    const i = e.tabs.indexOf(t)
    // Focus inside a closing page would stay with the dead view, where the renderer can't move it.
    const hadFocus = !!t.view && !t.view.webContents.isDestroyed() && t.view.webContents.isFocused()
    if (e.tabs.length === 1) e.slot.hide()
    else if (e.viewed === tab) this.show(handleId, e, e.tabs[i + 1] ?? e.tabs[i - 1])
    e.tabs.splice(i, 1)
    this.drop(handleId, e, t)
    if (hadFocus) this.window()?.webContents.focus()
    this.emit(handleId, { type: 'tab-closed', tab, by, viewed: e.viewed })
    for (const fn of t.closers) fn(by)
  }

  /**
   * Tears down one tab's page and answers its login Gates. A site Gate belongs to the session, and
   * another tab may be waiting on the same answer, so it stays up.
   */
  private drop(handleId: string, e: Entry, t: Tab): void {
    if (t.stillTimer) clearTimeout(t.stillTimer)
    t.stillTimer = null
    t.onBounds?.()
    for (const [key, a] of this.asks) {
      if (a.handleId !== handleId || a.tab !== t.id || key.includes('\nsite\n')) continue
      this.asks.delete(key)
      a.resolve({ action: 'decline' })
    }
    if (t.view) {
      e.slot.place(t.view, null)
      if (!t.view.webContents.isDestroyed()) t.view.webContents.close()
    }
    t.view = null
    t.cdp = null
    this.onDocumentGone?.(handleId, t.id, 'closed')
  }

  // --- showing, bounds, stills ---

  /** The viewed tab sits in the pane while the pane is shown and its bounds are known; a parked tab sits parked. */
  private sync(e: Entry): void {
    const win = this.window()
    if (!win || win.isDestroyed()) return
    const pane = e.slot.pane()
    for (const t of e.tabs) {
      if (!t.view) continue
      e.slot.place(t.view, e.slot.shown && pane && t.id === e.viewed ? pane : t.parks > 0 ? e.slot.park() : null)
    }
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
    e.slot.bounds = b
    this.sync(e)
    const t = e.tabs.find((x) => x.id === e.viewed)
    if (!t) return
    t.onBounds?.()
    if (b) this.scheduleStill(handleId, t, 300)
  }

  async setVisible(handleId: string, visible: boolean): Promise<string | null> {
    const e = this.entries.get(handleId)
    const t = e?.tabs.find((x) => x.id === e.viewed)
    if (!e) return null
    if (!t) {
      e.slot.hide()
      return null
    }
    if (visible) {
      await e.slot.show()
      if (!e.slot.shown) return null
      t.lastViewedMs = Date.now()
      this.ensureView(handleId, e, t)
      this.sync(e)
      return null
    }
    if (!e.slot.shown) return t.state.still
    // Whatever asked to hide the page is about to draw where it sits, so it goes first. A capture
    // straight after the detach still returns the last frame that was on screen.
    e.slot.hide()
    t.lastViewedMs = Date.now()
    this.sync(e)
    return this.refreshStill(handleId, t)
  }

  private async refreshStill(handleId: string, t: Tab): Promise<string | null> {
    if (t.stillTimer) clearTimeout(t.stillTimer)
    t.stillTimer = null
    const still = await stillOf(t.view?.webContents)
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
    if (!f) return this.missing(handleId, tab)
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

  // --- local network access ---

  /** Chromium checks synchronously, so the decision comes from the warm cache; a cold one denies without asking. */
  private localNet(wc: WebContents | null, isMainFrame: boolean, frameUrl: string): boolean {
    const hit = wc && this.liveTabs().find(([, , w]) => w === wc)
    if (!hit) return false
    const [handleId, t] = hit
    const { grant, ask } = localNetVerdict(wc.getURL(), isMainFrame, frameUrl, (site) => localNetCached(site) ?? undefined)
    // A cold cache can't tell a site never asked from one not read yet.
    if (ask && localNetCached(ask) !== null && !t.netAsked.has(ask)) {
      t.netAsked.add(ask)
      this.patch(handleId, t, { netAsk: ask })
    }
    return grant
  }

  /** Answers an open ask only, so nothing but the strip records a decision. Allow reloads the site's pages to re-check. */
  async localNetDecide(site: string, allow: boolean): Promise<void> {
    const asking = [...this.entries].flatMap(([h, e]) => e.tabs.filter((t) => t.state.netAsk === site).map((t) => [h, t] as const))
    if (!asking.length) return
    await decideLocalNet(site, allow)
    for (const [handleId, t] of asking) this.patch(handleId, t, { netAsk: null })
    if (allow) for (const [, , wc] of this.liveTabs()) if (siteKeyOf(wc.getURL()) === site) wc.reload()
  }

  async localNetForget(site: string): Promise<void> {
    await forgetLocalNet(site)
    for (const e of this.entries.values()) for (const t of e.tabs) t.netAsked.delete(site)
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

  /** For the test harness: suspends the tab unless it's viewed, parked, driven or holding pins. */
  suspendTab(handleId: string, tab: number): Promise<void> {
    const f = this.find(handleId, tab)
    return f ? this.suspend(handleId, f[0], f[1]) : Promise.resolve()
  }

  /** Null when Claude may act on a page at `url`: blank, opened by the user from the address bar, or approved. */
  async allowAgentAt(handleId: string, tab: number, url: string): Promise<string | null> {
    const f = this.find(handleId, tab)
    if (!f) return this.missing(handleId, tab)
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
    if (!f) return this.missing(handleId, tab)
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
    const fresh = !e.slot.holds(t.view)
    t.parks++
    this.sync(e)
    // The status strip that comes with driving shortens the page a frame or two later, and a tool
    // reading the page before then would aim at the old, taller viewport.
    if (strip && e.slot.shown && e.viewed === tab) await this.nextBounds(t)
    else if (fresh && e.slot.holds(t.view)) await sleep(FRAME_MS)
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
    for (const t of e.tabs) this.drop(handleId, e, t)
    e.slot.hide()
  }
}

export { WAITING }
