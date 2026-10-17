import type { DraftVisual, PagePin } from './context'

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


export type AnnotateEvent =
  | { type: 'on'; tab: number }
  /** `esc`: the user pressed Escape in the page. `driving`: Claude started using the tab. `away`: the tab
   *  stopped being the viewed one or closed. */
  | { type: 'off'; why: 'user' | 'esc' | 'driving' | 'away' }
  | { type: 'pinned'; pinId: number; pin: PagePin; crop: DraftVisual | null }
  | { type: 'refused'; why: 'password' | 'cap' | 'failed' }
  /** The tab's document is gone: cross-document navigation, close, suspend or renderer crash. */
  | { type: 'gone'; tab: number; reason: 'navigated' | 'closed' }

const NAME_MAX = 32

/** The chip's words: the role and accessible name, else the tag and its text. */
export function pinWords(t: AnnotateTarget): { kind: string; name: string } {
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
