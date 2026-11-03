// Office documents: which files are Word's own view and which glimpse, and what main's pre-flight tells the renderer.
import type { Refusal } from './files'

const OFFICE = /\.(docx|docm|doc|odt|rtf|pptx|pptm|ppt|odp)$/i
export const isOffice = (p: string): boolean => OFFICE.test(p)
/** Word's own files, which Clui lays out from their bytes. */
export const isWord = (p: string): boolean => /\.(docx|docm)$/i.test(p)
/** Files Clui lays out from macOS's conversion to HTML. */
export const isConvertedText = (p: string): boolean => /\.(odt|rtf)$/i.test(p)
/** The files Clui lays out itself. Every other Office file glimpses. */
export const laysOut = (p: string): boolean => isWord(p) || isConvertedText(p)
export const isPresentation = (p: string): boolean => /\.(pptx|pptm|ppt|odp)$/i.test(p)

/** The private copy's cap, and so the largest document Clui reads at all. */
export const OFFICE_BYTES_MAX = 100 * 1024 * 1024
/** `word/document.xml`, uncompressed: past this the layout can't keep its tasks under 50ms on this Mac. */
export const WORD_XML_MAX = 1_000_000
/** textutil's HTML for one document: past this the converted view can't keep its tasks under 50ms. */
export const TEXT_HTML_MAX = 1_000_000

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

/** What main reads from an .odt or .rtf before converting it. Only an .odt's tracked changes convert, as accepted. */
export interface TextFacts { as: 'opendocument' | 'rtf'; macros: boolean; tracked: boolean }

export type DamagedAs = 'word' | 'powerpoint' | 'opendocument' | 'rtf'

/** Why a file Clui would convert shows Quick Look's first page instead. */
export type Unconverted = { why: 'too-long'; bytes: number } | { why: 'timeout' | 'no-text' | 'tracked' }

/** A pre-flight outcome. `word` may read its bytes, `text` its conversion; `glimpse` is Quick Look's first page, with
 *  `xml` set when a Word file is too long to lay out and `convert` when a conversion didn't happen or didn't fit.
 *  `converting` marks a file macOS couldn't convert. */
export type Flight =
  | { t: 'word'; facts: WordFacts }
  | { t: 'text'; facts: TextFacts }
  | { t: 'glimpse'; macros: boolean; xml?: number; convert?: Unconverted }
  | { t: 'empty' | 'locked' }
  | { t: 'damaged'; as: DamagedAs; converting?: true }
  | { t: 'too-large'; bytes: number }
  | ({ t: 'unpacks' } & Unpacks)
/** Which bound a package's zip directory broke: its entry count, its unpacked bytes, or one entry's ratio. */
export type Unpacks = { bound: 'entries' | 'unzipped'; n: number } | { bound: 'ratio' }
/** The file at the stat revision its pre-flight read. */
export type OfficeOpen = ({ ok: true; revision: string; size: number } & Flight) | Refusal

/** textutil's HTML for one revision: the head's stylesheet text and the body's top-level elements, unparsed. */
export interface Converted { css: string; blocks: string[] }

/** Quick Look's first page as a `data:` URL, or why there's none. `unreadable`: drawn dark with dark text, as Quick
 *  Look draws some formats in Dark Mode. */
export type Glimpse = { ok: true; url: string; w: number; h: number } | { ok: false; why: 'failed' | 'changed' | 'unreadable' }
