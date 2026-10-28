import type { DraftVisual, RefInput } from './context'

/** What the user pointed at on a page, read in Clui's annotate world. Every string is page content. */
export interface AnnotateTarget {
  tag: string
  /** Null when the element has no role worth naming (a generic div or span). */
  role: string | null
  name: string
  text: string
  selector: string
  bbox: { x: number; y: number; width: number; height: number }
  styles: Record<string, string>
  html: string
  url: string
}

/** A local page's element. Its URL is the page's capability host, which never leaves main. */
export type PageTarget = Omit<AnnotateTarget, 'url'>

/** Where pointing runs: a browser tab, or the HTML view of a pane tab's page Preview. */
export type PointAt = { kind: 'browser'; tab: number } | { kind: 'html'; viewId: string }

/** A renderer's PointAt, checked at the IPC boundary. */
export function isPoint(x: unknown): x is PointAt {
  const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>
  if (o.kind === 'browser') return Number.isSafeInteger(o.tab) && (o.tab as number) > 0
  return o.kind === 'html' && typeof o.viewId === 'string' && o.viewId.length > 0 && o.viewId.length <= 64
}

export const samePoint = (a: PointAt | null, b: PointAt | null): boolean =>
  !!a && !!b && (a.kind === 'browser' ? b.kind === 'browser' && a.tab === b.tab : b.kind === 'html' && a.viewId === b.viewId)

export type PinInput = Extract<RefInput, { kind: 'browser' | 'page' }>

export type AnnotateEvent =
  | { type: 'on'; at: PointAt }
  /** `esc`: the user pressed Escape in the page. `driving`: Claude started using the tab. `away`: the tab
   *  or page stopped being the viewed one or closed. */
  | { type: 'off'; why: 'user' | 'esc' | 'driving' | 'away' }
  | { type: 'pinned'; pinId: number; ref: PinInput; crop: DraftVisual | null }
  | { type: 'refused'; why: 'password' | 'cap' | 'failed' }
  /** The tab's document is gone: cross-document navigation, close, suspend or renderer crash. */
  | { type: 'gone'; tab: number; reason: 'navigated' | 'closed' }

const NAME_MAX = 32

/** The chip's words: the role and accessible name, else the tag and its text. */
export function pinWords(t: PageTarget): { kind: string; name: string } {
  return t.name ? { kind: t.role ?? t.tag, name: t.name } : { kind: t.tag, name: t.text }
}

export const clipName = (s: string): string => (s.length > NAME_MAX ? `${s.slice(0, NAME_MAX - 1)}…` : s)

/** What a sent message keeps of each pin, read back from its tag so a resumed transcript shows the same chips. */
export interface SentPin { n: number; kind: string; name: string; host: string; crop: boolean }

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}
