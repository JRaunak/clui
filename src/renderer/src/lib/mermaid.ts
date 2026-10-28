import type { Mermaid, MermaidConfig } from 'mermaid'

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

export interface Drawn {
  svg: string
  id: string
  type: string
  nodes: ReadonlyMap<string, number>
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
    if (/^flowchart|^graph/.test(diagramType)) {
      const db = (await m.mermaidAPI.getDiagramFromText(text).catch(() => null))?.db as { getVertices?: () => Map<string, { text?: string }> } | undefined
      const vertices = db?.getVertices?.()
      if (vertices) nodes = nodeLines(text, vertices)
    }
    out = { ok: true, drawn: { svg, id, type: diagramType, nodes } }
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
