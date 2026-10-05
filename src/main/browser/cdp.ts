/**
 * Input and page reading for one browser view, over the Chrome DevTools Protocol. CDP input
 * works without OS focus, which sendInputEvent needs. Element refs live only in isolated
 * world 1001, never in the DOM, so a page can't forge or move them.
 */
import type { WebContents } from 'electron'
import { WORLD } from './cursor'

const WEBAUTHN_BINDING = '__cluiWebAuthn'

// Runs in the page's main world on every new document: an isolated world can't wrap the
// page's own navigator.credentials, and a security-key prompt is the only signal we need.
const WEBAUTHN_PROBE = `(() => {
  const c = navigator.credentials;
  if (!c) return;
  for (const k of ['get', 'create']) {
    const orig = c[k].bind(c);
    c[k] = function (o) {
      if (o && o.publicKey) { try { window.${WEBAUTHN_BINDING}('1') } catch {} }
      return orig(o);
    };
  }
})()`

// Password values and anything autofill wrote are never listed, or the list would hand the model the
// secret. A filled password can still surface elsewhere (a show-password toggle turns the field to
// text, a script copies it into the page), so any sighting of one is scrubbed from the list and
// reported, and the caller drops the screenshot.
const LIST_INTERACTIVE = `(() => {
  const secrets = [...(window.__cluiSecrets || [])]
  const scrub = (t) => secrets.reduce((acc, v) => acc.split(v).join('•••'), t)
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  const els = [...document.querySelectorAll('a,button,input,select,textarea,[role=button],[contenteditable=""],[contenteditable=true]')]
    .filter(vis)
    .slice(0, 150)
  window.__cluiRefs = new Map(els.map((e, i) => [i + 1, e]))
  const shown = secrets.length > 0 && (
    secrets.some((v) => (document.body?.innerText || '').includes(v)) ||
    [...document.querySelectorAll('input,textarea')].some((e) => e.type !== 'password' && vis(e) && secrets.some((v) => e.value.includes(v))))
  const list = els.map((e, i) => \`\${i + 1} \${e.getAttribute('role') || e.tagName.toLowerCase()} "\${scrub((e.getAttribute('aria-label') || e.innerText || (e.type === 'password' || window.__cluiFilled?.has(e) ? '' : e.value) || e.placeholder || '').trim()).slice(0, 80)}"\`).join('\\n')
  const keys = els.filter((e) => (e.tagName === 'BUTTON' || e.getAttribute('role') === 'button') && /^\\S$/u.test(e.innerText.trim())).length
  return { list, shown, keys }
})()`

export interface Box { x: number; y: number; password: boolean }

/** url is set for a failed resource load, whose location is the request rather than a script line. */
export interface LogEntry { n: number; level: 'error' | 'warn' | 'log' | 'nav'; text: string; where: string; url?: string }
export interface CookieInfo { name: string; domain: string; path: string; expires: number; size: number; httpOnly: boolean; secure: boolean; sameSite?: string }
export interface StoreInfo { name: string; count: number | null }

export interface NetEntry {
  n: number
  id: string
  method: string
  url: string
  type: string
  status: number | null
  size: number | null
  ms: number | null
  failed: string | null
  start: number
}

const MAX_LOG = 300
const MAX_NET = 500
const MAX_TEXT = 500

interface RemoteObject { type: string; value?: unknown; description?: string; unserializableValue?: string }
interface Located { url?: string; lineNumber?: number }

const shown = (o: RemoteObject): string =>
  o.type === 'string' ? String(o.value) : (o.unserializableValue ?? o.description ?? (o.value === undefined ? o.type : JSON.stringify(o.value)))
/** console's own formatting: %c takes a CSS argument that isn't shown, the other directives take a value. */
function formatted(args: RemoteObject[]): string {
  const [head, ...rest] = args
  if (head?.type !== 'string' || !/%[csdifoO]/.test(String(head.value))) return args.map(shown).join(' ')
  const text = String(head.value).replace(/%([csdifoO%])/g, (m, d: string) => {
    if (d === '%') return '%'
    const a = rest.shift()
    return !a ? m : d === 'c' ? '' : shown(a)
  })
  return [text, ...rest.map(shown)].join(' ')
}
const whereOf = (at: Located | undefined): string => {
  if (!at?.url) return ''
  const file = at.url.split(/[?#]/)[0].split('/').pop() || at.url
  return at.lineNumber === undefined ? file : `${file}:${at.lineNumber + 1}`
}

export interface KeyEvent {
  key: string
  code: string
  windowsVirtualKeyCode?: number
  text?: string
  modifiers?: number
}

const NAMED: Record<string, [vk: number, text?: string]> = {
  Enter: [13, '\r'],
  Tab: [9],
  Backspace: [8],
  Escape: [27],
  Delete: [46],
  ArrowLeft: [37],
  ArrowUp: [38],
  ArrowRight: [39],
  ArrowDown: [40],
  Home: [36],
  End: [35],
  PageUp: [33],
  PageDown: [34]
}
const SHIFT = 8


/** A DOM key name as CDP key-event fields, or null for a name this doesn't know. No nativeVirtualKeyCode: macOS reads
 *  that physical-key code before the page does and treats a synthetic key as a Globe shortcut (🌐E opened Emoji &
 *  Symbols, 🌐D Dictation), while the page only needs key, code and keyCode. */
export function keyEvent(name: string): KeyEvent | null {
  const named = NAMED[name]
  if (named) {
    const [vk, text] = named
    return { key: name, code: name, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) }
  }
  if ([...name].length !== 1) return null
  // Pages that still read keyCode or code need them on letters, digits and space too.
  if (/^[a-z]$/i.test(name)) {
    const vk = name.toUpperCase().charCodeAt(0)
    const upper = name !== name.toLowerCase()
    return { key: name, code: `Key${name.toUpperCase()}`, windowsVirtualKeyCode: vk, text: name, ...(upper ? { modifiers: SHIFT } : {}) }
  }
  if (/^\d$/.test(name)) {
    const vk = name.charCodeAt(0)
    return { key: name, code: `Digit${name}`, windowsVirtualKeyCode: vk, text: name }
  }
  if (name === ' ') return { key: name, code: 'Space', windowsVirtualKeyCode: 32, text: name }
  return { key: name, code: '', text: name }
}

export class Cdp {
  private readonly wc: WebContents
  /** Called around every input dispatch, so the manager can tell CDP input from the user's. */
  private readonly onAct: () => void
  /** Null until a tool asks, so a page Claude only browses runs with no extra domains: Runtime.enable has been a bot-detection
   *  signal, and capture costs memory on every page. */
  log: LogEntry[] | null = null
  net: Map<string, NetEntry> | null = null
  /** Passwords Clui filled here. Captured logs and URLs outlive the page that held them, so they're scrubbed against this. */
  readonly secrets = new Set<string>()
  private logSeq = 0
  private netSeq = 0

  constructor(wc: WebContents, onAct: () => void, onWebAuthn: () => void) {
    this.wc = wc
    this.onAct = onAct
    const dbg = wc.debugger
    dbg.on('message', (_e, method: string, params: { name?: string }) => {
      if (method === 'Runtime.bindingCalled' && params.name === WEBAUTHN_BINDING) onWebAuthn()
      else this.capture(method, params)
    })
    // No re-attach on 'detach': a closing page detaches before isDestroyed() turns true, and
    // re-attaching there loops and starves main. send() re-attaches on the next command instead.
    void this.attach()
  }

  private async attach(): Promise<void> {
    const dbg = this.wc.debugger
    try {
      if (!dbg.isAttached()) dbg.attach('1.3')
      await dbg.sendCommand('Runtime.addBinding', { name: WEBAUTHN_BINDING })
      await dbg.sendCommand('Page.enable')
      await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: WEBAUTHN_PROBE })
      // A detach (DevTools opening, a crashed page) drops every enabled domain.
      if (this.log) await this.enableConsole()
      if (this.net) await dbg.sendCommand('Network.enable')
    } catch {
      // A closing view or an attached DevTools refuses the session; tool calls report it.
    }
  }

  private async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.wc.isDestroyed()) throw new Error('The browser page is closed.')
    if (!this.wc.debugger.isAttached()) await this.attach()
    return this.wc.debugger.sendCommand(method, params)
  }

  private async input(method: string, params: Record<string, unknown>): Promise<void> {
    this.onAct()
    try {
      await this.send(method, params)
    } finally {
      this.onAct()
    }
  }

  hover(x: number, y: number): Promise<void> {
    return this.input('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  }

  async click(x: number, y: number): Promise<void> {
    await this.hover(x, y)
    await this.input('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await this.input('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }

  insertText(text: string): Promise<void> {
    return this.input('Input.insertText', { text })
  }

  async key(name: string): Promise<void> {
    const ev = keyEvent(name)
    if (!ev) throw new Error(`Unknown key ${name}.`)
    const { text, ...k } = ev
    // A key that types no character goes as rawKeyDown, the way Chromium sends a real one.
    await this.input('Input.dispatchKeyEvent', text ? { type: 'keyDown', text, ...k } : { type: 'rawKeyDown', ...k })
    await this.input('Input.dispatchKeyEvent', { type: 'keyUp', ...k })
  }

  wheel(x: number, y: number, dy: number): Promise<void> {
    return this.input('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy })
  }

  /** Starts console or network capture on this page; false means it was off until now. Chromium replays the console
   *  messages it kept on enable, so a fresh console has the page's history, while a fresh network log is empty. */
  async record(kind: 'console' | 'network'): Promise<boolean> {
    if (kind === 'console' ? this.log : this.net) return true
    // The buffer exists before the enable, so the messages Chromium replays on enable land in it.
    if (kind === 'console') this.log = []
    else this.net = new Map()
    try {
      if (kind === 'console') await this.enableConsole()
      else await this.send('Network.enable')
    } catch (err) {
      if (kind === 'console') this.log = null
      else this.net = null
      throw err
    }
    return false
  }

  private async enableConsole(): Promise<void> {
    await this.send('Log.enable')
    await this.send('Runtime.enable')
  }

  /** The cookies a request to url would carry, without their values: the value never leaves this method. */
  async cookies(url: string): Promise<CookieInfo[]> {
    const { cookies } = (await this.send('Network.getCookies', { urls: [url] })) as { cookies: (CookieInfo & { value: string })[] }
    return cookies.map(({ name, domain, path, expires, size, httpOnly, secure, sameSite }) => ({ name, domain, path, expires, size, httpOnly, secure, sameSite }))
  }

  /** Read through the debugger: opening a database from page script creates it if it's gone, a write to the site's storage. */
  async indexedDb(origin: string): Promise<{ name: string; stores: StoreInfo[] }[]> {
    await this.send('IndexedDB.enable')
    const { databaseNames } = (await this.send('IndexedDB.requestDatabaseNames', { securityOrigin: origin })) as { databaseNames: string[] }
    const out: { name: string; stores: StoreInfo[] }[] = []
    for (const databaseName of databaseNames.slice(0, 20)) {
      const { databaseWithObjectStores: db } = (await this.send('IndexedDB.requestDatabase', { securityOrigin: origin, databaseName })) as {
        databaseWithObjectStores: { objectStores: { name: string }[] }
      }
      const stores: StoreInfo[] = []
      for (const { name } of db.objectStores.slice(0, 30)) {
        const meta = (await this.send('IndexedDB.getMetadata', { securityOrigin: origin, databaseName, objectStoreName: name }).catch(() => null)) as { entriesCount: number } | null
        stores.push({ name, count: meta?.entriesCount ?? null })
      }
      out.push({ name: databaseName, stores })
    }
    return out
  }

  /** Local and session storage keys with their sizes, and values only when asked. The isolated world shares the page's storage. */
  storageItems(withValues: boolean): Promise<{ area: 'local' | 'session'; key: string; size: number; value?: string }[] | null> {
    return this.world(`(() => {
      try {
        const out = [];
        for (const [area, st] of [['local', localStorage], ['session', sessionStorage]]) {
          for (let i = 0; i < Math.min(st.length, 200); i++) {
            const key = st.key(i), v = st.getItem(key) ?? '';
            out.push({ area, key, size: v.length, ...(${withValues} ? { value: v.slice(0, 200) } : {}) });
          }
        }
        return out;
      } catch {
        return null;
      }
    })()`)
  }

  async responseBody(id: string): Promise<{ body: string; base64Encoded: boolean }> {
    return (await this.send('Network.getResponseBody', { requestId: id })) as { body: string; base64Encoded: boolean }
  }

  private pushLog(level: LogEntry['level'], text: string, where: string, url?: string): void {
    if (!this.log) return
    this.log.push({ n: ++this.logSeq, level, text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text, where, url })
    if (this.log.length > MAX_LOG) this.log.shift()
  }

  private capture(method: string, params: unknown): void {
    const p = params
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const { type, args, stackTrace } = p as { type: string; args: RemoteObject[]; stackTrace?: { callFrames: Located[] } }
        const level = type === 'error' || type === 'assert' ? 'error' : type === 'warning' ? 'warn' : 'log'
        return this.pushLog(level, formatted(args), whereOf(stackTrace?.callFrames[0]))
      }
      case 'Runtime.exceptionThrown': {
        const d = (p as { exceptionDetails: Located & { text: string; exception?: RemoteObject } }).exceptionDetails
        return this.pushLog('error', d.exception?.description ?? d.text, whereOf(d))
      }
      case 'Log.entryAdded': {
        const e = (p as { entry: Located & { level: string; text: string; source: string } }).entry
        const level = e.level === 'error' ? 'error' : e.level === 'warning' ? 'warn' : 'log'
        return e.source === 'network' ? this.pushLog(level, e.text, '', e.url) : this.pushLog(level, e.text, whereOf(e))
      }
      case 'Page.frameNavigated': {
        const f = (p as { frame: { parentId?: string; url: string } }).frame
        if (!f.parentId) this.pushLog('nav', f.url, '')
        return
      }
    }
    if (!this.net) return
    const id = (p as { requestId?: string }).requestId
    const e = id === undefined ? undefined : this.net.get(id)
    switch (method) {
      case 'Network.requestWillBeSent': {
        const r = p as { request: { method: string; url: string }; type?: string; timestamp: number }
        // A redirect reuses the request id; the entry follows it to the final URL.
        if (e) e.url = r.request.url
        else if (id !== undefined) {
          this.net.set(id, { n: ++this.netSeq, id, method: r.request.method, url: r.request.url, type: r.type ?? '', status: null, size: null, ms: null, failed: null, start: r.timestamp })
          if (this.net.size > MAX_NET) this.net.delete(this.net.keys().next().value as string)
        }
        return
      }
      case 'Network.responseReceived': {
        if (!e) return
        const r = p as { type?: string; response: { status: number } }
        e.status = r.response.status
        if (r.type) e.type = r.type
        return
      }
      case 'Network.loadingFinished': {
        if (!e) return
        const r = p as { encodedDataLength: number; timestamp: number }
        e.size = r.encodedDataLength
        e.ms = Math.round((r.timestamp - e.start) * 1000)
        return
      }
      case 'Network.loadingFailed': {
        if (!e) return
        const r = p as { errorText: string; canceled?: boolean; blockedReason?: string; timestamp: number }
        e.failed = r.canceled ? 'canceled' : (r.blockedReason ?? r.errorText)
        e.ms = Math.round((r.timestamp - e.start) * 1000)
      }
    }
  }

  private world<T>(code: string): Promise<T> {
    return this.wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }])
  }

  /** `shown`: a password autofill wrote is visible somewhere on the page. */
  /** keys counts single-character buttons, the shape of an on-screen keyboard or keypad. */
  listInteractive(): Promise<{ list: string; shown: boolean; keys: number }> {
    return this.world<{ list: string; shown: boolean; keys: number }>(LIST_INTERACTIVE)
  }

  /** Whether the page itself listens for key presses, as games and keypads do. Page script can't read listeners, so this asks the debugger. */
  async takesKeys(): Promise<boolean> {
    try {
      for (const expression of ['window', 'document', 'document.body']) {
        const { result } = (await this.send('Runtime.evaluate', { expression, objectGroup: 'clui-keys' })) as { result: { objectId?: string } }
        if (!result.objectId) continue
        const { listeners } = (await this.send('DOMDebugger.getEventListeners', { objectId: result.objectId })) as { listeners: { type: string }[] }
        if (listeners.some((l) => l.type === 'keydown' || l.type === 'keypress')) return true
      }
      return false
    } catch {
      return false
    } finally {
      void this.send('Runtime.releaseObjectGroup', { objectGroup: 'clui-keys' }).catch(() => {})
    }
  }

  boxOf(ref: number): Promise<Box | null> {
    return this.world<Box | null>(
      `(() => { const e = window.__cluiRefs?.get(${Number(ref)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, password: e instanceof HTMLInputElement && e.type === 'password' } })()`
    )
  }

  /** Focus inside a frame this world can't see into counts as a password field, since it might be one. */
  focusedIsPassword(): Promise<boolean> {
    return this.world<boolean>(`(() => {
      let e = document.activeElement
      while (e && (e.tagName === 'IFRAME' || e.tagName === 'FRAME')) {
        if (!e.contentDocument) return true
        e = e.contentDocument.activeElement
      }
      return !!e && e.tagName === 'INPUT' && e.type === 'password'
    })()`)
  }

  /** Raw protocol access for a feature that runs its own domains, as annotate does with DOM and Overlay. */
  command<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.send(method, params) as Promise<T>
  }
}
