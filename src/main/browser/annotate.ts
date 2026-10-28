/**
 * Annotate: the user points at elements of the viewed browser tab or HTML page Preview, and they go with the next
 * message. Picking is Chromium's DevTools inspect mode, which consumes the click before the page sees it and isn't
 * bound by the page's CSP. The pinned outlines and the reads live in a CDP-created isolated world, apart from the
 * agent cursor's world 1001.
 */
import type { BrowserWindow, Event as ElectronEvent, Input, WebContents } from 'electron'
import { CROP_MAX_EDGE, samePoint, type AnnotateEvent, type AnnotateTarget, type PinInput, type PointAt } from '../../shared/annotate'
import { MAX_REFS, type DraftVisual, type SourceVersion } from '../../shared/context'
import type { AnnotationOrder } from '../../shared/ipc'
import { IpcChannels } from '../../shared/ipc'
import { capture, scrub, type Cdp } from './cdp'
import type { BrowserManager } from './manager'
import { getSettingsSync } from '../settings/store'

const MARGIN = 24
const GROUP = 'clui-annotate'
const DOC_TIMEOUT_MS = 2000
const HIGHLIGHT = {
  borderColor: { r: 230, g: 230, b: 230, a: 1 },
  contentColor: { r: 230, g: 230, b: 230, a: 0.08 }
}

const WORLD_SCRIPT = `(() => {
  if (window.__cluiAnnotate) return;
  // Built node by node with a constructed stylesheet and CSSOM styles, as in the cursor's world:
  // the page's CSP and Trusted Types bind this world too.
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(\`
    .o { position: fixed; left: 0; top: 0; box-sizing: border-box; border-radius: 2px;
         box-shadow: 0 0 0 2px #de7356, 0 0 0 3.5px #161617 }
    .b { position: fixed; left: 0; top: 0; width: 18px; height: 18px; border-radius: 50%; background: #de7356;
         color: #1a1a1a; font: 600 11px/18px system-ui; text-align: center }\`);
  const host = document.createElement('clui-annotate');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  const root = host.attachShadow({ mode: 'closed' });
  root.adoptedStyleSheets = [sheet];
  const div = (cls) => { const d = document.createElement('div'); d.className = cls; return d; };
  const pins = new Map();
  let raf = 0;
  const draw = () => {
    raf = 0;
    if (!pins.size) return host.remove();
    if (!host.isConnected) document.documentElement.appendChild(host);
    for (const p of pins.values()) {
      const r = p.on && p.el.isConnected ? p.el.getBoundingClientRect() : null;
      const shown = !!r && (r.width > 0 || r.height > 0);
      p.ring.hidden = !shown;
      p.badge.hidden = !shown || !p.badge.textContent;
      if (!shown) continue;
      p.ring.style.transform = 'translate(' + r.left + 'px,' + r.top + 'px)';
      p.ring.style.width = r.width + 'px';
      p.ring.style.height = r.height + 'px';
      p.badge.style.transform = 'translate(' + Math.max(2, r.left - 9) + 'px,' + Math.max(2, r.top - 9) + 'px)';
    }
    raf = requestAnimationFrame(draw);
  };
  const STYLES = ['display', 'position', 'font-size', 'color', 'background-color', 'margin', 'padding', 'width', 'height'];
  const isPassword = (e) => e.tagName === 'INPUT' && e.type === 'password';
  const selectorOf = (el) => {
    const parts = [];
    for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
      if (e.id && document.querySelectorAll('#' + CSS.escape(e.id)).length === 1) {
        parts.unshift('#' + CSS.escape(e.id));
        break;
      }
      const same = e.parentElement ? [...e.parentElement.children].filter((c) => c.localName === e.localName) : [];
      parts.unshift(same.length > 1 ? e.localName + ':nth-of-type(' + (same.indexOf(e) + 1) + ')' : e.localName);
    }
    return parts.join(' > ');
  };
  window.__cluiAnnotate = {
    focused() {
      const e = document.activeElement;
      return e && e !== document.body && e !== document.documentElement ? e : null;
    },
    /** Focus inside a frame this world can't see into is refused, since it might be a password field. Secrets are
     *  scrubbed before any cut, so no clipped tail keeps part of one. */
    read(el, secrets) {
      const hide = (s) => {
        for (const v of secrets) for (const f of [v, encodeURIComponent(v)]) s = s.split(f).join('•••');
        return s;
      };
      let f = el;
      while (f && (f.tagName === 'IFRAME' || f.tagName === 'FRAME')) {
        if (!f.contentDocument) return { refused: 'failed' };
        f = f.contentDocument.activeElement;
      }
      if (isPassword(el) || (f !== el && f && isPassword(f))) return { refused: 'password' };
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const styles = {};
      for (const k of STYLES) styles[k] = cs.getPropertyValue(k);
      const copy = el.cloneNode(true);
      for (const i of [copy, ...copy.querySelectorAll('input')]) if (i.tagName === 'INPUT') i.removeAttribute('value');
      const html = hide(copy.outerHTML);
      const role = el.getAttribute('role');
      return {
        tag: el.localName,
        role: role && hide(role),
        name: hide(el.getAttribute('aria-label') || ''),
        text: hide((el.innerText || '').replace(/\\s+/g, ' ').trim()).slice(0, 200),
        selector: hide(selectorOf(el)),
        bbox: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
        styles,
        html: html.length > 2048 ? html.slice(0, 2047) + '…' : html,
        url: hide(location.href),
        vw: innerWidth,
        vh: innerHeight
      };
    },
    add(el, id) {
      const p = { el, ring: div('o'), badge: div('b'), on: true };
      root.append(p.ring, p.badge);
      pins.set(id, p);
      if (!raf) draw();
    },
    /** Restore pins are found again by selector, since a reloaded page has lost them. */
    sync(keep, shown, restore) {
      for (const [id, sel] of restore) {
        if (pins.has(id)) continue;
        let el = null;
        try { el = document.querySelector(sel); } catch {}
        if (el) window.__cluiAnnotate.add(el, id);
      }
      const n = new Map(shown);
      for (const [id, p] of [...pins]) {
        if (!keep.includes(id)) {
          p.ring.remove();
          p.badge.remove();
          pins.delete(id);
          continue;
        }
        p.on = n.has(id);
        p.badge.textContent = p.on ? String(n.get(id)) : '';
      }
      if (!raf) draw();
    },
    order() {
      return [...pins].map(([id, p]) => [id, Number(p.badge.textContent) || 0, p.on]);
    },
    count() {
      return pins.size;
    }
  };
})()`

type Why = Extract<AnnotateEvent, { type: 'off' }>['why']
type Read = (AnnotateTarget & { vw: number; vh: number }) | { refused: 'password' | 'failed' }

/** A page pointing can run on. An HTML view's channel holds its cap origin as a secret, so it's scrubbed from reads. */
export interface Pointable {
  wc: WebContents
  cdp: Pick<Cdp, 'command' | 'secrets'>
}

/** An HTML view's page. `path` is the file as its tab names it. */
export interface HtmlPage extends Pointable {
  path: string
  tabId: string
  creatingEditId?: string
  /** The revision of the file the view shows, or null when the disk no longer holds it. */
  revision(): Promise<SourceVersion | null>
}

export interface HtmlPoints {
  page(handleId: string, viewId: string): HtmlPage | null
  viewOf(handleId: string, tabId: string): string | null
}

type Resolved = (Pointable & { kind: 'browser'; tab: number }) | (HtmlPage & { kind: 'html' })

/** Where a pin's outline lives. A page's view is recreated on every return to its tab, so its pin is found by selector. */
type Home = { kind: 'browser'; tab: number } | { kind: 'html'; tabId: string; selector: string }
interface Pin { id: number; home: Home }

const homeKey = (h: Home): string => (h.kind === 'browser' ? `b${h.tab}` : `h${h.tabId}`)

interface Live {
  at: PointAt
  wc: WebContents
  cdp: Pointable['cdp']
  off: () => void
}

interface RemoteObject { objectId?: string; value?: unknown }

const GENERIC_ROLE = /^(generic|none|presentation|StaticText|InlineTextBox)$/

export class Annotator {
  private readonly browser: BrowserManager
  private readonly window: () => BrowserWindow | null
  private readonly html: HtmlPoints
  private readonly live = new Map<string, Live>()
  /** The live pins per session. Their numbers and visibility come from the renderer's sync. */
  private readonly pins = new Map<string, Pin[]>()
  /** References the renderer's edit target has room for, from its last sync. */
  private readonly rooms = new Map<string, number>()
  /** The renderer's last numbering, for outlines redrawn on a page's next document. */
  private readonly shown = new Map<string, Map<number, number>>()
  /** A document's annotate world. A navigation drops it, and the next use makes a new one. */
  private readonly worlds = new WeakMap<WebContents, number>()
  private seq = 0

  constructor(browser: BrowserManager, window: () => BrowserWindow | null, html: HtmlPoints) {
    this.browser = browser
    this.window = window
    this.html = html
  }

  private page(handleId: string, at: PointAt): Resolved | null {
    if (at.kind === 'html') {
      const p = this.html.page(handleId, at.viewId)
      return p && { ...p, kind: 'html' }
    }
    const p = this.browser.page(handleId, at.tab)
    return p && { wc: p.wc, cdp: p.cdp, kind: 'browser', tab: at.tab }
  }

  private pointOf(handleId: string, h: Home): PointAt | null {
    if (h.kind === 'browser') return { kind: 'browser', tab: h.tab }
    const viewId = this.html.viewOf(handleId, h.tabId)
    return viewId ? { kind: 'html', viewId } : null
  }

  private emit(handleId: string, e: AnnotateEvent): void {
    const win = this.window()
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send(IpcChannels.annotateEvent, handleId, e)
  }

  async start(handleId: string, at: PointAt): Promise<void> {
    if (samePoint(this.live.get(handleId)?.at ?? null, at)) return
    const page = this.page(handleId, at)
    if (!page || (page.kind === 'browser' && this.browser.tabsOf(handleId)?.tabs.find((t) => t.id === page.tab)?.drive === 'driving')) return
    this.stop(handleId, 'away')
    const { wc, cdp } = page
    const onMessage = (_e: unknown, method: string, params: { backendNodeId?: number }): void => {
      if (method === 'Overlay.inspectNodeRequested' && params.backendNodeId !== undefined) void this.pick(handleId, at, { backendNodeId: params.backendNodeId })
    }
    // Return and Escape never reach the page, so its own key handlers can't act on them.
    const onKey = (ev: ElectronEvent, input: Input): void => {
      if ((input.key !== 'Enter' && input.key !== 'Escape') || input.meta || input.control || input.alt || input.shift) return
      ev.preventDefault()
      if (input.type !== 'keyDown') return
      if (input.key === 'Escape') this.stop(handleId, 'esc')
      else void this.pick(handleId, at, 'focused')
    }
    const onGone = (): void => this.stop(handleId, 'away')
    wc.debugger.on('message', onMessage)
    wc.on('before-input-event', onKey)
    wc.once('destroyed', onGone)
    const live: Live = {
      at,
      wc,
      cdp,
      off: () => {
        wc.debugger.off('message', onMessage)
        wc.off('before-input-event', onKey)
        wc.off('destroyed', onGone)
      }
    }
    this.live.set(handleId, live)
    try {
      await cdp.command('DOM.enable')
      await cdp.command('Overlay.enable')
      await cdp.command('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: HIGHLIGHT })
    } catch {
      this.stop(handleId, 'away')
      return
    }
    // A drive can start during the awaits, and its stop has already gone out ahead of the inspect mode.
    if (this.live.get(handleId) !== live) return void this.quiet(cdp)
    this.emit(handleId, { type: 'on', at })
  }

  /** `at`: stop only if pointing runs there. */
  stop(handleId: string, why: Why, at?: PointAt): void {
    const live = this.live.get(handleId)
    if (!live || (at && !samePoint(live.at, at))) return
    this.live.delete(handleId)
    live.off()
    if (!live.wc.isDestroyed()) void this.quiet(live.cdp)
    if (why === 'esc') this.window()?.webContents.focus()
    this.emit(handleId, { type: 'off', why })
  }

  private async quiet(cdp: Pointable['cdp']): Promise<void> {
    try {
      // Chromium refuses mode none without a highlight config, though the protocol marks it optional.
      await cdp.command('Overlay.setInspectMode', { mode: 'none', highlightConfig: HIGHLIGHT })
      await cdp.command('Overlay.disable')
      await cdp.command('DOM.disable')
    } catch {
      // A closing page.
    }
  }

  /** The manager's word that `tab` can't be annotated any more. */
  leave(handleId: string, tab: number, why: 'driving' | 'away'): void {
    this.stop(handleId, why, { kind: 'browser', tab })
  }

  private async known(wc: WebContents, cdp: Pointable['cdp']): Promise<number | null> {
    const id = this.worlds.get(wc)
    if (id === undefined) return null
    const alive = await cdp
      .command<{ result: RemoteObject }>('Runtime.evaluate', { expression: '!!window.__cluiAnnotate', contextId: id, returnByValue: true })
      .then((r) => r.result.value === true, () => false)
    if (alive) return id
    this.worlds.delete(wc)
    return null
  }

  private async world(wc: WebContents, cdp: Pointable['cdp']): Promise<number> {
    const known = await this.known(wc, cdp)
    if (known !== null) return known
    const { frameTree } = await cdp.command<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree')
    const { executionContextId } = await cdp.command<{ executionContextId: number }>('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id,
      worldName: GROUP
    })
    await cdp.command('Runtime.evaluate', { expression: WORLD_SCRIPT, contextId: executionContextId })
    this.worlds.set(wc, executionContextId)
    return executionContextId
  }

  private async pick(handleId: string, point: PointAt, at: { backendNodeId: number } | 'focused'): Promise<void> {
    const page = this.page(handleId, point)
    if (!page) return
    const { wc, cdp } = page
    if (this.room(handleId) <= 0) return this.emit(handleId, { type: 'refused', why: 'cap' })
    try {
      const source = page.kind === 'browser' ? await this.docOf(handleId, page.tab) : await page.revision()
      if (!source) return this.emit(handleId, { type: 'refused', why: 'failed' })
      const contextId = await this.world(wc, cdp)
      const objectId =
        at === 'focused'
          ? (await cdp.command<{ result: RemoteObject }>('Runtime.evaluate', { expression: 'window.__cluiAnnotate.focused()', contextId, objectGroup: GROUP })).result.objectId
          : (await cdp.command<{ object: RemoteObject }>('DOM.resolveNode', { ...at, executionContextId: contextId, objectGroup: GROUP })).object.objectId
      if (!objectId) return this.emit(handleId, { type: 'refused', why: 'failed' })
      const call = <T>(fn: string, args: unknown[] = []): Promise<T> =>
        cdp
          .command<{ result: RemoteObject }>('Runtime.callFunctionOn', { objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true })
          .then((r) => r.result.value as T)
      const read = await call<Read>('function (secrets) { return window.__cluiAnnotate.read(this, secrets) }', [[...cdp.secrets]])
      if ('refused' in read) return this.emit(handleId, { type: 'refused', why: read.refused })
      const ax = await cdp
        .command<{ nodes: { role?: { value?: string }; name?: { value?: string } }[] }>('Accessibility.getPartialAXTree', { objectId, fetchRelatives: false })
        .then((r) => r.nodes[0], () => undefined)
      const role = read.role || ax?.role?.value || null
      const { vw, vh, ...target } = read
      target.role = role && !GENERIC_ROLE.test(role) ? role : null
      target.name = scrub((read.name || ax?.name?.value || '').replace(/\s+/g, ' ').trim(), cdp.secrets).slice(0, 200)
      const crop = await this.crop(wc, cdp, target.bbox, vw, vh)
      // Two quick picks both pass the first check, and a sync may have lowered the room meanwhile.
      const room = this.room(handleId)
      if (room <= 0) return this.emit(handleId, { type: 'refused', why: 'cap' })
      const id = ++this.seq
      await call('function (id) { window.__cluiAnnotate.add(this, id) }', [id])
      this.pinsOf(handleId).push({ id, home: page.kind === 'browser' ? { kind: 'browser', tab: page.tab } : { kind: 'html', tabId: page.tabId, selector: target.selector } })
      this.rooms.set(handleId, room - 1)
      const visual: DraftVisual | null = crop && { id: `v${id}`, data: crop.data, mimeType: 'image/jpeg', w: crop.w, h: crop.h }
      const { url, ...rest } = scrubbed(target, cdp.secrets)
      const ref: PinInput =
        page.kind === 'browser'
          ? { kind: 'browser', pin: { source: { kind: 'browser', tabId: page.tab, docId: source }, target: { ...rest, url } } }
          : { kind: 'page', path: page.path, revision: source as SourceVersion, ...(page.creatingEditId ? { creatingEditId: page.creatingEditId } : {}), target: rest }
      this.emit(handleId, { type: 'pinned', pinId: id, ref, crop: visual })
    } catch {
      this.emit(handleId, { type: 'refused', why: 'failed' })
    } finally {
      void cdp.command('Runtime.releaseObjectGroup', { objectGroup: GROUP }).catch(() => {})
    }
  }

  /** Taken before the outline is drawn, with the hover highlight hidden, so the crop shows the page as it is. */
  private async crop(wc: WebContents, cdp: Pointable['cdp'], b: AnnotateTarget['bbox'], vw: number, vh: number): Promise<{ data: string; w: number; h: number } | null> {
    if (!getSettingsSync().annotateScreenshots) return null
    const x = Math.max(0, Math.floor(b.x - MARGIN))
    const y = Math.max(0, Math.floor(b.y - MARGIN))
    const width = Math.min(vw, Math.ceil(b.x + b.width + MARGIN)) - x
    const height = Math.min(vh, Math.ceil(b.y + b.height + MARGIN)) - y
    if (width <= 0 || height <= 0) return null
    await cdp.command('Overlay.hideHighlight').catch(() => {})
    // A Retina capture doubles the pixels, which quadruples the image tokens and shows a UI bug no better.
    const img = await capture(wc, { rect: { x, y, w: width, h: height }, maxEdge: Math.min(Math.max(width, height), CROP_MAX_EDGE), format: 'jpeg' })
    return img && { data: img.data.toString('base64'), w: img.w, h: img.h }
  }

  private pinsOf(handleId: string): Pin[] {
    let list = this.pins.get(handleId)
    if (!list) this.pins.set(handleId, (list = []))
    return list
  }

  private room(handleId: string): number {
    return this.rooms.get(handleId) ?? MAX_REFS
  }

  /** The document a pin belongs to: the top frame's loaderId, which changes on every cross-document load. */
  async docOf(handleId: string, tab: number): Promise<string | null> {
    const page = this.browser.page(handleId, tab)
    if (!page) return null
    // A hung page can leave the command unanswered, and a send waits on this, so it reads as closed instead.
    return Promise.race([
      page.cdp.command<{ frameTree: { frame: { loaderId?: string } } }>('Page.getFrameTree').then((r) => r.frameTree.frame.loaderId ?? null, () => null),
      new Promise<null>((done) => setTimeout(done, DOC_TIMEOUT_MS, null))
    ])
  }

  /** The renderer's word on which pins still back a reference and which the edit target shows. */
  async sync(handleId: string, s: AnnotationOrder): Promise<void> {
    const keep = new Set(s.keep)
    const shown = new Map(s.shown)
    const list = this.pinsOf(handleId)
    this.pins.set(handleId, list.filter((p) => keep.has(p.id)))
    this.rooms.set(handleId, s.room)
    this.shown.set(handleId, shown)
    const homes = new Map(list.map((p) => [homeKey(p.home), p.home]))
    for (const [key, home] of homes) {
      const at = this.pointOf(handleId, home)
      if (at) await this.draw(handleId, at, list.filter((p) => homeKey(p.home) === key && keep.has(p.id)), shown)
    }
  }

  private async draw(handleId: string, at: PointAt, pins: Pin[], shown: Map<number, number>): Promise<void> {
    const page = this.page(handleId, at)
    if (!page) return
    const ids = pins.map((p) => p.id)
    const order = ids.flatMap((id) => (shown.has(id) ? [[id, shown.get(id)]] : []))
    const restore = pins.flatMap((p) => (p.home.kind === 'html' ? [[p.id, p.home.selector]] : []))
    const contextId = (await this.known(page.wc, page.cdp)) ?? (restore.length ? await this.world(page.wc, page.cdp).catch(() => null) : null)
    if (contextId)
      await page.cdp
        .command('Runtime.evaluate', { expression: `window.__cluiAnnotate.sync(${JSON.stringify(ids)}, ${JSON.stringify(order)}, ${JSON.stringify(restore)})`, contextId })
        .catch(() => {})
  }

  /** HtmlViews' word that a page tab's document finished loading. */
  async redraw(handleId: string, tabId: string): Promise<void> {
    const pins = this.pins.get(handleId)?.filter((p) => p.home.kind === 'html' && p.home.tabId === tabId)
    const at = pins?.length ? this.pointOf(handleId, pins[0].home) : null
    if (pins && at) await this.draw(handleId, at, pins, this.shown.get(handleId) ?? new Map())
  }

  /** The manager's word that the tab's document is gone. Its pins went with it. */
  gone(handleId: string, tab: number, reason: 'navigated' | 'closed'): void {
    const list = this.pins.get(handleId)
    const here = (p: Pin): boolean => p.home.kind === 'browser' && p.home.tab === tab
    if (!list?.some(here)) return
    this.pins.set(handleId, list.filter((p) => !here(p)))
    this.emit(handleId, { type: 'gone', tab, reason })
  }

  holds(handleId: string, tab: number): boolean {
    return !!this.pins.get(handleId)?.some((p) => p.home.kind === 'browser' && p.home.tab === tab)
  }

  /** For the test harness: outlines the page's annotate world holds. */
  async count(handleId: string, at: PointAt): Promise<number> {
    const page = this.page(handleId, at)
    const contextId = page && (await this.known(page.wc, page.cdp))
    if (!page || !contextId) return 0
    const r = await page.cdp.command<{ result: RemoteObject }>('Runtime.evaluate', { expression: 'window.__cluiAnnotate.count()', contextId, returnByValue: true })
    return r.result.value as number
  }

  /** For the test harness: `[pinId, n, shown]` per outline in the page's annotate world. */
  async order(handleId: string, at: PointAt): Promise<[number, number, boolean][]> {
    const page = this.page(handleId, at)
    const contextId = page && (await this.known(page.wc, page.cdp))
    if (!page || !contextId) return []
    const r = await page.cdp.command<{ result: RemoteObject }>('Runtime.evaluate', { expression: 'window.__cluiAnnotate.order()', contextId, returnByValue: true })
    return r.result.value as [number, number, boolean][]
  }

  dispose(handleId: string): void {
    this.stop(handleId, 'away')
    this.pins.delete(handleId)
    this.rooms.delete(handleId)
    this.shown.delete(handleId)
  }
}

/** A password Clui filled can surface in page text (a show-password toggle, a script copying it), so it never leaves. */
function scrubbed(t: AnnotateTarget, secrets: Set<string>): AnnotateTarget {
  if (!secrets.size) return t
  return {
    ...t,
    role: t.role && scrub(t.role, secrets),
    name: scrub(t.name, secrets),
    text: scrub(t.text, secrets),
    selector: scrub(t.selector, secrets),
    html: scrub(t.html, secrets),
    url: scrub(t.url, secrets)
  }
}
