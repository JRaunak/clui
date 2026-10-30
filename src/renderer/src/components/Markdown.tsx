/**
 * Markdown renderer for assistant output.
 *
 * react-markdown + remark-gfm (tables, task lists, strikethrough, autolinks), with custom
 * renderers so code blocks get highlight.js syntax highlighting + a hover copy button, and
 * links open in the user's browser (never navigate the app window).
 *
 * Streaming-safe: assistant text arrives token-by-token, so the markdown is routinely
 * incomplete mid-turn (an unclosed fence, a half-written table). react-markdown simply
 * renders whatever currently parses, and the highlighter is wrapped in try/catch, so a
 * partial document never throws.
 */
import { Children, cloneElement, createContext, createElement, Fragment, isValidElement, memo, useCallback, useContext, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toJsxRuntime, type Components as JsxComponents } from 'hast-util-to-jsx-runtime'
import { urlAttributes } from 'html-url-attributes'
import type { Element, ElementContent, RootContent } from 'hast'
import hljs from '../lib/hljs'
import { IconCopy, IconCheck, IconImage, IconTarget } from './Icon'
import { fileLinkTitle, LINK, linkHandlers, linkTitle, openFileLink, useLinkTarget, type LinkRoot } from '../lib/openLink'
import { isLocalHref, listedIn, resolveCode, resolveHref, type FileRef } from '../lib/fileLinks'
import { spanAttr, textOf, type Span } from '../lib/markdownDoc'
import { viaOf, type Via } from '../lib/motion'
import { useActive } from '../store'
import { IMAGE_PATHS_MAX, type ImageCap } from '../../../shared/files'
import { parseUsageReport, UsageCard, parseContextReport, ContextCard } from './CommandOutput'
import { MermaidDiagram } from './Mermaid'

type Highlighted = { html: string; used: string | null }

/** True inside the message that is still streaming. */
export const StreamingContext = createContext(false)
/** Set only for a completed assistant message, so a path half-written mid-stream never links. */
export const FileLinkContext = createContext<LinkRoot | null>(null)

const CODE_CHIP = 'rounded bg-bg-raised px-1 py-0.5 font-mono text-[0.9em] text-content'

// Local hrefs get past the default's scheme allowlist; the `a` renderer links only what resolves inside the session's folder.
const urlTransform: UrlTransform = (url, key) => (key === 'href' && isLocalHref(url) ? url : defaultUrlTransform(url))

const PLAIN_CHARS = 4000
const PLAIN_LINES = 60

/** The transcript remounts its rows on every session switch, and auto-detect runs every
 *  registered grammar over a block, so a big untagged block costs hundreds of ms each time it
 *  mounts. */
const highlightCache = new Map<string, Highlighted>()
let cachedChars = 0
const CACHE_CHARS = 8_000_000

function highlight(code: string, lang: string | null, streaming: boolean): Highlighted {
  // Without a known grammar, auto-detect guesses wrong on long output, and mid-stream its guess
  // changes with every token, so those blocks stay plain.
  const known = !!lang && !!hljs.getLanguage(lang)
  if (!known && (streaming || code.length > PLAIN_CHARS || code.split('\n').length > PLAIN_LINES)) {
    return { html: escapeHtml(code), used: null }
  }
  // Every streamed prefix is a new key, and they would push finished blocks out of the cache.
  if (streaming) return highlightUncached(code, lang)
  const key = `${lang ?? ''}\u0000${code}`
  const hit = highlightCache.get(key)
  if (hit) return hit
  const out = highlightUncached(code, lang)
  highlightCache.set(key, out)
  cachedChars += key.length + out.html.length
  for (const [k, v] of highlightCache) {
    if (cachedChars <= CACHE_CHARS) break
    highlightCache.delete(k)
    cachedChars -= k.length + v.html.length
  }
  return out
}

/** Highlight to an HTML string, defensively. Unknown/absent language triggers auto-detect;
 *  any grammar error falls back to plain (escaped) text so a stream never breaks. */
function highlightUncached(code: string, lang: string | null): Highlighted {
  try {
    if (lang && hljs.getLanguage(lang)) {
      return { html: hljs.highlight(code, { language: lang }).value, used: lang }
    }
    // No/unknown language (common while streaming a bare fence): let hljs guess.
    const auto = hljs.highlightAuto(code)
    return { html: auto.value, used: auto.language ?? null }
  } catch {
    return { html: escapeHtml(code), used: null }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
}

/** `label` names the block instead of its language. */
export function CodeBlock({ code, lang, label: named }: { code: string; lang: string | null; label?: string }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const { html, used } = highlight(code, lang, useContext(StreamingContext))
  // The author's tag names the block even when highlight.js has no grammar for it.
  const label = named ?? (lang && !hljs.getLanguage(lang) ? lang : (used ?? 'text'))
  const onCopy = useCallback(() => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [code])

  return (
    <div className="group relative my-2 overflow-hidden rounded-md border border-border bg-tool">
      <div data-find-skip="" className="flex items-center justify-between border-b border-border/60 px-3 py-1">
        <span className="font-mono text-meta text-faint">
          {label}
        </span>
        {/* Persistent at-rest affordance (opacity-60), brightening on hover/focus. A hover-only
            copy button is undiscoverable and unreachable by a keyboard scan of visible controls. */}
        <button
          onClick={onCopy}
          className="flex min-h-6 items-center gap-1 rounded px-1.5 py-0.5 text-meta text-dim transition-colors hover:text-content"
          title="Copy code"
        >
          {copied ? (
            <>
              <IconCheck className="h-3 w-3" /> Copied
            </>
          ) : (
            <>
              <IconCopy className="h-3 w-3" /> Copy
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 text-xs leading-relaxed">
        <code
          className="hljs font-mono"
          // Highlighted HTML is produced by highlight.js from the code string only (no user
          // HTML is interpreted; react-markdown never passes raw HTML here).
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </pre>
    </div>
  )
}

function childrenToText(children: React.ReactNode): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map(childrenToText).join('')
  if (children && typeof children === 'object' && 'props' in children) {
    const props = (children as { props?: { children?: React.ReactNode } }).props
    return childrenToText(props?.children)
  }
  return ''
}

const COMPONENTS: Components = {
  code({ className, children, ...props }) {
    const root = useContext(FileLinkContext)
    const text = childrenToText(children)
    const match = /language-(\w+)/.exec(className || '')
    // react-markdown v10 dropped the inline flag; treat as a block if it has a language
    // class or spans multiple lines (catches a fenced block with no lang).
    const isBlock = Boolean(match) || text.includes('\n')
    if (isBlock) {
      return <CodeBlock code={text.replace(/\n$/, '')} lang={match ? match[1] : null} />
    }
    const at = root?.ws ? resolveCode(text, root.cwd, root.ws) : null
    if (root && at) {
      return (
        <FileLink root={root} at={at} className={`${CODE_CHIP} underline decoration-[var(--color-dim)] underline-offset-2 pointer-fine:hover:decoration-[var(--color-content)]`}>
          <code {...props}>{children}</code>
        </FileLink>
      )
    }
    return (
      <code className={CODE_CHIP} {...props}>
        {children}
      </code>
    )
  },
  a({ href, children }) {
    const root = useContext(FileLinkContext)
    const hit = root && href ? resolveHref(href, root.cwd) : null
    if (!root || !hit) return <MdLink href={href}>{children}</MdLink>
    // A path outside the folder is nothing Clui can open.
    if (hit.kind === 'outside') return <span title={`Outside this session's folder: ${hit.path}`}>{children}</span>
    if (!listedIn(root.ws, hit.ref.rel)) return <>{children}</>
    return (
      <FileLink root={root} at={hit.ref} className={LINK}>
        {children}
      </FileLink>
    )
  },
  // Block spacing tuned to the chat density; lists/tables/quotes themed to tokens.
  // max-w-[70ch] caps prose at a comfortable reading measure while code/tables stay full-width.
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0 max-w-[70ch]">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 list-disc pl-5 marker:text-faint max-w-[70ch]">{children}</ul>,
  ol: ({ children, start }) => (
    // Forward start so a list beginning at N renders from N (a numbered instruction that
    // references step 5 shouldn't renumber to 1).
    <ol start={start} className="my-1.5 list-decimal pl-5 marker:text-faint max-w-[70ch]">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="my-0.5 max-w-[70ch]">{children}</li>,
  h1: ({ children }) => <h1 className="mt-3 mb-1.5 text-lg font-semibold first:mt-0 max-w-[70ch]">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1.5 text-base font-semibold first:mt-0 max-w-[70ch]">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2.5 mb-1 text-sm font-semibold first:mt-0 max-w-[70ch]">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-l-2 border-border pl-3 text-dim italic max-w-[70ch]">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-border" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-bg-raised px-2 py-1 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border border-border px-2 py-1">{children}</td>
}

/** Heading overrides for markdown inside a chrome-titled container (the plan dialog): a step
 *  down from the transcript ramp so the body's largest heading stays below the dialog title. */
const COMPACT_HEADINGS: Partial<Components> = {
  h1: ({ children }) => <h1 className="mt-3 mb-1.5 text-base font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1.5 text-sm font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2.5 mb-1 text-xs font-semibold first:mt-0">{children}</h3>
}

export const Markdown = memo(function Markdown({ text, headingScale = 'default' }: { text: string; headingScale?: 'default' | 'compact' }): JSX.Element {
  // The /usage report is preformatted column text that markdown would flatten into one
  // run-on line. Detect it and render a native card instead. Anything unrecognized (incl.
  // mid-stream partials) falls through to normal markdown.
  const usage = parseUsageReport(text)
  if (usage) return <UsageCard report={usage} />

  // /context renders a native card (fill gauge + category bars) instead of a raw GFM table.
  const context = parseContextReport(text)
  if (context) return <ContextCard report={context} />

  const components = headingScale === 'compact' ? { ...COMPONENTS, ...COMPACT_HEADINGS } : COMPONENTS
  return (
    <div className="text-sm leading-relaxed text-content [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

/** A path into the session's folder. Neutral where web links keep the accent, which is the cue that it stays in Clui. */
function FileLink({ root, at, className, label, children }: { root: LinkRoot; at: FileRef; className: string; label?: string; children?: ReactNode }): JSX.Element {
  const target = useLinkTarget((s) => s.file)
  const editor = useLinkTarget((s) => s.editor)
  const path = `${root.cwd}/${at.rel}`
  const dir = !!root.ws?.dirs.has(at.rel)
  const title = fileLinkTitle(at.rel, at, dir, target, editor)
  return (
    <a
      href={`file://${encodeURI(path)}`}
      data-ui="file-link"
      title={title}
      aria-label={label}
      aria-description={title}
      className={className}
      onClick={(e) => openFileLink(root.handleId, path, at, dir, e)}
      onAuxClick={(e) => e.preventDefault()}
    >
      {children}
    </a>
  )
}

/** Claude's own links keep the accent; where they open follows the "Open web links in" setting. */
function MdLink({ href, className = 'text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent', label, children }: { href?: string; className?: string; label?: string; children?: ReactNode }): JSX.Element {
  const hasBrowser = useActive((s) => !!s?.browser)
  const target = useLinkTarget((s) => s.target)
  return (
    <a
      href={href}
      title={href ? linkTitle(href, hasBrowser, target) : undefined}
      aria-label={label}
      {...(href ? linkHandlers(href) : { onClick: (e: MouseEvent) => e.preventDefault() })}
      className={className}
    >
      {children}
    </a>
  )
}

/** What a document's renderers need besides its text. `images` is null until the preview has asked main for them, and
 *  `too-many` is an image past the most one ask covers. */
export interface DocLinks {
  base: string
  images: ReadonlyMap<string, ImageCap | 'too-many'> | null
  /** A same-file `#frag` link, already decoded. */
  jump: (frag: string, via: Via) => void
}
export const DocContext = createContext<DocLinks | null>(null)

const DEAD = 'rounded-sm text-content underline decoration-[var(--color-dim)] decoration-dotted underline-offset-2 cursor-default'
const CHIP = 'inline-flex items-center gap-1 rounded border border-border px-1.5 align-middle text-meta text-dim'
const GUTTER =
  'invisible absolute left-0 block min-h-6 w-(--gut) cursor-default select-none pr-2 text-right text-meta leading-6 tabular-nums text-faint pointer-fine:hover:text-content data-show:visible data-sel:visible data-sel:text-content [[data-pointing]_&]:visible'

// data: images are allowed for src alone, and only as images.
const documentUrls: UrlTransform = (url, key) => ((key === 'src' && /^data:image\//i.test(url)) || (key === 'href' && isLocalHref(url)) ? url : defaultUrlTransform(url))

/** A block's first source line, in the gutter. Hidden from assistive tech: Shift and the arrows on the region select. */
export function GutterNum({ line }: { line: number }): JSX.Element {
  return (
    <span aria-hidden="true" data-num="" className={GUTTER}>
      {line}
    </span>
  )
}

const Num = ({ node }: { node?: Element }): JSX.Element | null => (node?.position ? <GutterNum line={node.position.start.line} /> : null)

export function PointedRow({ label, list = false, children }: { label: string; list?: boolean; children?: ReactNode }): JSX.Element {
  const Tag = list ? 'li' : 'div'
  return (
    <Tag data-pointed="" className="flex h-6 select-none items-center gap-1.5 text-meta text-dim">
      <IconTarget className="h-3 w-3" />
      {label}
      {children}
    </Tag>
  )
}

const imageOnly = (node: Element | undefined): boolean =>
  !!node?.children.length &&
  node.children.every((c) => (c.type === 'text' ? !c.value.trim() : c.type === 'element' && c.tagName === 'img' && !c.properties.alt)) &&
  node.children.some((c) => c.type === 'element')

const hostOf = (url: string): string => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
const nameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1) || p

function ImageChip({ text, title, spoken, img }: { text: string; title: string; spoken: string; img?: string }): JSX.Element {
  return (
    <span role="img" aria-label={spoken} title={title} data-img={img} className={CHIP}>
      <IconImage className="h-3 w-3 text-faint" />
      {text}
    </span>
  )
}

function DocImage({ src, alt, title }: { src?: string; alt?: string; title?: string }): JSX.Element {
  const d = useContext(DocContext)
  const root = useContext(FileLinkContext)
  const [failed, setFailed] = useState<string | null>(null)
  const url = src ?? ''
  if (/^data:image\//i.test(url)) return <img src={url} alt={alt ?? ''} title={title} loading="lazy" decoding="async" className="inline-block h-auto max-w-full align-middle" />
  if (/^https?:/i.test(url)) {
    const host = hostOf(url)
    return <ImageChip text={alt || host} title={`Web image not loaded: ${url}. Previews don't load from the web.`} spoken={`${alt || host}, web image not loaded`} />
  }
  const hit = d && url ? resolveHref(url, root?.cwd ?? '', d.base) : null
  const abs = hit?.kind === 'file' ? `${root?.cwd ?? ''}/${hit.ref.rel}` : (hit?.path ?? null)
  const rel = hit?.kind === 'file' ? hit.ref.rel : (hit?.path ?? url)
  const name = alt || nameOf(rel)
  const cap = abs ? d?.images?.get(abs) : undefined
  // Every path stays marked, so each ask finds them all; one with no answer yet waits for the next.
  const img = abs ?? undefined
  if (abs && !cap) return <span data-img={abs} />
  if (cap === 'too-many') return <ImageChip img={img} text={name} title={`Only the first ${IMAGE_PATHS_MAX.toLocaleString('en-US')} images in a document load. This one isn't shown.`} spoken={`${name}, image not shown`} />
  if (cap && !cap.ok && cap.outside) return <ImageChip img={img} text={name} title={`Outside this session's folder: ${abs}`} spoken={`${name}, image outside this session's folder`} />
  if (!cap?.ok || failed === cap.url) return <ImageChip img={img} text={name} title={`Couldn't load ${rel}`} spoken={`${name}, image couldn't load`} />
  return (
    <img src={cap.url} alt={alt ?? ''} title={title} data-img={img} loading="lazy" decoding="async" onError={() => setFailed(cap.url)} className="inline-block h-auto max-w-full align-middle" />
  )
}

function DocLink({ node, href, children, className: _class, ...rest }: JSX.IntrinsicElements['a'] & { node?: Element }): JSX.Element {
  const root = useContext(FileLinkContext)
  const d = useContext(DocContext)
  const hit = root && href && d ? resolveHref(href, root.cwd, d.base) : null
  const bare = imageOnly(node)
  if (href?.startsWith('#') && d) {
    let frag = href.slice(1)
    try {
      frag = decodeURIComponent(frag)
    } catch {
      /* kept as written */
    }
    return (
      <a
        {...rest}
        href={href}
        className={LINK}
        onClick={(e) => {
          e.preventDefault()
          d.jump(frag, viaOf(e))
        }}
      >
        {children}
      </a>
    )
  }
  if (!root || !hit) return <MdLink href={href} className={LINK} label={bare && href ? hostOf(href) || href : undefined}>{children}</MdLink>
  if (hit.kind === 'outside') {
    const t = `Outside this session's folder: ${hit.path}`
    return <span title={t} aria-description={t} className={DEAD}>{children}</span>
  }
  if (!listedIn(root.ws, hit.ref.rel)) {
    const t = `Not found in this folder: ${hit.ref.rel}`
    return <span title={t} aria-description={t} className={DEAD}>{children}</span>
  }
  return (
    <FileLink root={root} at={hit.ref} className={LINK} label={bare ? nameOf(hit.ref.rel) : undefined}>
      {children}
    </FileLink>
  )
}

/** Fence languages that render as something other than code; `span` includes both fence lines, and null falls back
 *  to the code. */
const FENCES: Partial<Record<string, (code: string, span: Span) => JSX.Element | null>> = {
  mermaid: (code, span) => (code.trim() ? <MermaidDiagram code={code} firstLine={span.start + 1} lastLine={span.start + code.split('\n').length} /> : null)
}

const heading = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6', className: string): Components['h1'] =>
  function Heading({ node, id, className: given, children }) {
    // The footnotes label stays the visually hidden heading remark-gfm makes.
    if (given?.includes('sr-only')) return <Tag id={id} className={given}>{children}</Tag>
    return (
      <Tag id={id} data-src={spanAttr(node?.position)} className={`scroll-mt-4 ${className}`}>
        <Num node={node} />
        {children}
      </Tag>
    )
  }

const ALIGN: Record<string, string> = { center: 'text-center', right: 'text-right' }
const alignOf = (style: unknown): string => ALIGN[String((style as { textAlign?: string } | undefined)?.textAlign)] ?? 'text-left'

/** The first cell of a row carries the row's gutter number, since a row can't hold anything but cells. */
type CellProps = { lead?: ReactNode }

const DOCUMENT: Components = {
  code: COMPONENTS.code,
  a: DocLink,
  img: ({ src, alt, title }) => <DocImage src={src} alt={alt} title={title} />,
  pre({ node }) {
    const code = node?.children.find((c): c is Element => c.type === 'element' && c.tagName === 'code')
    const text = code ? textOf(code).replace(/\n$/, '') : ''
    const lang = /language-(\S+)/.exec(String((code?.properties.className as string[] | undefined)?.join(' ') ?? ''))?.[1] ?? null
    const p = node?.position
    const custom = lang && p ? FENCES[lang]?.(text, { start: p.start.line, end: p.end.line }) : null
    return (
      <div data-src={spanAttr(p)} className="my-4">
        <Num node={node} />
        {custom ?? <CodeBlock code={text} lang={lang} />}
      </div>
    )
  },
  p: ({ node, children }) => (
    <p data-src={spanAttr(node?.position)} className="my-4 first:mt-0">
      <Num node={node} />
      {children}
    </p>
  ),
  h1: heading('h1', 'mt-8 mb-3 text-2xl font-semibold first:mt-0'),
  h2: heading('h2', 'mt-8 mb-2 text-xl font-semibold'),
  h3: heading('h3', 'mt-6 mb-2 text-lg font-semibold'),
  h4: heading('h4', 'mt-5 mb-1.5 text-base font-semibold'),
  h5: heading('h5', 'mt-4 mb-1 text-sm font-semibold'),
  h6: heading('h6', 'mt-4 mb-1 text-sm font-semibold text-dim'),
  ul: ({ children }) => <ul className="my-4 list-disc pl-6 marker:text-faint">{children}</ul>,
  ol: ({ children, start }) => (
    <ol start={start} className="my-4 list-decimal pl-6 marker:text-faint">
      {children}
    </ol>
  ),
  li({ node, id, className, children }) {
    if (node?.properties.dataPointed) return <PointedRow label={String(node.properties.dataPointed)} list />
    const task = !!className?.includes('task-list-item')
    return (
      <li id={id} data-src={spanAttr(node?.position)} className={`my-1 [&>ol]:my-1 [&>ul]:my-1 ${task ? '-ml-6 list-none' : ''}`}>
        <Num node={node} />
        {children}
      </li>
    )
  },
  div: ({ node, children, ...rest }) => (node?.properties.dataPointed ? <PointedRow label={String(node.properties.dataPointed)} /> : <div {...rest}>{children}</div>),
  input({ type, checked }) {
    // GFM's disabled checkbox reads as unavailable; the box shape is the only state cue, never its colour.
    if (type !== 'checkbox') return null
    return (
      <span role="img" aria-label={checked ? 'Done' : 'Not done'} className="mr-1 inline-flex h-4 w-4 items-center justify-center rounded-[3px] border border-control-edge align-[-0.15em]">
        {checked ? <IconCheck className="h-3 w-3 text-content" /> : null}
      </span>
    )
  },
  blockquote: ({ children }) => <blockquote className="my-4 border-l-2 border-border-strong pl-4 text-dim">{children}</blockquote>,
  hr: ({ node }) => (
    <div data-src={spanAttr(node?.position)} className="my-8">
      <Num node={node} />
      <hr className="border-border" />
    </div>
  ),
  table: ({ children }) => (
    <div className="my-4 overflow-x-auto">
      <table className="w-max min-w-full border-collapse">{children}</table>
    </div>
  ),
  tr({ node, children }) {
    const cells = Children.toArray(children)
    const first = cells.findIndex(isValidElement)
    if (first >= 0) cells[first] = cloneElement(cells[first] as ReactElement<CellProps>, { lead: <Num node={node} /> })
    return <tr data-src={spanAttr(node?.position)}>{cells}</tr>
  },
  th: ({ style, children, lead }: JSX.IntrinsicElements['th'] & CellProps) => (
    <th className={`whitespace-nowrap border border-border bg-bg-raised px-3 py-1.5 font-semibold ${alignOf(style)}`}>
      {lead}
      {children}
    </th>
  ),
  td: ({ style, children, lead }: JSX.IntrinsicElements['td'] & CellProps) => (
    <td className={`min-w-40 border border-border px-3 py-1.5 align-top ${alignOf(style)}`}>
      {lead}
      {children}
    </td>
  ),
  sup: ({ children }) => <sup className="text-[0.75em]">{children}</sup>,
  section: ({ node, children, className }) =>
    node?.properties.dataFootnotes !== undefined ? (
      <section data-footnotes="" className="mt-10 border-t border-border pt-4 text-sm text-dim">
        {children}
      </section>
    ) : (
      <section className={className}>{children}</section>
    )
}

/** What react-markdown does to a tree before rendering it: raw HTML shows as its text, and every URL goes through the
 *  document's transform. Idempotent, so a node seen again, under a copy on Claude's path, is safe. */
function safe(n: RootContent): RootContent {
  if (n.type === 'raw') return { type: 'text', value: n.value }
  if (n.type !== 'element') return n
  for (const key in urlAttributes) {
    const test = urlAttributes[key]
    if (Object.hasOwn(n.properties, key) && (test === null || test.includes(n.tagName))) n.properties[key] = documentUrls(String(n.properties[key] || ''), key, n)
  }
  n.children = n.children.map(safe) as ElementContent[]
  return n
}

const built = new WeakMap<RootContent, ReactElement>()

/** A document's top-level node as React, built once per node. `key` is the row's, which never changes for a node. */
export function docRow(n: RootContent, key: string | number): ReactElement {
  let out = built.get(n)
  if (!out) {
    const opts = { Fragment, jsx, jsxs, components: DOCUMENT as Partial<JsxComponents>, ignoreInvalidStyle: true, passKeys: true, passNode: true }
    out = createElement(Fragment, { key }, toJsxRuntime({ type: 'root', children: [safe(n)] }, opts))
    built.set(n, out)
  }
  return out
}
