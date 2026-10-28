import type { Refusal } from './files'

export const isHtml = (p: string): boolean => /\.html?$/i.test(p)

/** What a page may load: an artifact's `remote` and `data` are the settings when its view was made; any other
 *  page runs offline, so both are false. */
export interface HtmlPolicy {
  artifact: boolean
  remote: boolean
  data: boolean
}

/** `changedSince`: an artifact whose bytes aren't Claude's last write. Main hasn't loaded it; htmlReload runs it. */
export type HtmlOpenResult = { ok: true; viewId: string; policy: HtmlPolicy; changedSince: boolean } | Refusal

/** CSP refusals in one load generation. `hosts` are the distinct origins in first-seen order, at most 50, 'self' for the page's own. */
export interface HtmlBlocked {
  remote: number
  data: number
  eval: boolean
  hosts: string[]
}

export type LinkVia = 'pointer' | 'keyboard'

/** The page document's scroll, in CSS px. */
export interface PagePlace {
  x: number
  y: number
}
/** Where a fresh load starts: an element id, or a saved place. */
export type PageStart = { anchor: string } | PagePlace

/** Every event names its view; one from a view the renderer no longer holds is stale. */
export type HtmlViewEvent =
  /** The document is parsed: the view can be shown. A new generation starts with every main-frame load. */
  | { type: 'dom-ready'; viewId: string; generation: number }
  /** `name` is Chromium's error name. */
  | { type: 'load-failed'; viewId: string; code: number; name: string }
  | { type: 'crashed'; viewId: string; reason: string }
  | { type: 'unresponsive'; viewId: string }
  | { type: 'responsive'; viewId: string }
  /** Debounced 500ms after the load finishes and after each later refusal. */
  | ({ type: 'blocked'; viewId: string; generation: number } & HtmlBlocked)
  /** The page or a file next to it changed. `byClaude`: every changed file is now exactly Claude's last write. */
  | { type: 'changed'; viewId: string; byClaude: boolean }
  /** The page file is gone; main has destroyed the view and revoked its cap. */
  | { type: 'missing'; viewId: string }
  | { type: 'still'; viewId: string; still: string }
  /** The document's scroll after the user's input settled, when it moved. */
  | ({ type: 'place'; viewId: string } & PagePlace)
  /** A user's link activation in the page, already checked as http(s); the renderer routes it like any link. `meta`: ⌘ was held. */
  | { type: 'link'; viewId: string; url: string; meta: boolean }
  /** A user's activation of a link to a file: `href` is relative to the page's folder with any climb above it kept, or a `file:` URL as written. */
  | { type: 'file-link'; viewId: string; href: string; meta: boolean; via: LinkVia }
  /** The artifact settings changed and main recreated the view under `policy`, loading it again if it had run. */
  | { type: 'recreated'; viewId: string; policy: HtmlPolicy }
