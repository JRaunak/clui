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
    .c { position: fixed; left: 0; top: 0; width: 20px; height: 20px; transform: translate(-100px, -100px);
         transition: transform 220ms cubic-bezier(0.2, 0, 0, 1) }
    .c svg { position: relative; display: block; overflow: visible; margin: -2px 0 0 -2px;
             filter: drop-shadow(0 1px 1.5px rgb(0 0 0 / 0.35)) }
    .glow { position: absolute; left: 12.8px; top: 12.4px; width: 24px; height: 24px; translate: -50% -50%; border-radius: 50%;
            background: radial-gradient(circle, rgb(222 115 86 / 0.55) 0%, rgb(222 115 86 / 0.22) 35%, rgb(222 115 86 / 0) 70%);
            animation: b 2.8s cubic-bezier(0.37, 0, 0.63, 1) infinite }
    .c[data-rest] .glow { animation: none; opacity: 0 }
    @keyframes b { 0%, 100% { opacity: 0.55; transform: scale(0.86) } 50% { opacity: 1; transform: scale(1) } }
    .ring { position: fixed; left: 0; top: 0; width: 20px; height: 20px; margin: -10px 0 0 -10px; border-radius: 50%;
            box-sizing: border-box; border: 2px solid #e6e6e6; box-shadow: 0 0 0 1.5px #161617; opacity: 0 }
    .pill { position: fixed; height: 24px; padding: 0 10px; border-radius: 12px; display: flex; align-items: center; gap: 6px;
            background: #1e1e1f; border: 1px solid #e6e6e6; color: #e6e6e6; font: 500 12px system-ui; transition: opacity 150ms;
            filter: drop-shadow(0 1px 1.5px rgb(0 0 0 / 0.35)) }
    .bar { width: 3px; height: 12px; border-radius: 1.5px; background: #de7356; flex: none }
    @media (prefers-reduced-motion: reduce) { .c { transition: none } .glow { animation: none; opacity: 1 } .pill { transition: none } }\`);
  root.adoptedStyleSheets = [sheet];
  // The notched arrowhead of Clui's browser icon, with the icon's bar in the notch. The margin on
  // the svg puts the tip at (2,2) exactly on the translate point.
  const arrow = make('svg', { width: '20', height: '20', viewBox: '0 0 20 20' }, [
    make('path', { d: 'M2 2 19 8.2 11.4 11.1 8.5 18.6Z', fill: '#e6e6e6', stroke: '#161617', 'stroke-width': '1.5', 'stroke-linejoin': 'round' }, [], NS),
    make('rect', { x: '-1.5', y: '-3.25', width: '3', height: '6.5', rx: '1.5', transform: 'translate(14.8 14.4) rotate(45)', fill: '#de7356', stroke: '#161617', 'stroke-width': '1' }, [], NS)
  ], NS);
  const c = make('div', { class: 'c' }, [make('span', { class: 'glow' }), arrow]);
  c.hidden = true;
  const ringEl = make('div', { class: 'ring' });
  root.append(c, ringEl);
  document.documentElement.appendChild(host);
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  let ringTimer = 0;
  window.__cluiCursor = {
    move(x, y) {
      c.hidden = false;
      c.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
      return new Promise((ok) => setTimeout(ok, reduced() ? 0 : 220));
    },
    ring(x, y) {
      const at = 'translate(' + x + 'px,' + y + 'px)';
      if (reduced()) {
        // A still mark where the click landed, since the expanding ring is motion.
        ringEl.style.transform = at;
        ringEl.style.opacity = '0.8';
        clearTimeout(ringTimer);
        ringTimer = setTimeout(() => { ringEl.style.opacity = '0'; }, 200);
        return;
      }
      ringEl.animate([{ transform: at + ' scale(0.6)' }, { transform: at + ' scale(1.6)' }], { duration: 240, easing: 'cubic-bezier(0, 0, 0.2, 1)' });
      ringEl.animate([{ opacity: 0.8 }, { opacity: 0 }], { duration: 240, easing: 'linear' });
    },
    hide() {
      c.hidden = true;
    },
    rest(on) {
      c.toggleAttribute('data-rest', !!on);
    },
    visible() {
      return !!c.isConnected && !c.hidden;
    },
    pill(target, text) {
      const el = typeof target === 'string' ? document.querySelector(target) : target;
      if (!el || !el.getBoundingClientRect) return;
      const r = el.getBoundingClientRect();
      const p = make('div', { class: 'pill' }, [make('span', { class: 'bar' }), text]);
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

export function restCursor(wc: WebContents, on: boolean): Promise<unknown> {
  return run(wc, `window.__cluiCursor?.rest(${on})`)
}

/** `target` is an expression evaluated in the isolated world, e.g. `document.activeElement`. */
export function pill(wc: WebContents, target: string, text: PillText): Promise<unknown> {
  return run(wc, `window.__cluiCursor?.pill(${target}, ${JSON.stringify(text)})`)
}
