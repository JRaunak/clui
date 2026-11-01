// Office documents: which files are Word's own view and which glimpse, and what main's pre-flight tells the renderer.
import type { Refusal } from './files'

const OFFICE = /\.(docx|docm|doc|odt|rtf|pptx|pptm|ppt|odp)$/i
export const isOffice = (p: string): boolean => OFFICE.test(p)
/** The files Clui lays out itself. Every other Office file glimpses. */
export const isWord = (p: string): boolean => /\.(docx|docm)$/i.test(p)
export const isPresentation = (p: string): boolean => /\.(pptx|pptm|ppt|odp)$/i.test(p)

/** The private copy's cap, and so the largest document Clui reads at all. */
export const OFFICE_BYTES_MAX = 100 * 1024 * 1024
/** `word/document.xml`, uncompressed: past this the layout can't keep its tasks under 50ms on this Mac. */
export const WORD_XML_MAX = 1_000_000

export type NotePart = 'footnotes' | 'endnotes'
export type WordPart = 'body' | NotePart

/** What main reads from a .docx before the renderer gets a byte. Counts never come from the renderer. */
export interface WordFacts {
  macros: boolean
  /** A relationship to something outside the package other than a hyperlink. */
  links: boolean
  strict: boolean
  /** Per part, so a reference says whether its own part reads tracked changes as accepted. */
  tracked: Partial<Record<WordPart, true>>
  comments: number
  /** Charts and diagrams without a fallback picture; embedded objects always. */
  charts: number
  diagrams: number
  objects: number
  fonts: boolean
  /** docx-preview's paragraph class for a style, to its heading level. */
  headings: Record<string, number>
  /** One per picture docx-preview draws, in order: its description, '' when decorative, null when it has none. */
  pictures: Record<WordPart, (string | null)[]>
  /** The body's note references in order; `custom` when the author typed the mark. */
  notes: { part: NotePart; custom: boolean }[]
}

export type DamagedAs = 'word' | 'powerpoint' | 'opendocument' | 'rtf'

/** A pre-flight outcome. `word` may read its bytes; `glimpse` is Quick Look's first page, with `xml` set when a Word
 *  file is too long to lay out. */
export type Flight =
  | { t: 'word'; facts: WordFacts }
  | { t: 'glimpse'; macros: boolean; xml?: number }
  | { t: 'empty' | 'locked' }
  | { t: 'damaged'; as: DamagedAs }
  | { t: 'too-large'; bytes: number }
  | ({ t: 'unpacks' } & Unpacks)
/** Which bound a package's zip directory broke: its entry count, its unpacked bytes, or one entry's ratio. */
export type Unpacks = { bound: 'entries' | 'unzipped'; n: number } | { bound: 'ratio' }
/** The file at the stat revision its pre-flight read. */
export type OfficeOpen = ({ ok: true; revision: string; size: number } & Flight) | Refusal

/** Quick Look's first page as a `data:` URL, or why there's none. */
export type Glimpse = { ok: true; url: string; w: number; h: number } | { ok: false; why: 'failed' | 'changed' }
