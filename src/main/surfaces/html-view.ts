/**
 * HTML views: a pane tab's Preview of an .html file, each a sandboxed WebContentsView on the non-persistent
 * 'clui-artifact' partition with no preload, loading from its own capability host. Keyed by session and
 * surface tab. A page is Claude's artifact only when this session's ledger has the Write that created it;
 * only an artifact gets the network settings, and one whose bytes are no longer Claude's waits for a run.
 */
import { session, WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { PaneBounds } from '../../shared/browser'
import type { Refusal, TextRead } from '../../shared/files'
import { isHtml, type HtmlBlocked, type HtmlOpenResult, type HtmlPolicy, type HtmlViewEvent } from '../../shared/html-view'
import { IpcChannels } from '../../shared/ipc'
import { readText, revisionOf, type createFileAccess, type FileAccess } from './files'
import { NativeViewSlot, stillOf } from './native-slot'
import { createCaps, SCHEME } from './protocol'

const PARTITION = 'clui-artifact'
/** Pages that may load nothing from the network. CSP doesn't cover WebRTC or DNS prefetch, so this partition's
 *  proxy is a closed port: nothing leaves, while the scheme handler still serves the page's own files. */
const OFFLINE = 'clui-page'
const offline = (p: HtmlPolicy): boolean => !p.artifact || (!p.remote && !p.data)
const GESTURE_MS = 1000
const SETTLE_MS = 300
const BLOCKED_MS = 500
const STILL_MS = 500
const READ: FileAccess = { consumer: 'web', operation: 'read-file' }
const USER_INPUT = new Set(['mouseDown', 'mouseUp', 'rawKeyDown', 'keyDown', 'mouseWheel'])

/**
 * Electron gives navigations no gesture flag, but real input reaches `input-event` and `before-input-event`
 * a few ms before the link activation it causes, and script-made navigation brings none. So a navigation
 * counts as the user's only within a second of a mouseUp or Enter, and one gesture allows one navigation.
 */
export function gesture(now: () => number = Date.now): { mark(): void; take(): boolean } {
  let at = -Infinity
  return {
    mark: () => void (at = now()),
    take: () => {
      const ok = now() - at <= GESTURE_MS
      at = -Infinity
      return ok
    }
  }
}

/** Claude's record of a path from its ledger segments: an artifact when an edit created it, and its last write. */
export function claudeRecord(path: string, segs: readonly { created: boolean; after?: string }[] | null): { artifact: boolean; after: string | null } {
  return { artifact: isHtml(path) && !!segs?.[0]?.created, after: segs?.at(-1)?.after ?? null }
}

/** The file holds exactly Claude's last write. A partial or undecodable read can't show that, so it never does. */
export const isClaudes = (after: string | null, read: TextRead | Refusal): boolean =>
  after !== null && read.ok && !read.truncated && !read.binary && !read.unsupportedEncoding && read.text === after

/** Opens per key where a newer one supersedes any still in flight. The check says, once, whether this one still leads. */
export function superseding(): (key: string) => () => boolean {
  const at = new Map<string, number>()
  let n = 0
  return (key) => {
    const mine = ++n
    at.set(key, mine)
    return () => {
      if (at.get(key) !== mine) return false
      at.delete(key)
      return true
    }
  }
}

/** The served paths whose identity moved off `seen`, the identities when the paths were last served or settled. */
export const movedOf = (seen: ReadonlyMap<string, string>, now: ReadonlyMap<string, string>): string[] => [...seen].flatMap(([p, id]) => (now.get(p) === id ? [] : [p]))

/** A file's identity, '' while it's gone, so a deleted asset counts as changed and one put back does too. */
const identity = (p: string): Promise<string> => stat(p, { bigint: true }).then(revisionOf, () => '')

type Refused = { group: 'remote' | 'data'; host: string | null } | { group: 'eval' }

/**
 * A Content-Security-Policy refusal Chromium logged to the page's console. A refused load never reaches the
 * network, so the console is the only place it shows. An artifact's `remote` counts only what its Web resources
 * setting governs (scripts, styles, fonts); any other page counts every refused load.
 */
export function refusalOf(message: string, capHost: string, artifact: boolean): Refused | null {
  // The page's own "Uncaught EvalError: …" repeats the same text, and eval is a flag, so it counts once.
  if (message.includes('Evaluating a string as JavaScript violates')) return { group: 'eval' }
  const m = /^(?:Loading the [a-z ]+|Connecting to) '([^']*)' violates the following Content Security Policy directive: "([a-z-]+)/.exec(message)
  if (!m) return null
  const [, url, directive] = m
  const group = directive === 'connect-src' ? 'data' : !artifact || /^(script|style|font)-src/.test(directive) ? 'remote' : null
  if (!group) return null
  let host: string | null = null
  try {
    const u = new URL(url)
    host = u.protocol === `${SCHEME}:` ? (u.hostname === capHost ? 'self' : null) : u.origin === 'null' ? null : u.origin
  } catch {
    /* counted without a host */
  }
  return { group, host }
}

type Files = ReturnType<typeof createFileAccess>

export interface HtmlDeps {
  window: () => BrowserWindow | null
  files: Files
  /** The session ledger's segments for a canonical path, null when Claude never changed it. */
  segments: (handleId: string, path: string) => Promise<readonly { created: boolean; after?: string }[] | null>
  settings: () => { remote: boolean; data: boolean }
  /** The session is still running; its disposal may land while an open awaits. */
  alive: (handleId: string) => boolean
}

interface View {
  id: string
  handleId: string
  tabId: string
  /** Canonical. */
  path: string
  root: string
  policy: HtmlPolicy
  host: string
  view: WebContentsView
  slot: NativeViewSlot
  /** Asked to run at least once; a changed-since artifact isn't until the user runs it. */
  loaded: boolean
  /** Kept in the window off screen while it loads hidden, so the page lays out at the pane's size. */
  parked: boolean
  generation: number
  finished: boolean
  blocked: HtmlBlocked
  gesture: ReturnType<typeof gesture>
  still: string | null
  watches: string[]
  /** Shared with the cap: every path it served (and the page from the start), at its identity when served or last settled. */
  served: Map<string, string>
  /** Changed paths last settled as not all Claude's; the ledger can record Claude's edit after the watcher fires. */
  unattributed: string[]
  /** A recreated view stays parked until its first dom-ready, so the pane keeps the still instead of a blank page. */
  held: boolean
  timers: { blocked?: ReturnType<typeof setTimeout>; still?: ReturnType<typeof setTimeout>; settle?: ReturnType<typeof setTimeout> }
}

const refuse = (reason: Refusal['reason']): Refusal => ({ ok: false, reason })
const noBlocks = (): HtmlBlocked => ({ remote: 0, data: 0, eval: false, hosts: [] })
const live = (wc: WebContents): boolean => !wc.isDestroyed()

export class HtmlViews {
  private readonly views = new Map<string, View>()
  private readonly deps: HtmlDeps
  private readonly caps: ReturnType<typeof createCaps>
  /** Settles once the offline partition's proxy is in place; no offline page loads before it. */
  private readonly sealed: Promise<void>
  private readonly opening = superseding()

  constructor(deps: HtmlDeps) {
    this.deps = deps
    this.caps = createCaps((h, p) => deps.files.resolveAllowed(h, p, READ))
    for (const name of [PARTITION, OFFLINE]) {
      const ses = session.fromPartition(name)
      ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
      ses.setPermissionCheckHandler(() => false)
      ses.on('will-download', (e) => e.preventDefault())
      ses.protocol.handle(SCHEME, (req) => this.caps.serve(req))
    }
    this.sealed = session.fromPartition(OFFLINE).setProxy({ proxyRules: 'http://127.0.0.1:9', proxyBypassRules: '<-loopback>' })
  }

  private emit(e: HtmlViewEvent): void {
    try {
      const win = this.deps.window()
      if (win && !win.isDestroyed() && live(win.webContents)) win.webContents.send(IpcChannels.htmlEvent, e)
    } catch {
      /* window torn down mid-send */
    }
  }

  private mine(v: View, wc: WebContents): boolean {
    return this.views.get(v.id) === v && v.view.webContents === wc
  }

  async open(handleId: string, tabId: string, path: string): Promise<HtmlOpenResult> {
    if (typeof tabId !== 'string' || !tabId || tabId.length > 1000) return refuse('invalid')
    const leads = this.opening(`${handleId}\0${tabId}`)
    const r = await this.deps.files.resolveAllowed(handleId, path, READ)
    if (!r.ok) return r
    if (!isHtml(r.path)) return refuse('wrong-type')
    const { artifact, after } = claudeRecord(r.path, await this.deps.segments(handleId, r.path))
    const read = artifact ? await readText(r) : null
    if (read && !read.ok) return read
    await this.sealed
    const win = this.deps.window()
    // A newer open of this tab, StrictMode's second mount among them, owns it now.
    if (!leads() || !win || win.isDestroyed() || !this.deps.alive(handleId)) return refuse('unavailable')
    for (const v of [...this.views.values()]) if (v.handleId === handleId && v.tabId === tabId) this.close(v.id)
    const policy: HtmlPolicy = artifact ? { artifact, ...this.deps.settings() } : { artifact, remote: false, data: false }
    const served = new Map<string, string>()
    const root = dirname(r.path)
    const id = randomUUID()
    const v: View = {
      id,
      handleId,
      tabId,
      path: r.path,
      root,
      policy,
      host: this.caps.issue({ handleId, root, policy, served }),
      view: this.create(policy),
      slot: new NativeViewSlot(this.deps.window, () => this.setVisible(id, false)),
      loaded: false,
      parked: false,
      generation: 0,
      finished: false,
      blocked: noBlocks(),
      gesture: gesture(),
      still: null,
      watches: [],
      served,
      unattributed: [],
      held: false,
      timers: {}
    }
    this.views.set(id, v)
    this.wire(v, v.view.webContents)
    void this.watch(v)
    const changedSince = !!read && !isClaudes(after, read)
    if (!changedSince) this.load(v)
    return { ok: true, viewId: id, policy, changedSince }
  }

  private create(policy: HtmlPolicy): WebContentsView {
    const view = new WebContentsView({
      webPreferences: { partition: offline(policy) ? OFFLINE : PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false }
    })
    // WebRTC sends UDP around both CSP and the proxy unless told to use the proxy only.
    view.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    view.setBorderRadius(12)
    // A page without a background of its own is drawn on white, as in any browser.
    view.setBackgroundColor('#ffffff')
    return view
  }

  private wire(v: View, wc: WebContents): void {
    const link = (url: string): void => {
      if (this.mine(v, wc) && v.gesture.take() && /^https?:\/\//i.test(url)) this.emit({ type: 'link', viewId: v.id, url })
    }
    wc.setWindowOpenHandler((d) => {
      link(d.url)
      return { action: 'deny' }
    })
    wc.on('will-navigate', (e) => {
      e.preventDefault()
      link(e.url)
    })
    wc.on('will-redirect', (e) => e.preventDefault())
    wc.on('input-event', (_e, input) => {
      if (!USER_INPUT.has(input.type) || !this.mine(v, wc)) return
      if (input.type === 'mouseUp') v.gesture.mark()
      this.stillSoon(v)
    })
    wc.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown' || !this.mine(v, wc)) return
      if (input.key === 'Enter') v.gesture.mark()
      // A focused page swallows F6, so the region cycle is handed back to the renderer's own.
      if (input.key !== 'F6' || input.meta || input.control || input.alt) return
      e.preventDefault()
      const win = this.deps.window()
      if (!win || win.isDestroyed()) return
      win.webContents.focus()
      win.webContents.send(IpcChannels.menuAction, input.shift ? 'region-prev' : 'region-next', true)
    })
    wc.on('console-message', (e) => this.mine(v, wc) && this.refused(v, e.message))
    wc.on('did-start-navigation', (e) => {
      if (!e.isMainFrame || e.isSameDocument || !this.mine(v, wc)) return
      v.generation++
      v.finished = false
      v.blocked = noBlocks()
      clearTimeout(v.timers.blocked)
    })
    wc.on('dom-ready', () => {
      if (!this.mine(v, wc)) return
      this.emit({ type: 'dom-ready', viewId: v.id, generation: v.generation })
      if (!v.held) return
      v.held = false
      this.sync(v)
    })
    wc.on('did-finish-load', () => {
      if (!this.mine(v, wc)) return
      v.finished = true
      if (v.blocked.remote || v.blocked.data || v.blocked.eval) this.blockedSoon(v)
    })
    wc.on('did-stop-loading', () => this.mine(v, wc) && this.stillSoon(v))
    // -3 is ERR_ABORTED: a newer load replacing this one.
    wc.on('did-fail-load', (_e, code, name, _url, isMainFrame) => {
      if (isMainFrame && code !== -3 && this.mine(v, wc)) this.emit({ type: 'load-failed', viewId: v.id, code, name })
    })
    wc.on('render-process-gone', (_e, d) => this.mine(v, wc) && this.emit({ type: 'crashed', viewId: v.id, reason: d.reason }))
    wc.on('unresponsive', () => this.mine(v, wc) && this.emit({ type: 'unresponsive', viewId: v.id }))
    wc.on('responsive', () => this.mine(v, wc) && this.emit({ type: 'responsive', viewId: v.id }))
  }

  private refused(v: View, message: string): void {
    const r = refusalOf(message, v.host, v.policy.artifact)
    if (!r) return
    const b = v.blocked
    if (r.group === 'eval') b.eval = true
    else {
      b[r.group]++
      if (r.host && b.hosts.length < 50 && !b.hosts.includes(r.host)) b.hosts.push(r.host)
    }
    if (v.finished) this.blockedSoon(v)
  }

  private blockedSoon(v: View): void {
    clearTimeout(v.timers.blocked)
    v.timers.blocked = setTimeout(() => {
      if (this.views.get(v.id) === v) this.emit({ type: 'blocked', viewId: v.id, generation: v.generation, ...v.blocked, hosts: [...v.blocked.hosts] })
    }, BLOCKED_MS)
  }

  private load(v: View): void {
    const wc = v.view.webContents
    if (!live(wc)) return
    v.parked = true
    v.unattributed = []
    this.sync(v)
    if (v.loaded && wc.getURL().startsWith(`${SCHEME}://${v.host}/`)) wc.reload()
    else void wc.loadURL(`${SCHEME}://${v.host}/${encodeURIComponent(basename(v.path))}`).catch(() => {})
    v.loaded = true
  }

  /** Runs the page: the first run of a changed-since artifact, or a reload of the current bytes. */
  reload(viewId: string): void {
    const v = this.views.get(viewId)
    if (v) this.load(v)
  }

  // --- placement, stills ---

  private sync(v: View): void {
    const pane = v.slot.pane()
    v.slot.place(v.view, v.slot.shown && pane && !v.held ? pane : v.parked || v.held ? v.slot.park() : null)
  }

  relayout(): void {
    for (const v of this.views.values()) this.sync(v)
  }

  setBounds(viewId: string, b: PaneBounds | null): void {
    const v = this.views.get(viewId)
    if (!v) return
    v.slot.bounds = b
    this.sync(v)
    if (b) this.stillSoon(v)
  }

  async setVisible(viewId: string, visible: boolean): Promise<string | null> {
    const v = this.views.get(viewId)
    if (!v) return null
    if (visible) {
      await v.slot.show()
      if (this.views.get(viewId) === v && v.slot.shown) this.sync(v)
      return null
    }
    if (!v.slot.shown) return v.still
    const hadFocus = this.focused(v)
    // Whatever hides the page draws where it sits, so it goes first; a capture right after still has the last frame.
    v.slot.hide()
    this.sync(v)
    if (hadFocus) this.deps.window()?.webContents.focus()
    return this.refreshStill(v)
  }

  owns(wc: WebContents): boolean {
    return [...this.views.values()].some((v) => v.view.webContents === wc)
  }

  focus(viewId: string): void {
    const v = this.views.get(viewId)
    if (v?.slot.shown && live(v.view.webContents)) v.view.webContents.focus()
  }

  private focused(v: View): boolean {
    return live(v.view.webContents) && v.view.webContents.isFocused()
  }

  private stillSoon(v: View): void {
    clearTimeout(v.timers.still)
    v.timers.still = setTimeout(() => void this.refreshStill(v), STILL_MS)
  }

  private async refreshStill(v: View): Promise<string | null> {
    clearTimeout(v.timers.still)
    const view = v.view
    const still = await stillOf(view.webContents)
    if (this.views.get(v.id) !== v || v.view !== view) return v.still
    if (still) {
      v.still = still
      this.emit({ type: 'still', viewId: v.id, still })
    }
    if (v.parked) {
      v.parked = false
      this.sync(v)
    }
    return v.still
  }

  // --- changes ---

  private async watch(v: View): Promise<void> {
    const { files } = this.deps
    for (const [path, operation] of [
      [v.path, 'watch-file'],
      [v.root, 'watch-directory']
    ] as const) {
      const r = await files.resolveAllowed(v.handleId, path, { consumer: 'web', operation })
      const w = r.ok ? await files.watch(r, () => this.settleSoon(v)) : r
      if (!w.ok) continue
      if (this.views.get(v.id) !== v) return files.unwatch(w.id)
      v.watches.push(w.id)
    }
    // The page counts before it's served, so Claude's edit to a page waiting for a run still lands.
    const page = await identity(v.path)
    if (!v.served.has(v.path)) v.served.set(v.path, page)
  }

  private settleSoon(v: View): void {
    clearTimeout(v.timers.settle)
    v.timers.settle = setTimeout(() => void this.settle(v), SETTLE_MS)
  }

  // ponytail: the folder watch is shallow, so a served file in a subfolder changes nothing until something beside the page does; watch served subfolders if assets live there
  private async settle(v: View): Promise<void> {
    if (this.views.get(v.id) !== v) return
    const page = await this.deps.files.resolveAllowed(v.handleId, v.path, READ)
    if (this.views.get(v.id) !== v) return
    if (!page.ok && page.reason === 'missing') {
      this.close(v.id)
      return this.emit({ type: 'missing', viewId: v.id })
    }
    const seen = new Map(v.served)
    const now = new Map(await Promise.all([...seen.keys()].map(async (p) => [p, await identity(p)] as const)))
    if (this.views.get(v.id) !== v) return
    const moved = movedOf(seen, now)
    // A reload may have served a newer identity meanwhile; that one stays.
    for (const p of moved) if (v.served.get(p) === seen.get(p)) v.served.set(p, now.get(p) ?? '')
    if (!moved.length) return
    const paths = [...new Set([...v.unattributed, ...moved])]
    const byClaude = await this.allClaudes(v, paths)
    if (this.views.get(v.id) !== v) return
    v.unattributed = byClaude ? [] : paths
    this.emit({ type: 'changed', viewId: v.id, byClaude })
  }

  /** The ledger published for `handleId`: a change settled as outside may now be Claude's recorded edit. */
  async attribute(handleId: string): Promise<void> {
    for (const v of [...this.views.values()]) {
      const paths = v.unattributed
      if (v.handleId !== handleId || !paths.length || !(await this.allClaudes(v, paths))) continue
      if (this.views.get(v.id) !== v || v.unattributed !== paths) continue
      v.unattributed = []
      this.emit({ type: 'changed', viewId: v.id, byClaude: true })
    }
  }

  private async allClaudes(v: View, paths: string[]): Promise<boolean> {
    const checks = await Promise.all(
      paths.map(async (path) => {
        const { after } = claudeRecord(path, await this.deps.segments(v.handleId, path))
        if (after === null) return false
        const r = await this.deps.files.resolveAllowed(v.handleId, path, READ)
        return r.ok && isClaudes(after, await readText(r))
      })
    )
    return checks.every(Boolean)
  }

  // --- policy, teardown ---

  /** Artifact views whose settings changed get a new view and cap; the old context can't keep running. */
  repolicy(): void {
    const { remote, data } = this.deps.settings()
    for (const v of this.views.values()) {
      if (!v.policy.artifact || (v.policy.remote === remote && v.policy.data === data)) continue
      const hadFocus = this.focused(v)
      this.caps.revoke(v.host)
      this.drop(v)
      v.policy = { artifact: true, remote, data }
      v.host = this.caps.issue({ handleId: v.handleId, root: v.root, policy: v.policy, served: v.served })
      v.view = this.create(v.policy)
      v.blocked = noBlocks()
      this.wire(v, v.view.webContents)
      const ran = v.loaded
      v.loaded = false
      v.held = ran
      if (ran) this.load(v)
      this.sync(v)
      if (hadFocus && v.slot.shown) v.view.webContents.focus()
      this.emit({ type: 'recreated', viewId: v.id, policy: v.policy })
    }
  }

  /** The page and its timers; the cap, slot, watches and a pending settle are the caller's. */
  private drop(v: View): void {
    clearTimeout(v.timers.blocked)
    clearTimeout(v.timers.still)
    v.parked = false
    v.slot.place(v.view, null)
    if (live(v.view.webContents)) v.view.webContents.close()
  }

  close(viewId: string): void {
    const v = this.views.get(viewId)
    if (!v) return
    this.views.delete(viewId)
    const hadFocus = this.focused(v)
    this.caps.revoke(v.host)
    for (const id of v.watches) this.deps.files.unwatch(id)
    clearTimeout(v.timers.settle)
    v.slot.hide()
    this.drop(v)
    if (hadFocus) this.deps.window()?.webContents.focus()
  }

  dispose(handleId: string): void {
    for (const v of [...this.views.values()]) if (v.handleId === handleId) this.close(v.id)
  }

  disposeAll(): void {
    for (const id of [...this.views.keys()]) this.close(id)
  }
}
