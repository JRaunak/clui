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
  return { list, shown }
})()`

export interface Box { x: number; y: number; password: boolean }

export class Cdp {
  private readonly wc: WebContents
  /** Called around every input dispatch, so the manager can tell CDP input from the user's. */
  private readonly onAct: () => void

  constructor(wc: WebContents, onAct: () => void, onWebAuthn: () => void) {
    this.wc = wc
    this.onAct = onAct
    const dbg = wc.debugger
    dbg.on('message', (_e, method, params: { name?: string }) => {
      if (method === 'Runtime.bindingCalled' && params.name === WEBAUTHN_BINDING) onWebAuthn()
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

  async click(x: number, y: number): Promise<void> {
    await this.input('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await this.input('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await this.input('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  }

  insertText(text: string): Promise<void> {
    return this.input('Input.insertText', { text })
  }

  async key(name: 'Enter'): Promise<void> {
    const k = { key: name, code: name, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
    await this.input('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...k })
    await this.input('Input.dispatchKeyEvent', { type: 'keyUp', ...k })
  }

  wheel(x: number, y: number, dy: number): Promise<void> {
    return this.input('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy })
  }

  private world<T>(code: string): Promise<T> {
    return this.wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }])
  }

  /** `shown`: a password autofill wrote is visible somewhere on the page. */
  listInteractive(): Promise<{ list: string; shown: boolean }> {
    return this.world<{ list: string; shown: boolean }>(LIST_INTERACTIVE)
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
}
