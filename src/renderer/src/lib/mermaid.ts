import type { Mermaid, MermaidConfig } from 'mermaid'
import { DIAGRAM_NAME_MAX, DIAGRAM_SECTIONS_MAX, type BlockKeyword, type DiagramFamily, type DiagramLabel, type DiagramPart, type LineRange } from '../../../shared/context'
import { stripControls } from '../../../shared/surface-tools'

export type Theme = 'dark' | 'light'
export const themeNow = (): Theme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')

export const MAX_TEXT = 50_000
export const MAX_EDGES = 500
// Mermaid's own secure keys, then everything a %%{init}%% directive or front matter could use to bring back HTML labels,
// restyle the drawing or inject CSS.
export const SECURE = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'htmlLabels', 'flowchart', 'theme', 'themeVariables', 'themeCSS', 'darkMode', 'fontFamily', 'fontSize']

const TOKENS = ['bg', 'content', 'dim', 'faint', 'bg-raised', 'border-strong', 'tool', 'err', 'ft-blue', 'ft-cyan', 'ft-green', 'ft-yellow', 'ft-purple', 'ft-pink', 'ft-red'] as const
export type Tokens = Record<(typeof TOKENS)[number], string>
const DATA = ['ft-blue', 'ft-cyan', 'ft-green', 'ft-yellow', 'ft-purple', 'ft-pink', 'ft-red'] as const

const each = (names: string, v: string): Record<string, string> => Object.fromEntries(names.split(' ').map((n) => [n, v]))
const scale = (name: (i: number) => string, n: number, v: (i: number) => string): Record<string, string> => Object.fromEntries(Array.from({ length: n }, (_, i) => [name(i), v(i)]))

export function themeVariables(t: Tokens, dark: boolean, font: string): Record<string, string | boolean> {
  // An all-grey pie can't be read, so categories take the file-type palette; past it they're grey and the legend names them.
  const data = (i: number): string => (i < DATA.length ? t[DATA[i]] : t.dim)
  return {
    darkMode: dark,
    fontFamily: font,
    fontSize: '15px',
    ...each('background primaryColor mainBkg actorBkg edgeLabelBackground', t.bg),
    ...each(
      'primaryTextColor secondaryTextColor tertiaryTextColor textColor nodeTextColor titleColor actorTextColor signalTextColor labelTextColor loopTextColor noteTextColor taskTextColor taskTextOutsideColor pieTitleTextColor pieLegendTextColor',
      t.content
    ),
    ...each('primaryBorderColor secondaryBorderColor tertiaryBorderColor nodeBorder actorBorder noteBorderColor activationBorderColor taskBorderColor activeTaskBorderColor', t.dim),
    ...each('lineColor signalColor actorLineColor labelBoxBorderColor gridColor todayLineColor vertLineColor', t.faint),
    ...each('secondaryColor tertiaryColor clusterBkg noteBkgColor labelBoxBkgColor activationBkgColor taskBkgColor activeTaskBkgColor sectionBkgColor excludeBkgColor', t['bg-raised']),
    ...each('clusterBorder altSectionBkgColor', t['border-strong']),
    doneTaskBkgColor: t.tool,
    doneTaskBorderColor: t.faint,
    critBorderColor: t.err,
    critBkgColor: t['bg-raised'],
    sequenceNumberColor: t.bg,
    // The base theme hardcodes white and #f2f2f2 rows, which the dark theme's light text can't sit on.
    attributeBackgroundColorOdd: t.bg,
    attributeBackgroundColorEven: t['bg-raised'],
    ...scale((i) => `pie${i + 1}`, 12, data),
    ...scale((i) => `cScale${i}`, 12, data),
    ...scale((i) => `cScaleLabel${i}`, 12, () => t.bg),
    // Mermaid derives these from its own darkened scale before Clui's values land.
    ...scale((i) => `cScaleInv${i}`, 12, data),
    ...scale((i) => `cScalePeer${i}`, 12, data),
    ...scale((i) => `git${i}`, 8, data),
    ...scale((i) => `gitBranchLabel${i}`, 8, () => t.bg),
    pieSectionTextColor: t.bg,
    pieStrokeColor: t.bg,
    pieStrokeWidth: '2px',
    pieOuterStrokeColor: t['border-strong'],
    // Mermaid's default 0.7 blends each slice into the page, and the contrast of its label with it.
    pieOpacity: '1'
  }
}

export function mermaidConfig(t: Tokens, dark: boolean, font: string): MermaidConfig {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    htmlLabels: false,
    flowchart: { htmlLabels: false, useMaxWidth: false },
    suppressErrorRendering: true,
    maxTextSize: MAX_TEXT,
    maxEdges: MAX_EDGES,
    secure: SECURE,
    theme: 'base',
    darkMode: dark,
    fontFamily: font,
    fontSize: 15,
    themeVariables: themeVariables(t, dark, font)
  }
}

const NAMES: [RegExp, string][] = [
  [/^(flowchart|graph)/, 'Flowchart'],
  [/^sequence/, 'Sequence diagram'],
  [/^class/, 'Class diagram'],
  [/^state/, 'State diagram'],
  [/^er$/, 'Entity relationship diagram'],
  [/^gantt/, 'Gantt chart'],
  [/^pie/, 'Pie chart'],
  [/^mindmap/, 'Mind map'],
  [/^timeline/, 'Timeline'],
  [/^gitGraph/, 'Git graph']
]
const lum = (hex: string): number => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
/** WCAG 2 contrast of two `#rrggbb` colours. */
export const contrast = (a: string, b: string): number => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}
/** True when a label on an author's fill should take the page's ink: the theme's is under 4.5:1 on it and the
 *  page's reads better. */
export const pageInkOn = (fill: string, ink: string, page: string): boolean => contrast(ink, fill) < 4.5 && contrast(page, fill) > contrast(ink, fill)

export const typeName = (type: string): string => NAMES.find(([re]) => re.test(type))?.[1] ?? 'Diagram'

export type Failure =
  | { t: 'parse'; line: number; excerpt: string; caret: string; expecting: string }
  | { t: 'type' }
  | { t: 'size' }
  | { t: 'edges' }
  | { t: 'other'; message: string }
  | { t: 'load' }

const PARSE = /^Parse error on line (\d+):\n(.*)\n(-*\^)\n?([\s\S]*)$/
// Mermaid's own patterns: what it strips before parsing, so its error lines count what's left.
const DIRECTIVE = /%{2}{\s*(?:(\w+)\s*:|(\w+))\s*(?:(\w+)|((?:(?!}%{2}).|\r?\n)*))?\s*(?:}%{2})?/gi
const COMMENT = /^\s*%%(?!{)[^\n]+\n?/gm
const FRONT = /^[ \t]*---[ \t]*\n[\s\S]*?\n[ \t]*---[ \t]*(?:\n|$)/

/** The line of `text`, from 1, that is line `n` of what mermaid parses after dropping front matter, directives,
 *  comment lines and leading blank lines. */
export function sourceLine(text: string, n: number): number {
  const src = text.replace(/\r\n?/g, '\n')
  const fm = FRONT.exec(src)?.[0].length ?? 0
  let keep = Array.from({ length: src.length - fm }, (_, i) => i + fm)
  for (const re of [DIRECTIVE, COMMENT, /^\s+/g]) {
    const s = keep.map((i) => src[i]).join('')
    const gone = new Set<number>()
    for (const m of s.matchAll(re)) for (let k = m.index; k < m.index + m[0].length; k++) gone.add(k)
    keep = keep.filter((_, k) => !gone.has(k))
  }
  let line = 1
  for (const i of keep) {
    if (line === n) return src.slice(0, i).split('\n').length
    if (src[i] === '\n') line++
  }
  return Math.min(n, src.split('\n').length)
}

/** What a failed render says, in Clui's terms. A parse error's line is the line of `text`. */
export function failureOf(e: unknown, text: string): Failure {
  const message = String((e as Error)?.message ?? e)
  if ((e as Error)?.name === 'UnknownDiagramError') return { t: 'type' }
  if (message.startsWith('Edge limit exceeded')) return { t: 'edges' }
  const m = PARSE.exec(message)
  if (m) return { t: 'parse', line: sourceLine(text, Number(m[1])), excerpt: m[2], caret: m[3], expecting: m[4].trim() }
  return { t: 'other', message: message.slice(0, 400) }
}

// Node ids and labels, lexed from flowchart source. Longest openers first, so `((` isn't read as `(`.
const OPENERS = ['(((', '[[', '[(', '[/', '[\\', '((', '([', '{{', '@{', '[', '(', '{', '>']
const CLOSER: Record<string, string> = { '[': ']', '(': ')', '{': '}', '>': ']', '@': '}' }
const ID = /[\p{L}\p{N}_](?:[\p{L}\p{N}_]|-(?=[\p{L}\p{N}_]))*/uy

interface Seen {
  decl: Map<number, string>
  mentions: Set<number>
}

function lex(lines: readonly string[]): Map<string, Seen> {
  const out = new Map<string, Seen>()
  const seen = (id: string): Seen => {
    let s = out.get(id)
    if (!s) out.set(id, (s = { decl: new Map(), mentions: new Set() }))
    return s
  }
  for (let n = 0; n < lines.length; n++) {
    const l = lines[n]
    if (l.trimStart().startsWith('%%')) continue
    for (let i = 0; i < l.length; ) {
      const c = l[i]
      if (l.startsWith('%%', i)) break
      if (c === '"' || c === '|') {
        const end = l.indexOf(c, i + 1)
        i = end < 0 ? l.length : end + 1
        continue
      }
      if (/[-=.~]/.test(c)) {
        let j = i
        while (j < l.length && /[-=.~]/.test(l[j])) j++
        // An edge's arrowhead, so `--x B` isn't a node `x`.
        if (j - i >= 2 && /[>xo]/.test(l[j] ?? '') && !/[\p{L}\p{N}_]/u.test(l[j + 1] ?? '')) j++
        i = j
        continue
      }
      ID.lastIndex = i
      const m = /[\p{L}\p{N}_]/u.test(l[i - 1] ?? '') ? null : ID.exec(l)
      if (!m) {
        i++
        continue
      }
      const id = m[0]
      i += id.length
      const open = OPENERS.find((o) => l.startsWith(o, i))
      if (!open) {
        seen(id).mentions.add(n)
        continue
      }
      let j = i + open.length
      let label: string
      if (l[j] === '"') {
        const q = l.indexOf('"', j + 1)
        label = q < 0 ? l.slice(j + 1) : l.slice(j + 1, q)
        j = q < 0 ? l.length : q + 1
      } else {
        const close = l.indexOf(CLOSER[open[0]], j)
        const end = close < 0 ? l.length : close
        label = l.slice(j, end).replace(/[/\\)\]]+$/, '').trim()
        j = end
      }
      while (j < l.length && /[)\]}/\\]/.test(l[j])) j++
      const s = seen(id)
      if (!s.decl.has(n)) s.decl.set(n, label)
      s.mentions.add(n)
      i = j
    }
  }
  return out
}

/**
 * Flowchart nodes with a proven source line, as `sourceId` to its 0-based line in `text`: one line declares it (or,
 * undeclared, one mentions it) and its lexed label matches mermaid's. The rest stay the whole diagram's.
 */
export function nodeLines(text: string, vertices: ReadonlyMap<string, { text?: string }>): Map<string, number> {
  const src = text.replace(/\r\n?/g, '\n')
  const fm = FRONT.exec(src)?.[0].replace(/\n$/, '').split('\n').length ?? 0
  const seen = lex(src.split('\n').map((l, i) => (i < fm ? '' : l)))
  const out = new Map<string, number>()
  for (const [id, v] of vertices) {
    const s = seen.get(id)
    if (!s) continue
    const one = s.decl.size === 1 ? [...s.decl][0] : s.decl.size === 0 && s.mentions.size === 1 ? ([[...s.mentions][0], id] as const) : null
    if (one && (v.text ?? id) === one[1]) out.set(id, one[0])
  }
  return out
}

/** The source id inside a rendered node's element id, `<renderId>-flowchart-<sourceId>-<n>`. */
export const sourceIdOf = (elementId: string, renderId: string): string | null => {
  const prefix = `${renderId}-flowchart-`
  return elementId.startsWith(prefix) ? elementId.slice(prefix.length).replace(/-\d+$/, '') : null
}

/** A part of a drawn diagram. `key` is Clui's own and never sent: `n:<id>`, `g:<id>`, `e:<edgeId>`, `p:<alias>`,
 *  `m:<n>`, `t:<n>`, `b:<endN>`. `line` and `lines` are 0-based lines of the diagram's text. */
export interface Part {
  key: string
  kind: DiagramPart['kind']
  id?: string
  from?: string
  to?: string
  nth?: number
  label?: string
  fromLabel?: string
  toLabel?: string
  line?: number
  keyword?: BlockKeyword
  sections?: string[]
  lines?: LineRange
}

export const TYPEAHEAD_MS = 500

/** The typed string after `key`, which starts over once a pause runs past `TYPEAHEAD_MS`. */
export function typedAfter(t: { text: string; at: number }, key: string, now: number): { text: string; at: number } {
  return { text: now - t.at > TYPEAHEAD_MS ? key.toLowerCase() : t.text + key.toLowerCase(), at: now }
}

/**
 * The listbox type-ahead, wrapping, by label and then by id. A single character starts past `from`, so pressing a
 * letter again cycles; a longer string starts at `from`, so the option still matching keeps the focus.
 */
export function typeahead(parts: readonly Part[], from: number, text: string): number {
  const n = parts.length
  const start = text.length === 1 ? from + 1 : from
  for (const field of ['label', 'id'] as const)
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n
      if (parts[i]?.[field]?.toLowerCase().startsWith(text)) return i
    }
  return -1
}

/** The diagram types whose parts have ids that hold across renders. */
export const familyOf = (diagramType: string): DiagramFamily | null =>
  /^(flowchart|graph)/.test(diagramType) ? 'flowchart' : /^class/.test(diagramType) ? 'class' : /^state/.test(diagramType) ? 'state' : diagramType === 'er' ? 'er' : diagramType === 'sequence' ? 'sequence' : null

/** The diagram's keyword as its source writes it: the first word after front matter, directives and comments. */
export function sourceKeyword(text: string): string | null {
  const src = text.replace(/\r\n?/g, '\n').replace(FRONT, '').replace(DIRECTIVE, '').replace(COMMENT, '')
  return /^\s*([A-Za-z][\w-]{0,39})(?![\w-])/.exec(src)?.[1] ?? null
}

const clip = (s: string, n: number): string => {
  const cp = [...stripControls(s).replace(/\s+/g, ' ').trim()]
  return cp.length > n ? `${cp.slice(0, n - 1).join('')}…` : cp.join('')
}
const LABEL_CLIP = 80
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The diagram's lines as the proofs read them: front matter blanked, so indices stay the text's. */
function proofLines(text: string): string[] {
  const src = text.replace(/\r\n?/g, '\n')
  const fm = FRONT.exec(src)?.[0].replace(/\n$/, '').split('\n').length ?? 0
  return src.split('\n').map((l, i) => (i < fm ? '' : l))
}
const comment = (l: string): boolean => l.trimStart().startsWith('%%')

/** The one line that `re` matches outside `%%` comments, or undefined for none or several. */
function onlyLine(lines: readonly string[], re: RegExp): number | undefined {
  let at: number | undefined
  for (let i = 0; i < lines.length; i++) {
    if (comment(lines[i]) || !re.test(lines[i])) continue
    if (at !== undefined) return undefined
    at = i
  }
  return at
}

const DECLARES: Record<Exclude<DiagramFamily, 'sequence'>, Partial<Record<'node' | 'group', (id: string) => RegExp>>> = {
  flowchart: { group: (id) => new RegExp(`^\\s*subgraph\\s+${id}(?=[\\s\\[]|$)`) },
  class: { node: (id) => new RegExp(`^\\s*class\\s+${id}\\b`), group: (id) => new RegExp(`^\\s*namespace\\s+${id}\\b`) },
  state: { node: (id) => new RegExp(`^\\s*state\\s+(?:"[^"]*"\\s+as\\s+)?${id}\\b`), group: (id) => new RegExp(`^\\s*state\\s+(?:"[^"]*"\\s+as\\s+)?${id}\\b`) },
  er: { node: (id) => new RegExp(`^\\s*${id}\\s*(?:\\[[^\\]]*\\])?\\s*\\{`) }
}

type Db = Record<string, unknown>
const call = <T>(db: Db, name: string): T | undefined => (typeof db[name] === 'function' ? (db[name] as () => T).call(db) : undefined)
const labelOf = (text: unknown, id?: string): { label?: string } => {
  const l = typeof text === 'string' ? clip(text, LABEL_CLIP) : ''
  return l && l !== id ? { label: l } : {}
}
const counter = (): ((k: string) => number) => {
  const seen = new Map<string, number>()
  return (k) => {
    const n = seen.get(k) ?? 0
    seen.set(k, n + 1)
    return n
  }
}

/**
 * The parts of a diagram, from mermaid's parsed `db` and never from the drawing, in the order the keyboard and the
 * wire use. `nodes` is the flowchart's `nodeLines`. Null when the db doesn't have the shape this version of mermaid
 * gives it, which makes the diagram an area type.
 */
export function partsOf(family: DiagramFamily, db: unknown, text: string, nodes: ReadonlyMap<string, number> = new Map()): Part[] | null {
  if (!db || typeof db !== 'object') return null
  const lines = proofLines(text)
  const parts = family === 'sequence' ? sequenceParts(db as Db, lines) : graphParts(family, db as Db, lines, nodes)
  if (!parts) return null
  const drawn = new Map<string, string>()
  for (const p of parts) if (p.id && p.label && !drawn.has(p.id)) drawn.set(p.id, p.label)
  for (const p of parts) {
    if (p.kind !== 'edge' && p.kind !== 'message') continue
    const from = drawn.get(p.from!)
    const to = drawn.get(p.to!)
    if (from) p.fromLabel = from
    if (to) p.toLabel = to
  }
  return parts
}

interface GraphNode { id: string; label?: unknown; isGroup?: boolean; shape?: string }
interface GraphEdge { id: string; start: string; end: string; label?: unknown }
// Drawn but not parts: notes, and the bars between a state's concurrent regions.
const NOT_PARTS = new Set(['note', 'divider'])

function graphParts(family: Exclude<DiagramFamily, 'sequence'>, db: Db, lines: readonly string[], nodes: ReadonlyMap<string, number>): Part[] | null {
  const data = call<{ nodes?: GraphNode[]; edges?: GraphEdge[] }>(db, 'getData')
  if (!Array.isArray(data?.nodes) || !Array.isArray(data.edges)) return null
  // A db node id to its source id; ER's nodes are `entity-<NAME>-<i>`.
  const source = new Map<string, string>()
  if (family === 'er') {
    const ents = call<Map<string, { id: string }>>(db, 'getEntities')
    if (!(ents instanceof Map)) return null
    for (const [name, e] of ents) source.set(e.id, name)
  }
  const out: Part[] = []
  const keys = new Set<string>()
  for (const n of data.nodes) {
    if (family === 'state' && (n.shape === 'stateStart' || n.shape === 'stateEnd')) {
      source.set(n.id, '[*]')
      continue
    }
    if (NOT_PARTS.has(n.shape ?? '')) continue
    const id = family === 'er' ? source.get(n.id) : n.id
    if (!id) continue
    source.set(n.id, id)
    const kind = n.isGroup ? 'group' : 'node'
    const key = `${kind === 'group' ? 'g' : 'n'}:${id}`
    if (keys.has(key)) continue
    keys.add(key)
    const declares = DECLARES[family][kind]
    const line = family === 'flowchart' && kind === 'node' ? nodes.get(id) : declares ? onlyLine(lines, declares(esc(id))) : undefined
    out.push({ key, kind, id, ...labelOf(n.label, id), ...(line === undefined ? {} : { line }) })
  }
  const nth = counter()
  for (const e of data.edges) {
    const from = source.get(e.start)
    const to = source.get(e.end)
    if (!from || !to || keys.has(`e:${e.id}`)) continue
    keys.add(`e:${e.id}`)
    out.push({ key: `e:${e.id}`, kind: 'edge', from, to, nth: nth(`${from}\0${to}`), ...labelOf(e.label) })
  }
  return out
}

interface Message { id: string | number; type: number; from?: string; to?: string; message?: unknown }
/** Sequence `db.LINETYPE` on mermaid 12.2.0. `rect` (22) pushes and pops like a block but isn't one. */
const OPENS: Record<number, BlockKeyword | null> = { 10: 'loop', 12: 'alt', 15: 'opt', 19: 'par', 27: 'critical', 30: 'break', 32: 'par', 22: null }
const CLOSES: Record<number, number> = { 10: 11, 12: 14, 15: 16, 19: 21, 32: 21, 27: 29, 30: 31, 22: 23 }
const SECTIONS = new Set([13, 20, 28])
const ENDS = new Set(Object.values(CLOSES))
// Notes, activations and autonumber ride in the same list without being messages.
const NOT_MESSAGES = new Set([2, 17, 18, 26])
const isControl = (t: number): boolean => t in OPENS || SECTIONS.has(t) || ENDS.has(t)
const textOf = (m: Message): string => (typeof m.message === 'string' ? m.message : '')

function sequenceParts(db: Db, lines: readonly string[]): Part[] | null {
  const actors = call<Map<string, { description?: unknown }>>(db, 'getActors')
  const msgs = call<Message[]>(db, 'getMessages')
  if (!(actors instanceof Map) || !Array.isArray(msgs)) return null
  const out: Part[] = []
  for (const [alias, a] of actors) {
    const line = onlyLine(lines, new RegExp(`^\\s*(participant|actor)\\s+${esc(alias)}(?=\\s|$)`))
    out.push({ key: `p:${alias}`, kind: 'participant', id: alias, ...labelOf(a.description, alias), ...(line === undefined ? {} : { line }) })
  }
  const items: { at: number; part: Part }[] = []
  const stack: { at: number; type: number; keyword: BlockKeyword | null; label: string; sections: string[] }[] = []
  const messageNth = counter()
  const noteNth = counter()
  let balanced = true
  msgs.forEach((m, at) => {
    const id = String(m.id)
    if (m.type in OPENS) return void stack.push({ at, type: m.type, keyword: OPENS[m.type], label: clip(textOf(m), LABEL_CLIP), sections: [] })
    if (SECTIONS.has(m.type)) {
      const top = stack.at(-1)
      if (!top) balanced = false
      else if (top.sections.length < DIAGRAM_SECTIONS_MAX) top.sections.push(clip(textOf(m), LABEL_CLIP))
      return
    }
    if (ENDS.has(m.type)) {
      const top = stack.pop()
      if (!top || CLOSES[top.type] !== m.type) return void (balanced = false)
      if (!top.keyword) return
      const sections = top.sections.filter(Boolean)
      items.push({ at: top.at, part: { key: `b:${id}`, kind: 'block', keyword: top.keyword, ...(top.label ? { label: top.label } : {}), ...(sections.length ? { sections } : {}) } })
      return
    }
    if (m.type === 2) {
      const label = clip(textOf(m), LABEL_CLIP)
      if (label) items.push({ at, part: { key: `t:${id}`, kind: 'note', label, nth: noteNth(label) } })
      return
    }
    if (NOT_MESSAGES.has(m.type) || !m.from || !m.to) return
    items.push({ at, part: { key: `m:${id}`, kind: 'message', from: m.from, to: m.to, nth: messageNth(`${m.from}\0${m.to}`), ...labelOf(m.message) } })
  })
  if (stack.length) balanced = false
  items.sort((a, b) => a.at - b.at)
  const spans = balanced ? blockLines(lines, msgs) : null
  const blockNth = counter()
  for (const { part } of items) {
    if (part.kind === 'block') {
      if (!balanced) continue
      part.nth = blockNth(`${part.keyword}\0${part.label ?? ''}`)
      const l = spans?.get(part.key.slice(2))
      if (l) part.lines = l
    }
    out.push(part)
  }
  return out
}

const OPENER = /^\s*(loop|alt|opt|par|par_over|critical|break|rect|box)\b\s*(.*)$/
const SECTION = /^\s*(else|and|option)\b\s*(.*)$/
const END = /^\s*end\s*$/
const OPEN_TYPE: Record<string, number> = { loop: 10, alt: 12, opt: 15, par: 19, par_over: 32, critical: 27, break: 30, rect: 22 }
const SECTION_TYPE: Record<string, number> = { else: 13, and: 20, option: 28 }
const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

/**
 * Each block's opening and `end` lines, by the END message's id, when the source's block keywords line up one to one
 * with the db's control messages, text included. Null otherwise: one miscount would shift every later block.
 */
export function blockLines(lines: readonly string[], msgs: readonly Message[]): Map<string, LineRange> | null {
  const tokens: { type: number; text: string; line: number }[] = []
  const open: { type: number | 'box' }[] = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (comment(l)) continue
    let m: RegExpExecArray | null
    if ((m = OPENER.exec(l))) {
      if (m[1] === 'box') open.push({ type: 'box' })
      else {
        open.push({ type: OPEN_TYPE[m[1]] })
        tokens.push({ type: OPEN_TYPE[m[1]], text: collapse(m[2]), line: i })
      }
    } else if ((m = SECTION.exec(l))) tokens.push({ type: SECTION_TYPE[m[1]], text: collapse(m[2]), line: i })
    else if (END.test(l)) {
      const top = open.pop()
      if (!top) return null
      if (top.type !== 'box') tokens.push({ type: CLOSES[top.type], text: '', line: i })
    }
  }
  const control = msgs.filter((m) => isControl(m.type))
  if (open.length || control.length !== tokens.length) return null
  const out = new Map<string, LineRange>()
  const starts: number[] = []
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]
    const m = control[k]
    if (m.type !== t.type) return null
    if (ENDS.has(t.type)) {
      const start = starts.pop()
      if (start === undefined) return null
      out.set(String(m.id), { start, end: t.line })
    } else {
      if (collapse(textOf(m)) !== t.text) return null
      if (t.type in OPENS) starts.push(t.line)
    }
  }
  return out
}

/** A part as the wire carries it, its lines made the file's by `firstLine`. */
export function wirePart(p: Part, firstLine: number): DiagramPart {
  const label = p.label ? { label: p.label } : {}
  switch (p.kind) {
    case 'node':
    case 'group':
    case 'participant':
      return { kind: p.kind, id: p.id!, ...label, ...(p.line === undefined ? {} : { line: firstLine + p.line }) }
    case 'edge':
    case 'message':
      return { kind: p.kind, from: p.from!, to: p.to!, nth: p.nth!, ...label, ...(p.fromLabel ? { fromLabel: p.fromLabel } : {}), ...(p.toLabel ? { toLabel: p.toLabel } : {}) }
    case 'note':
      return { kind: 'note', label: p.label!, nth: p.nth! }
    case 'block':
      return {
        kind: 'block',
        keyword: p.keyword!,
        ...label,
        nth: p.nth!,
        ...(p.sections ? { sections: p.sections } : {}),
        ...(p.lines ? { lines: { start: firstLine + p.lines.start, end: firstLine + p.lines.end } } : {})
      }
  }
}

/** A `<text>` or `foreignObject` the drawing shows, its box in screen pixels from the drawing's top left. */
export interface LabelCandidate { text: string; x: number; y: number; w: number; h: number; shown: boolean }
export interface Box { x: number; y: number; w: number; h: number }
const TOLERANCE = 2

/** The texts drawn inside `area`, once each where a label is drawn twice in one place, in reading order. */
export function labelsIn(cands: readonly LabelCandidate[], area: Box): string[] {
  const kept: (LabelCandidate & { cx: number; cy: number })[] = []
  for (const c of cands) {
    const text = collapse(c.text)
    if (!c.shown || c.w <= 0 || c.h <= 0 || !text) continue
    if (c.x < area.x - TOLERANCE || c.y < area.y - TOLERANCE || c.x + c.w > area.x + area.w + TOLERANCE || c.y + c.h > area.y + area.h + TOLERANCE) continue
    const cx = c.x + c.w / 2
    const cy = c.y + c.h / 2
    if (kept.some((k) => k.text === text && Math.abs(k.cx - cx) <= TOLERANCE && Math.abs(k.cy - cy) <= TOLERANCE)) continue
    kept.push({ ...c, text, cx, cy })
  }
  const row = (c: LabelCandidate): number => Math.round(c.y / 4)
  return kept.sort((a, b) => row(a) - row(b) || a.x - b.x).map((c) => c.text)
}

/**
 * Each label with the 0-based line of the text that holds it as a whole word, when exactly one line does. Generated
 * text (an axis date, a percentage) and a label written on two lines get none.
 */
export function labelLines(text: string, labels: readonly string[]): { text: string; line?: number }[] {
  const lines = proofLines(text)
  return labels.map((t) => {
    const line = onlyLine(lines, new RegExp(`(?<![\\p{L}\\p{N}_])${esc(t)}(?![\\p{L}\\p{N}_])`, 'u'))
    return { text: clip(t, DIAGRAM_NAME_MAX), ...(line === undefined ? {} : { line }) }
  })
}

/** An area's labels as the wire carries them, their lines made the file's by `firstLine`. */
export const wireLabels = (text: string, labels: readonly string[], firstLine: number): DiagramLabel[] =>
  labelLines(text, labels).map((l) => (l.line === undefined ? { text: l.text } : { text: l.text, line: firstLine + l.line }))

export interface Drawn {
  svg: string
  id: string
  type: string
  /** The keyword the source opens with, which a reference names its type by. */
  keyword: string
  nodes: ReadonlyMap<string, number>
  /** Null on a type without stable ids, or when its reparse failed: the drawing then selects areas. */
  parts: readonly Part[] | null
}
export type Outcome = { ok: true; drawn: Drawn } | { ok: false; why: Failure }

// Everything below runs only in the renderer.

let loading: Promise<Mermaid> | null = null
/** The probe slows or fails the chunk through `load`, and `forget` drops a finished load. */
export const mermaidTestHooks = {
  load: (): Promise<Mermaid> => import('mermaid').then((m) => m.default),
  forget: (): void => void (loading = null)
}
const load = (): Promise<Mermaid> => {
  loading ??= mermaidTestHooks.load().catch((e: unknown) => {
    loading = null
    throw e
  })
  return loading
}

let ctx: CanvasRenderingContext2D | null = null
/** Any CSS colour as `#rrggbb`, painted to get real sRGB bytes: computed styles can be `oklab()` or `color-mix()`. */
export function hexOf(css: string): string {
  ctx ??= Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true })!
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = css
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')}`
}

// Mermaid's colour math reads only hex and rgb.
const tokenCache: Partial<Record<Theme, Tokens>> = {}
/** The theme's tokens as hex. Read while that theme is the document's. */
export function tokensFor(theme: Theme): Tokens {
  const hit = tokenCache[theme]
  if (hit) return hit
  const probe = document.createElement('span')
  probe.hidden = true
  document.body.append(probe)
  const t = Object.fromEntries(
    TOKENS.map((n) => {
      probe.style.color = `var(--color-${n})`
      return [n, hexOf(getComputedStyle(probe).color)]
    })
  ) as Tokens
  probe.remove()
  return (tokenCache[theme] = t)
}

const CACHE_MAX = 32
const cache = new Map<string, Outcome>()
const keyOf = (text: string, theme: Theme): string => `${theme}\0${text}`
let inited: Theme | null = null
let seq = 0

export const cached = (text: string, theme: Theme): Outcome | undefined => cache.get(keyOf(text, theme))

async function draw(text: string, theme: Theme): Promise<Outcome> {
  const key = keyOf(text, theme)
  const hit = cache.get(key)
  if (hit) return hit
  // Over the cap mermaid draws its own placeholder diagram instead of failing.
  if (text.length > MAX_TEXT) return { ok: false, why: { t: 'size' } }
  let m: Mermaid
  try {
    m = await load()
  } catch {
    return { ok: false, why: { t: 'load' } }
  }
  if (inited !== theme) {
    const font = getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim()
    m.initialize(mermaidConfig(tokensFor(theme), theme === 'dark', font))
    inited = theme
  }
  const id = `mmd-${++seq}`
  const start = performance.now()
  let out: Outcome
  try {
    const { svg, diagramType } = await m.render(id, text)
    let nodes: ReadonlyMap<string, number> = new Map()
    let parts: Part[] | null = null
    const family = familyOf(diagramType)
    if (family) {
      const db = (await m.mermaidAPI.getDiagramFromText(text).catch(() => null))?.db as { getVertices?: () => Map<string, { text?: string }> } | undefined
      const vertices = family === 'flowchart' ? db?.getVertices?.() : undefined
      if (vertices) nodes = nodeLines(text, vertices)
      try {
        parts = partsOf(family, db, text, nodes)
      } catch {
        parts = null
      }
    }
    out = { ok: true, drawn: { svg, id, type: diagramType, keyword: sourceKeyword(text) ?? 'diagram', nodes, parts } }
  } catch (e) {
    out = { ok: false, why: failureOf(e, text) }
  }
  performance.measure('mmd-draw', { start })
  cache.delete(key)
  cache.set(key, out)
  for (const k of cache.keys()) {
    if (cache.size <= CACHE_MAX) break
    cache.delete(k)
  }
  return out
}

export interface Job {
  readonly text: string
  readonly theme: Theme
  /** In or near view, so it draws before the rest. */
  near: boolean
  cancelled: boolean
  readonly order: number
  readonly done: (o: Outcome) => void
}

// Mermaid isn't reentrant, so one render runs at a time.
const queue: Job[] = []
let running = false
let order = 0

async function pump(): Promise<void> {
  if (running) return
  running = true
  try {
    while (queue.length) {
      let i = queue.findIndex((j) => j.near)
      if (i < 0) i = queue.reduce((b, j, k) => (j.order < queue[b].order ? k : b), 0)
      const [job] = queue.splice(i, 1)
      await new Promise((r) => setTimeout(r, 0))
      if (job.cancelled) continue
      const out = await draw(job.text, job.theme)
      if (!job.cancelled) job.done(out)
    }
  } finally {
    running = false
  }
}

export function enqueue(text: string, theme: Theme, near: boolean, done: (o: Outcome) => void): Job {
  const job: Job = { text, theme, near, cancelled: false, order: order++, done }
  queue.push(job)
  void pump()
  return job
}

export function cancel(job: Job): void {
  job.cancelled = true
  const i = queue.indexOf(job)
  if (i >= 0) queue.splice(i, 1)
}
