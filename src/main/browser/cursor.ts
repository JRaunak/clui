/**
 * The agent cursor and the in-page pills, drawn by the page's isolated world into a closed
 * shadow root so the page can neither style nor read them. Colours are literals because the
 * page can't see Clui's CSS variables.
 */
import type { WebContents } from 'electron'

export const WORLD = 1001

const CURSOR_SCRIPT = `(() => {
  if (window.__cluiCursor) return;
  const host = document.createElement('clui-agent-cursor');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  const root = host.attachShadow({ mode: 'closed' });
  // Built node by node with a constructed stylesheet and CSSOM styles, because the page's
  // CSP and Trusted Types also bind this world: innerHTML, <style> and style attributes can be refused.
  const NS = 'http://www.w3.org/2000/svg';
  const make = (tag, attrs, kids = [], ns) => {
    const el = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    el.append(...kids);
    return el;
  };
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(\`
    .c { position: fixed; left: 0; top: 0; width: 18px; height: 18px; transform: translate(-100px, -100px);
         transition: transform 220ms cubic-bezier(0.2, 0, 0, 1) }
    .c svg { display: block; overflow: visible }
    .dot { position: absolute; left: -3px; top: 14px; width: 6px; height: 6px; border-radius: 50%; background: #de7356 }
    .glow { position: absolute; left: 50%; top: 50%; width: 24px; height: 24px; translate: -50% -50%; border-radius: 50%;
            background: radial-gradient(circle, rgb(222 115 86 / 0.55) 0%, rgb(222 115 86 / 0.22) 35%, rgb(222 115 86 / 0) 70%);
            animation: b 2.8s cubic-bezier(0.37, 0, 0.63, 1) infinite }
    @keyframes b { 0%, 100% { opacity: 0.55; transform: scale(0.86) } 50% { opacity: 1; transform: scale(1) } }
    .ring { position: fixed; left: 0; top: 0; width: 20px; height: 20px; margin: -10px 0 0 -10px; border-radius: 50%;
            border: 2px solid #e6e6e6; box-shadow: 0 0 0 1.5px #161617; opacity: 0 }
    .pill { position: fixed; height: 24px; padding: 0 10px; border-radius: 12px; display: flex; align-items: center; gap: 6px;
            background: #1e1e1f; border: 1px solid #e6e6e6; color: #e6e6e6; font: 500 12px system-ui; transition: opacity 150ms }
    .pill svg { color: #4ec9b0 }
    @media (prefers-reduced-motion: reduce) { .c { transition: none } .glow { animation: none; opacity: 1 } .ring { display: none } .pill { transition: none } }\`);
  root.adoptedStyleSheets = [sheet];
  const arrow = make('svg', { width: '18', height: '18', viewBox: '0 0 18 18' }, [
    make('path', { d: 'M1 1 L1 15 L5 11 L8 17 L10.5 16 L7.5 10 L13 10 Z', fill: '#e6e6e6', stroke: '#161617', 'stroke-width': '1.5', 'stroke-linejoin': 'round' }, [], NS)
  ], NS);
  const c = make('div', { class: 'c' }, [arrow, make('span', { class: 'dot' }, [make('span', { class: 'glow' })])]);
  c.hidden = true;
  const ringEl = make('div', { class: 'ring' });
  root.append(c, ringEl);
  document.documentElement.appendChild(host);
  const key = () => make('svg', { width: '12', height: '12', viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round' }, [
    make('circle', { cx: '4', cy: '6', r: '2.5' }, [], NS),
    make('path', { d: 'M6.5 6H11M9.5 6v2' }, [], NS)
  ], NS);
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.__cluiCursor = {
    move(x, y) {
      c.hidden = false;
      c.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
      return new Promise((ok) => setTimeout(ok, reduced() ? 0 : 220));
    },
    ring(x, y) {
      const at = 'translate(' + x + 'px,' + y + 'px)';
      ringEl.animate([{ transform: at + ' scale(0.6)' }, { transform: at + ' scale(1.6)' }], { duration: 240, easing: 'cubic-bezier(0, 0, 0.2, 1)' });
      ringEl.animate([{ opacity: 0.5 }, { opacity: 0 }], { duration: 240, easing: 'linear' });
    },
    hide() {
      c.hidden = true;
    },
    visible() {
      return !!c.isConnected && !c.hidden;
    },
    pill(target, text) {
      const el = typeof target === 'string' ? document.querySelector(target) : target;
      if (!el || !el.getBoundingClientRect) return;
      const r = el.getBoundingClientRect();
      const p = make('div', { class: 'pill' }, [key(), text]);
      p.style.visibility = 'hidden';
      root.appendChild(p);
      const w = p.offsetWidth, H = 24, vw = innerWidth;
      // The first spot that covers nothing the user would read: beside the field, above it, below it,
      // and last inside its end, over the masked dots, since the pill takes no pointer.
      const others = [...document.querySelectorAll('input, select, textarea, button')]
        .filter((n) => n !== el)
        .map((n) => n.getBoundingClientRect())
        .filter((b) => b.width && b.height);
      const clear = (x, y) => !others.some((b) => x < b.right && x + w > b.left && y < b.bottom && y + H > b.top);
      const mid = r.top + (r.height - H) / 2;
      const left = Math.min(Math.max(8, r.left), vw - w - 8);
      if (r.right + 8 + w <= vw - 8) {
        p.style.left = r.right + 8 + 'px';
        p.style.top = mid + 'px';
      } else if (r.top >= 30 && clear(left, r.top - 30)) {
        p.style.left = left + 'px';
        p.style.top = r.top - 30 + 'px';
      } else if (clear(left, r.bottom + 6)) {
        p.style.left = left + 'px';
        p.style.top = r.bottom + 6 + 'px';
      } else {
        p.style.right = vw - r.right + 4 + 'px';
        p.style.top = mid + 'px';
      }
      p.style.visibility = '';
      setTimeout(() => {
        if (reduced()) return p.remove();
        p.style.opacity = '0';
        setTimeout(() => p.remove(), 150);
      }, 4000);
    }
  };
})()`

type PillText = 'Filled by Clui' | "Claude can't type passwords"

function run(wc: WebContents, code: string): Promise<unknown> {
  if (wc.isDestroyed()) return Promise.resolve(null)
  return wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]).catch(() => null)
}

export function injectCursor(wc: WebContents): Promise<unknown> {
  return run(wc, CURSOR_SCRIPT)
}

export async function moveCursor(wc: WebContents, x: number, y: number): Promise<void> {
  await injectCursor(wc)
  await run(wc, `window.__cluiCursor.move(${Number(x)}, ${Number(y)})`)
}

export function clickRing(wc: WebContents, x: number, y: number): Promise<unknown> {
  return run(wc, `window.__cluiCursor?.ring(${Number(x)}, ${Number(y)})`)
}

export function hideCursor(wc: WebContents): Promise<unknown> {
  return run(wc, 'window.__cluiCursor?.hide()')
}

/** `target` is an expression evaluated in the isolated world, e.g. `document.activeElement`. */
export function pill(wc: WebContents, target: string, text: PillText): Promise<unknown> {
  return run(wc, `window.__cluiCursor?.pill(${target}, ${JSON.stringify(text)})`)
}
