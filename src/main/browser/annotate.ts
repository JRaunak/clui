/**
 * Annotate: the user points at elements of the viewed page and they go with the next message.
 * Picking is Chromium's DevTools inspect mode, which consumes the click before the page sees it
 * and isn't bound by the page's CSP. The pinned outlines and the reads live in a CDP-created
 * isolated world, apart from the agent cursor's world 1001.
 */
import type { BrowserWindow, Event as ElectronEvent, Input, WebContents } from 'electron'
import { MAX_PINS, type AnnotateEvent, type AnnotateTarget, type AnnotationPin } from '../../shared/annotate'
import { IpcChannels } from '../../shared/ipc'
import type { Cdp } from './cdp'
import type { BrowserManager } from './manager'

const MARGIN = 24
const CROP_MAX_W = 800
const GROUP = 'clui-annotate'
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
      const r = p.el.isConnected ? p.el.getBoundingClientRect() : null;
      const shown = !!r && (r.width > 0 || r.height > 0);
      p.ring.hidden = p.badge.hidden = !shown;
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
    /** Focus inside a frame this world can't see into is refused, since it might be a password field. */
    read(el) {
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
      const html = copy.outerHTML;
      return {
        tag: el.localName,
        role: el.getAttribute('role'),
        name: el.getAttribute('aria-label') || '',
        text: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
        selector: selectorOf(el),
        bbox: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
        styles,
        html: html.length > 2048 ? html.slice(0, 2047) + '…' : html,
        url: location.href,
        vw: innerWidth,
        vh: innerHeight
      };
    },
    add(el, id) {
      const p = { el, ring: div('o'), badge: div('b') };
      root.append(p.ring, p.badge);
      pins.set(id, p);
      if (!raf) draw();
    },
    number(order) {
      for (const [id, n] of order) { const p = pins.get(id); if (p) p.badge.textContent = String(n); }
    },
    remove(id) {
      const p = pins.get(id);
      if (!p) return;
      p.ring.remove();
      p.badge.remove();
      pins.delete(id);
    },
    clear() {
      for (const id of [...pins.keys()]) this.remove(id);
    },
    count() {
      return pins.size;
    }
  };
})()`

type Why = Extract<AnnotateEvent, { type: 'off' }>['why']
type Read = (AnnotateTarget & { vw: number; vh: number }) | { refused: 'password' | 'failed' }

interface Live {
  tab: number
  wc: WebContents
  cdp: Cdp
  off: () => void
}

interface RemoteObject { objectId?: string; value?: unknown }

const GENERIC_ROLE = /^(generic|none|presentation|StaticText|InlineTextBox)$/

export class Annotator {
  private readonly browser: BrowserManager
  private readonly window: () => BrowserWindow | null
  private readonly live = new Map<string, Live>()
  /** Pins per session in pin order, which is their number order. */
  private readonly pins = new Map<string, { id: number; tab: number }[]>()
  /** A document's annotate world. A navigation drops it, and the next use makes a new one. */
  private readonly worlds = new WeakMap<WebContents, number>()
  private seq = 0

  constructor(browser: BrowserManager, window: () => BrowserWindow | null) {
    this.browser = browser
    this.window = window
  }

  private emit(handleId: string, e: AnnotateEvent): void {
    const win = this.window()
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send(IpcChannels.annotateEvent, handleId, e)
  }

  async start(handleId: string, tab: number): Promise<void> {
    if (this.live.get(handleId)?.tab === tab) return
    const page = this.browser.page(handleId, tab)
    const drive = this.browser.tabsOf(handleId)?.tabs.find((t) => t.id === tab)?.drive
    if (!page || drive === 'driving') return
    this.stop(handleId, 'away')
    const { wc, cdp } = page
    const onMessage = (_e: unknown, method: string, params: { backendNodeId?: number }): void => {
      if (method === 'Overlay.inspectNodeRequested' && params.backendNodeId !== undefined) void this.pick(handleId, tab, { backendNodeId: params.backendNodeId })
    }
    // Return and Escape never reach the page, so its own key handlers can't act on them.
    const onKey = (ev: ElectronEvent, input: Input): void => {
      if ((input.key !== 'Enter' && input.key !== 'Escape') || input.meta || input.control || input.alt || input.shift) return
      ev.preventDefault()
      if (input.type !== 'keyDown') return
      if (input.key === 'Escape') this.stop(handleId, 'esc')
      else void this.pick(handleId, tab, 'focused')
    }
    const onGone = (): void => this.stop(handleId, 'away')
    wc.debugger.on('message', onMessage)
    wc.on('before-input-event', onKey)
    wc.once('destroyed', onGone)
    const live: Live = {
      tab,
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
    this.emit(handleId, { type: 'on', tab })
  }

  stop(handleId: string, why: Why): void {
    const live = this.live.get(handleId)
    if (!live) return
    this.live.delete(handleId)
    live.off()
    if (!live.wc.isDestroyed()) void this.quiet(live.cdp)
    if (why === 'esc') this.window()?.webContents.focus()
    this.emit(handleId, { type: 'off', why })
  }

  private async quiet(cdp: Cdp): Promise<void> {
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
    if (this.live.get(handleId)?.tab === tab) this.stop(handleId, why)
  }

  private async known(wc: WebContents, cdp: Cdp): Promise<number | null> {
    const id = this.worlds.get(wc)
    if (id === undefined) return null
    const alive = await cdp
      .command<{ result: RemoteObject }>('Runtime.evaluate', { expression: '!!window.__cluiAnnotate', contextId: id, returnByValue: true })
      .then((r) => r.result.value === true, () => false)
    if (alive) return id
    this.worlds.delete(wc)
    return null
  }

  private async world(wc: WebContents, cdp: Cdp): Promise<number> {
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

  private async pick(handleId: string, tab: number, at: { backendNodeId: number } | 'focused'): Promise<void> {
    const page = this.browser.page(handleId, tab)
    if (!page) return
    const { wc, cdp } = page
    if (this.pinsOf(handleId).length >= MAX_PINS) return this.emit(handleId, { type: 'refused', why: 'cap' })
    try {
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
      const read = await call<Read>('function () { return window.__cluiAnnotate.read(this) }')
      if ('refused' in read) return this.emit(handleId, { type: 'refused', why: read.refused })
      const ax = await cdp
        .command<{ nodes: { role?: { value?: string }; name?: { value?: string } }[] }>('Accessibility.getPartialAXTree', { objectId, fetchRelatives: false })
        .then((r) => r.nodes[0], () => undefined)
      const role = read.role || ax?.role?.value || null
      const { vw, vh, ...target } = read
      target.role = role && !GENERIC_ROLE.test(role) ? role : null
      target.name = (read.name || ax?.name?.value || '').replace(/\s+/g, ' ').trim().slice(0, 200)
      const crop = await this.crop(wc, cdp, target.bbox, vw, vh)
      // Two quick picks both pass the first check, and a send may have cleared the list meanwhile.
      const list = this.pinsOf(handleId)
      if (list.length >= MAX_PINS) return this.emit(handleId, { type: 'refused', why: 'cap' })
      const id = ++this.seq
      await call('function (id) { window.__cluiAnnotate.add(this, id) }', [id])
      list.push({ id, tab })
      await this.renumber(handleId)
      this.emit(handleId, { type: 'pinned', pin: { id, tab, target: scrubbed(target, cdp.secrets), crop } })
    } catch {
      this.emit(handleId, { type: 'refused', why: 'failed' })
    } finally {
      void cdp.command('Runtime.releaseObjectGroup', { objectGroup: GROUP }).catch(() => {})
    }
  }

  /** Taken before the outline is drawn, with the hover highlight hidden, so the crop shows the page as it is. */
  private async crop(wc: WebContents, cdp: Cdp, b: AnnotateTarget['bbox'], vw: number, vh: number): Promise<AnnotationPin['crop']> {
    const x = Math.max(0, Math.floor(b.x - MARGIN))
    const y = Math.max(0, Math.floor(b.y - MARGIN))
    const width = Math.min(vw, Math.ceil(b.x + b.width + MARGIN)) - x
    const height = Math.min(vh, Math.ceil(b.y + b.height + MARGIN)) - y
    if (width <= 0 || height <= 0) return null
    await cdp.command('Overlay.hideHighlight').catch(() => {})
    let img = await wc.capturePage({ x, y, width, height })
    if (img.isEmpty()) return null
    // A Retina capture doubles the pixels, which quadruples the image tokens and shows a UI bug no better.
    const px = img.getSize(Math.max(...img.getScaleFactors()))
    const target = Math.min(width, CROP_MAX_W)
    if (px.width > target) img = img.resize({ width: target, quality: 'good' })
    const out = img.getSize(Math.max(...img.getScaleFactors()))
    return { data: img.toJPEG(85).toString('base64'), w: out.width, h: out.height }
  }

  private pinsOf(handleId: string): { id: number; tab: number }[] {
    let list = this.pins.get(handleId)
    if (!list) this.pins.set(handleId, (list = []))
    return list
  }

  private async eachWorld(handleId: string, code: (tab: number) => string): Promise<void> {
    const tabs = new Set(this.pinsOf(handleId).map((p) => p.tab))
    for (const tab of tabs) {
      const page = this.browser.page(handleId, tab)
      const contextId = page && (await this.known(page.wc, page.cdp))
      if (page && contextId) await page.cdp.command('Runtime.evaluate', { expression: code(tab), contextId }).catch(() => {})
    }
  }

  private renumber(handleId: string): Promise<void> {
    const order = this.pinsOf(handleId).map((p, i) => [p.id, i + 1])
    return this.eachWorld(handleId, () => `window.__cluiAnnotate.number(${JSON.stringify(order)})`)
  }

  async remove(handleId: string, id: number): Promise<void> {
    const list = this.pinsOf(handleId)
    const i = list.findIndex((p) => p.id === id)
    if (i < 0) return
    const [gone] = list.splice(i, 1)
    const page = this.browser.page(handleId, gone.tab)
    const contextId = page && (await this.known(page.wc, page.cdp))
    if (page && contextId) await page.cdp.command('Runtime.evaluate', { expression: `window.__cluiAnnotate.remove(${id})`, contextId }).catch(() => {})
    await this.renumber(handleId)
  }

  async clear(handleId: string): Promise<void> {
    await this.eachWorld(handleId, () => 'window.__cluiAnnotate.clear()')
    this.pins.delete(handleId)
  }

  /** For the test harness: outlines the page's annotate world holds. */
  async count(handleId: string, tab: number): Promise<number> {
    const page = this.browser.page(handleId, tab)
    const contextId = page && (await this.known(page.wc, page.cdp))
    if (!page || !contextId) return 0
    const r = await page.cdp.command<{ result: RemoteObject }>('Runtime.evaluate', { expression: 'window.__cluiAnnotate.count()', contextId, returnByValue: true })
    return r.result.value as number
  }

  dispose(handleId: string): void {
    this.stop(handleId, 'away')
    this.pins.delete(handleId)
  }
}

/** A password Clui filled can surface in page text (a show-password toggle, a script copying it), so it never leaves. */
function scrubbed(t: AnnotateTarget, secrets: Set<string>): AnnotateTarget {
  if (!secrets.size) return t
  const scrub = (s: string): string => [...secrets].reduce((acc, v) => acc.split(v).join('•••'), s)
  return { ...t, name: scrub(t.name), text: scrub(t.text), html: scrub(t.html) }
}
