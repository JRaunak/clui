/**
 * Input and page reading for one browser view, over the Chrome DevTools Protocol. CDP input
 * works without OS focus, which sendInputEvent needs. Element refs live only in isolated
 * world 1001, never in the DOM, so a page can't forge or move them.
 */
import { randomBytes } from 'node:crypto'
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

/**
 * The world's ref table as a page-side function source: element numbers for one document, reused while an
 * element lives. A table that isn't for the document main last saw (`cur`) is thrown away and restarted
 * under `next`, so a number from an earlier document can never name an element in this one.
 */
export const PAGE_REFS = `(w, cur, next) => {
  let s = w.__cluiRefs;
  if (!s || s.doc !== cur) s = w.__cluiRefs = { doc: next, ids: new WeakMap(), els: new Map(), n: 0 };
  for (const [n, r] of s.els) if (!r.deref()) s.els.delete(n);
  const id = (e) => {
    let n = s.ids.get(e);
    if (n === undefined) { n = ++s.n; s.ids.set(e, n); s.els.set(n, new WeakRef(e)); }
    return n;
  };
  return { doc: s.doc, id, table: s };
}`

/** Page-side: an element that takes up space on the page. */
export const PAGE_VIS = `(e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 }`

/** Page-side: a password autofill wrote is visible outside its field (a show-password toggle turned the field to text,
 *  a script copied it into the page). A screenshot would hand the model the secret, so the caller refuses one. */
const PAGE_SHOWN = `(() => {
  const secrets = [...(window.__cluiSecrets || [])]
  const vis = ${PAGE_VIS}
  return secrets.length > 0 && (
    secrets.some((v) => (document.body?.innerText || '').includes(v)) ||
    [...document.querySelectorAll('input,textarea')].some((e) => e.type !== 'password' && vis(e) && secrets.some((v) => e.value.includes(v))))
})()`

/** Page-side: counts the table's layout changes, a resize of the document's box, so a screenshot taken before one is refused. */
const PAGE_EPOCH = `(s) => {
  if (s.ro) return s.epoch
  let last = ''
  s.epoch = 0
  s.ro = new ResizeObserver(([e]) => {
    const size = e.contentRect.width + 'x' + e.contentRect.height
    if (last && size !== last) s.epoch++
    last = size
  })
  s.ro.observe(document.documentElement)
  return s.epoch
}`

const PAGE_VIEW = `{ vw: innerWidth, vh: innerHeight, sx: scrollX, sy: scrollY }`

/** The page's metrics a screenshot is taken against, and the document it belongs to. */
export interface View { doc: string; vw: number; vh: number; sx: number; sy: number; epoch: number }

/**
 * The semantic snapshot, walked in reading order: section and heading lines, the text in the viewport, and the
 * controls in it with ref numbers. Text inside a control or its label is the control's name, so it isn't repeated.
 * Hidden subtrees are skipped. A field's value is shown unless it's a password or autofill wrote it; filled secrets
 * that surface anyway are scrubbed by the caller. `scope` walks one element's subtree, whole; `all` drops the viewport filter.
 */
// ponytail: open shadow roots aren't walked; walk e.shadowRoot and slots once a real site's controls go missing
const observe = (tab: number, cur: string | null, next: string, scope: number | null, all: boolean, cap: number): string => `(() => {
  const refs = (${PAGE_REFS})(window, ${JSON.stringify(cur)}, ${JSON.stringify(next)})
  if (${scope !== null} && refs.doc !== ${JSON.stringify(cur)}) return { why: 'page' }
  const epoch = (${PAGE_EPOCH})(refs.table)
  const root = ${scope === null ? 'document.body || document.documentElement' : `refs.table.els.get(${Number(scope)})?.deref()`}
  if (!root || !root.isConnected) return { why: 'gone' }
  const ref = (e) => 't${Number(tab)}:d' + refs.doc + ':e' + refs.id(e)
  const whole = ${all || scope !== null}, vw = innerWidth, vh = innerHeight
  const CONTROL = 'a,button,input:not([type=hidden]),select,textarea,summary,[contenteditable=""],[contenteditable=true],' +
    ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton'].map((r) => '[role=' + r + ']').join(',')
  // Forms, dialogs and tables are worth a ref to scope to; other landmarks only when they're labelled.
  const SECTION = { form: 'form', dialog: 'dialog', table: 'table' }
  const LANDMARK = { nav: 'nav', main: 'main', aside: 'aside', header: 'header', footer: 'footer', search: 'search', section: 'section' }
  const SECTION_ROLES = new Set(['form', 'dialog', 'alertdialog', 'tabpanel', 'menu', 'listbox', 'tablist', 'table', 'grid'])
  const LANDMARK_ROLES = new Set(['navigation', 'main', 'banner', 'contentinfo', 'complementary', 'search', 'region'])
  const BLOCK = new Set(['p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'td', 'th', 'section', 'article', 'header', 'footer', 'nav', 'main', 'aside', 'ul', 'ol', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'figure', 'figcaption', 'caption', 'table', 'form', 'fieldset', 'legend', 'details', 'dialog', 'br', 'hr'])
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'frame', 'object', 'embed', 'head', 'option', 'datalist'])
  const INPUT = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button', range: 'slider', search: 'searchbox', number: 'spinbutton', password: 'password', file: 'file', color: 'color' }
  const TAG = { a: 'link', select: 'combobox', textarea: 'textbox', summary: 'button' }
  const squash = (t) => (t || '').replace(/\\s+/g, ' ').trim()
  const clip = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t)
  const textOf = (e) => squash(e.innerText ?? e.textContent)
  const byIds = (ids) => squash((ids || '').split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' '))
  const field = (e) => e.localName === 'textarea' || (e.localName === 'input' && !['checkbox', 'radio', 'button', 'submit', 'reset', 'image', 'range', 'file', 'color'].includes(e.type)) || e.isContentEditable
  const nameOf = (e) => squash(e.getAttribute('aria-label')) || byIds(e.getAttribute('aria-labelledby')) ||
    (e.labels?.length ? squash([...e.labels].map((l) => l.innerText).join(' ')) : '') ||
    (field(e) || e.localName === 'select' ? '' : textOf(e)) || e.placeholder || e.title || e.alt || squash(e.value && e.type !== 'password' && !field(e) ? e.value : '')
  const roleOf = (e) => e.getAttribute('role') || (e.localName === 'input' ? INPUT[e.type] || 'textbox' : TAG[e.localName] || e.localName)
  const describe = (e) => {
    const s = [roleOf(e) + ' "' + clip(nameOf(e), 80) + '"']
    if (e.localName === 'select') s.push('= "' + clip(squash(e.selectedOptions?.[0]?.text), 60) + '"')
    else if (field(e) && e.type !== 'password' && !window.__cluiFilled?.has(e)) { const v = e.isContentEditable ? textOf(e) : e.value; if (v) s.push('= "' + clip(squash(v), 80) + '"') }
    if (e.checked || e.getAttribute('aria-checked') === 'true') s.push('checked')
    if (e.disabled || e.getAttribute('aria-disabled') === 'true') s.push('disabled')
    const x = e.getAttribute('aria-expanded'); if (x) s.push(x === 'true' ? 'expanded' : 'collapsed')
    if (e.getAttribute('aria-selected') === 'true') s.push('selected')
    if (e.getAttribute('aria-pressed') === 'true') s.push('pressed')
    return s.join(' ')
  }
  const inView = (r) => r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw
  const lines = [], below = [], seen = { above: 0, below: 0, nodes: 0 }
  let size = 0, cut = false, keys = 0, buf = '', prefix = '', row = null, quiet = 0
  const CUT = {}
  const push = (t) => {
    size += t.length + 1
    if (size > ${cap}) { cut = true; throw CUT }
    lines.push(t)
  }
  const flush = () => {
    const t = squash(buf)
    buf = ''
    if (/[^\\s|]/.test(t)) push(clip(prefix + t, 2000))
    prefix = ''
  }
  const text = (t) => {
    if (quiet || !t.data.trim()) { buf += ' '; return }
    if (!whole) {
      const p = t.parentElement, r = p.getBoundingClientRect()
      let shown = inView(r)
      if (shown && r.height > vh) { const g = document.createRange(); g.selectNodeContents(t); shown = inView(g.getBoundingClientRect()) }
      if (!shown) return
    }
    buf += t.data
  }
  const control = (e) => {
    const r = e.getBoundingClientRect()
    if (!r.width || !r.height) return
    if ((e.localName === 'button' || e.getAttribute('role') === 'button') && /^\\S$/u.test(textOf(e))) keys++
    if (!whole && !inView(r)) { if (r.bottom <= 0) seen.above++; else seen.below++; return }
    // A link inside running text, and any control in a table row, stays in its line.
    const link = roleOf(e) === 'link'
    if (row || (link && (/\\S/.test(buf) || [...e.parentElement.childNodes].some((c) => c.nodeType === 3 && c.data.trim())))) {
      buf += ' [' + (link ? clip(nameOf(e), 80) : describe(e)) + '](' + ref(e) + ') '
      return
    }
    flush()
    push(ref(e) + ' ' + describe(e))
  }
  const visit = (e) => {
    if (++seen.nodes > 50000) { cut = true; throw CUT }
    const tag = e.localName
    if (SKIP.has(tag) || e.getAttribute('aria-hidden') === 'true' || e.hidden || !e.checkVisibility({ visibilityProperty: true })) return
    if (e.matches(CONTROL)) return control(e)
    const r = e.getBoundingClientRect(), shown = whole || inView(r)
    if (tag === 'img' || tag === 'canvas' || tag === 'video' || e.getAttribute('role') === 'img') {
      if (shown && r.width >= 64 && r.height >= 64) { flush(); push('[' + (tag === 'canvas' || tag === 'video' ? tag : 'image') + (e.alt || e.getAttribute('aria-label') ? ' "' + clip(squash(e.alt || e.getAttribute('aria-label')), 80) + '"' : '') + ' ' + Math.round(r.width) + '×' + Math.round(r.height) + ']') }
      return
    }
    const level = /^h([1-6])$/.exec(tag)?.[1] || (e.getAttribute('role') === 'heading' ? e.getAttribute('aria-level') || '2' : '')
    if (level && !shown && +level <= 3 && r.top >= vh) below.push(clip(textOf(e), 60))
    const role = e.getAttribute('role'), labelled = e.hasAttribute('aria-label') || e.hasAttribute('aria-labelledby')
    const section = SECTION[tag] || ((SECTION_ROLES.has(role) || (labelled && LANDMARK_ROLES.has(role))) && role) || (labelled && LANDMARK[tag])
    if (section && shown && !row) {
      flush()
      const label = squash(e.getAttribute('aria-label')) || byIds(e.getAttribute('aria-labelledby')) || (tag === 'table' ? squash(e.caption?.textContent) : '') || (tag === 'dialog' || role === 'dialog' ? squash(e.querySelector('h1,h2,h3,h4')?.textContent) : '')
      push(ref(e) + ' [' + section + (label ? ' "' + clip(label, 80) + '"' : '') + (e.matches(':modal') ? ' modal' : '') + ']')
    }
    if (tag === 'label' && e.control) quiet++
    // Rows are the innermost tr: layout tables nest a whole table inside one cell.
    const outer = row
    if (tag === 'tr') { flush(); row = e; buf = '| ' }
    else if (row && (tag === 'td' || tag === 'th')) { if (squash(buf) !== '|') buf += ' | ' }
    else if (BLOCK.has(tag) && !row) { flush(); if (level) prefix = '#'.repeat(+level) + ' '; else if (tag === 'li') prefix = '- ' }
    for (const c of e.childNodes) c.nodeType === 3 ? text(c) : c.nodeType === 1 && visit(c)
    if (tag === 'label' && e.control) quiet--
    if (row === e) { buf += ' |'; flush(); row = outer; if (row) buf = '| ' }
    else if (BLOCK.has(tag) && !row) flush()
  }
  try { visit(root); flush() } catch (err) { if (err !== CUT) throw err }
  const f = document.activeElement
  const focus = f && f !== document.body && f !== document.documentElement && f.isConnected ? describe(f) + ' (' + ref(f) + ')' : null
  return { doc: refs.doc, ...${PAGE_VIEW}, epoch, sh: document.documentElement.scrollHeight, lines, focus, above: seen.above, below: seen.below, headings: below.slice(0, 8), cut, keys, shown: ${PAGE_SHOWN} }
})()`

/** A filled password or anything else in `secrets`, raw and URL-encoded, never leaves for the model or the transcript. */
export function scrub(t: string, secrets: Set<string>): string {
  for (const v of secrets) for (const form of [v, encodeURIComponent(v)]) t = t.split(form).join('•••')
  return t
}

/** One encoder for every capture: the tool screenshots, the annotate crop and the tab still. `rect` is in CSS pixels, the
 *  result in image pixels, which are device pixels unless `maxEdge` caps the longer side. Null for an empty capture. */
export async function capture(
  wc: WebContents,
  { rect, maxEdge, format, quality = 85 }: { rect?: Rect; maxEdge?: number; format: 'jpeg' | 'png'; quality?: number }
): Promise<{ data: Buffer; w: number; h: number } | null> {
  let img = await wc.capturePage(rect && { x: rect.x, y: rect.y, width: rect.w, height: rect.h })
  if (img.isEmpty()) return null
  const { width, height } = img.getSize()
  const k = maxEdge ? maxEdge / Math.max(width, height) : 1
  if (k < 1) img = img.resize({ width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), quality: 'good' })
  const out = img.getSize()
  return { data: format === 'jpeg' ? img.toJPEG(quality) : img.toPNG(), w: out.width, h: out.height }
}

export interface Rect { x: number; y: number; w: number; h: number }

/** Lines carry their refs already spelled out, as formatRef does. */
export interface Observed extends View {
  sh: number
  lines: string[]
  focus: string | null
  above: number
  below: number
  /** Headings (h1-h3) below the viewport, so the model knows what scrolling reaches. */
  headings: string[]
  cut: boolean
  /** Single-character buttons: the shape of an on-screen keyboard or keypad. */
  keys: number
  shown: boolean
}

/** A snapshot ref: the tab, the document it was taken in, and the element's number there. */
export interface Ref { tab: number; doc: string; n: number }

const REF = /^t(\d+):d([0-9a-f]{8}):e(\d+)$/
export const formatRef = ({ tab, doc, n }: Ref): string => `t${tab}:d${doc}:e${n}`
export function parseRef(v: unknown): Ref | null {
  const m = typeof v === 'string' ? REF.exec(v) : null
  return m ? { tab: Number(m[1]), doc: m[2], n: Number(m[3]) } : null
}
/** The ref's element as an isolated-world expression, for a pill. Undefined once it's gone. */
export const refTarget = (n: number): string => `window.__cluiRefs?.els.get(${Number(n)})?.deref()`

export type RefMiss = 'gone' | 'page' | 'hidden'

/** Where to act on an element: its centre and size in CSS pixels of the viewport. */
export interface Box { x: number; y: number; w: number; h: number; password: boolean }

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
  /** The nonce of the document the last snapshot or screenshot ran in. Null until one runs, and again once a new document or a
   *  new renderer replaces it; the world's own table catches a replacement these events miss. */
  private doc: string | null = null

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
    wc.on('did-navigate', () => (this.doc = null))
    wc.on('render-process-gone', () => (this.doc = null))
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

  async click(x: number, y: number, button: 'left' | 'right' = 'left'): Promise<void> {
    await this.hover(x, y)
    await this.input('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 })
    await this.input('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 })
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

  /** The semantic snapshot; see `observe`. `scope` is an element of the current document, else it's `page`. */
  async observe({ tab, scope, all, cap }: { tab: number; scope?: Ref; all: boolean; cap: number }): Promise<Observed | { why: RefMiss }> {
    if (scope && scope.doc !== this.doc) return { why: 'page' }
    const out = await this.world<Observed | { why: RefMiss }>(observe(tab, this.doc, randomBytes(4).toString('hex'), scope?.n ?? null, all, cap))
    if ('doc' in out) this.doc = out.doc
    return out
  }

  /** The document and viewport a screenshot is taken in, or a coordinate is checked against. `shown` as in PAGE_SHOWN. */
  async view(): Promise<View & { shown: boolean }> {
    const out = await this.world<View & { shown: boolean }>(`(() => {
      const refs = (${PAGE_REFS})(window, ${JSON.stringify(this.doc)}, ${JSON.stringify(randomBytes(4).toString('hex'))})
      return { doc: refs.doc, ...${PAGE_VIEW}, epoch: (${PAGE_EPOCH})(refs.table), shown: ${PAGE_SHOWN} }
    })()`)
    this.doc = out.doc
    return out
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

  /** Where to act on a ref: its centre, scrolled into the viewport first when it's outside. */
  async locate(ref: Ref): Promise<Box | { why: RefMiss }> {
    if (ref.doc !== this.doc) return { why: 'page' }
    return this.world<Box | { why: RefMiss }>(`(async () => {
      const s = window.__cluiRefs
      if (!s || s.doc !== ${JSON.stringify(ref.doc)}) return { why: 'page' }
      const e = s.els.get(${Number(ref.n)})?.deref()
      if (!e || !e.isConnected) return { why: 'gone' }
      const centre = () => { const r = e.getBoundingClientRect(); return { r, x: r.x + r.width / 2, y: r.y + r.height / 2 } }
      let c = centre()
      if (c.x < 0 || c.y < 0 || c.x >= innerWidth || c.y >= innerHeight) {
        // Instant, or a page's scroll-behavior: smooth would still be moving it when the box is read.
        e.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
        // A tab nobody is viewing gets no frames, so the wait is capped.
        await new Promise((ok) => { requestAnimationFrame(() => ok()); setTimeout(ok, 100) })
        if (!e.isConnected) return { why: 'gone' }
        c = centre()
      }
      if (!c.r.width || !c.r.height) return { why: 'hidden' }
      return { x: c.x, y: c.y, w: c.r.width, h: c.r.height, password: e instanceof HTMLInputElement && e.type === 'password' }
    })()`)
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
