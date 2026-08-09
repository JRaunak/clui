/**
 * Markdown renderer for assistant output.
 *
 * react-markdown + remark-gfm (tables, task lists, strikethrough, autolinks),
 * with custom renderers so code blocks get highlight.js syntax highlighting + a
 * hover copy button, and links open in the user's browser (never navigate the
 * app window).
 *
 * STREAMING-SAFE: assistant text arrives token-by-token, so the markdown is
 * routinely incomplete mid-turn (an unclosed ``` fence, a half-written table).
 * react-markdown simply renders whatever currently parses, and the highlighter is
 * wrapped in try/catch, so a partial document never throws.
 */
import { memo, useCallback, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import hljs from '../lib/hljs'
import { IconCopy, IconCheck } from './Icon'
import { parseUsageReport, UsageCard, parseContextReport, ContextCard } from './CommandOutput'

/** Highlight to an HTML string, defensively. Unknown/absent language → auto-detect;
 *  any grammar error → fall back to plain (escaped) text so a stream never breaks. */
function highlight(code: string, lang: string | null): { html: string; used: string | null } {
  try {
    if (lang && hljs.getLanguage(lang)) {
      return { html: hljs.highlight(code, { language: lang }).value, used: lang }
    }
    // No/unknown language (common while streaming a bare ``` fence): let hljs guess.
    const auto = hljs.highlightAuto(code)
    return { html: auto.value, used: auto.language ?? null }
  } catch {
    return { html: escapeHtml(code), used: null }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
}

function CodeBlock({ code, lang }: { code: string; lang: string | null }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const { html, used } = highlight(code, lang)
  const onCopy = useCallback(() => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [code])

  return (
    <div className="group relative my-2 overflow-hidden rounded-md border border-border bg-tool">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-1">
        <span className="font-mono text-[11px] uppercase tracking-wide text-faint">
          {used ?? 'text'}
        </span>
        {/* Persistent at-rest affordance (opacity-60), brightening on hover/focus.
            A hover-only (opacity-0) copy button is undiscoverable and unreachable by
            a keyboard scan of visible controls. */}
        <button
          onClick={onCopy}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-dim opacity-60 transition-opacity hover:text-content hover:opacity-100 focus-visible:opacity-100 group-hover:opacity-100"
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
          // Highlighted HTML is produced by highlight.js from the code string only
          // (no user HTML is interpreted; react-markdown never passes raw HTML here).
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
    const text = childrenToText(children)
    const match = /language-(\w+)/.exec(className || '')
    // react-markdown v10 dropped the `inline` flag; treat as a block if it has a
    // language class OR spans multiple lines (catches a fenced block with no lang).
    const isBlock = Boolean(match) || text.includes('\n')
    if (isBlock) {
      return <CodeBlock code={text.replace(/\n$/, '')} lang={match ? match[1] : null} />
    }
    return (
      <code
        className="rounded bg-bg-raised px-1 py-0.5 font-mono text-[0.9em] text-content"
        {...props}
      >
        {children}
      </code>
    )
  },
  a({ href, children }) {
    return (
      <a
        href={href}
        onClick={(e) => {
          e.preventDefault()
          if (href) void window.clui.openExternal(href)
        }}
        className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
      >
        {children}
      </a>
    )
  },
  // Block spacing tuned to the chat density; lists/tables/quotes themed to tokens.
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 list-disc pl-5 marker:text-faint">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal pl-5 marker:text-faint">{children}</ol>,
  li: ({ children }) => <li className="my-0.5">{children}</li>,
  h1: ({ children }) => <h1 className="mt-3 mb-1.5 text-lg font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1.5 text-base font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2.5 mb-1 text-sm font-semibold first:mt-0">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-l-2 border-border pl-3 text-dim italic">{children}</blockquote>
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

export const Markdown = memo(function Markdown({ text }: { text: string }): JSX.Element {
  // The `/usage` report is preformatted column text that markdown would flatten
  // into one run-on line. Detect it and render a native card instead. Anything
  // unrecognized (incl. mid-stream partials) falls through to normal markdown.
  const usage = parseUsageReport(text)
  if (usage) return <UsageCard report={usage} />

  // `/context` → a native card (fill gauge + category bars) instead of a raw GFM table.
  const context = parseContextReport(text)
  if (context) return <ContextCard report={context} />

  return (
    <div className="text-sm leading-relaxed text-content [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
