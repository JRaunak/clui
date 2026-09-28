/** AskUserQuestion picker: the model asking the user a structured question. The CLI fires
 *  it as `can_use_tool` with `requires_user_interaction: true` (fires even in bypassPermissions).
 *  Multiple questions, numbered options + free-text, Submit enables only when every question
 *  is answered. Wire format: allow + updatedInput = { questions, answers }. */
import { useCallback, useRef, useState } from 'react'
import { useSession, type PendingPermission } from '../../store'
import { Button } from '../Button'
import { IconCheck, IconMessage } from '../Icon'
import { GateFrame, type GateCount } from './GateFrame'

interface QOption {
  label: string
  description?: string
  // Optional per-option preview (a code snippet / ASCII mock) the CLI shows beside
  // the options so you can compare them. Display-only; never part of the answer.
  preview?: string
}
interface Question {
  question: string
  header?: string
  options: QOption[]
  multiSelect?: boolean
}

const FREE_TEXT = ' free-text' // sentinel selection meaning "use the typed value"

/** Validate one option: a non-null object with a string label. Non-string label/description/preview
 *  would crash the dialog when reaching `o.preview` reads and React children. */
function parseOption(o: unknown): QOption | null {
  if (!o || typeof o !== 'object') return null
  const r = o as Record<string, unknown>
  if (typeof r.label !== 'string') return null
  return {
    label: r.label,
    description: typeof r.description === 'string' ? r.description : undefined,
    preview: typeof r.preview === 'string' ? r.preview : undefined
  }
}

function parseQuestions(input: unknown): Question[] {
  if (input && typeof input === 'object' && Array.isArray((input as { questions?: unknown }).questions)) {
    return ((input as { questions: unknown[] }).questions as unknown[])
      .map((q): Question | null => {
        if (!q || typeof q !== 'object') return null
        const r = q as Record<string, unknown>
        if (typeof r.question !== 'string' || !Array.isArray(r.options)) return null
        const options = (r.options as unknown[]).map(parseOption).filter((o): o is QOption => o !== null)
        if (options.length === 0) return null
        return {
          question: r.question,
          header: typeof r.header === 'string' ? r.header : undefined,
          options,
          multiSelect: r.multiSelect === true
        }
      })
      .filter((q): q is Question => q !== null)
  }
  return []
}

export function QuestionGate({ request, count }: { request: PendingPermission; count: GateCount }): JSX.Element {
  const respond = useSession((s) => s.respondPermission)
  const questions = parseQuestions(request.input)
  const [tab, setTab] = useState(0) // active question index
  // Per-question chosen option labels or the FREE_TEXT sentinel.
  const [picked, setPicked] = useState<Record<number, string[]>>({})
  const [freeText, setFreeText] = useState<Record<number, string>>({})
  // Optional per-question note, folded into the answer on submit. Never gates submit.
  const [note, setNote] = useState<Record<number, string>>({})
  const freeRef = useRef<HTMLInputElement>(null)

  const isAnswered = useCallback(
    (qi: number): boolean => {
      const p = picked[qi] ?? []
      if (p.includes(FREE_TEXT)) return (freeText[qi]?.trim().length ?? 0) > 0
      return p.length > 0
    },
    [picked, freeText]
  )
  const answeredCount = questions.filter((_, qi) => isAnswered(qi)).length
  const allAnswered = questions.length > 0 && answeredCount === questions.length

  const choose = (qi: number, label: string, multi: boolean): void => {
    setPicked((prev) => {
      const cur = prev[qi] ?? []
      if (multi) {
        // Custom text is exclusive in multi-select: picking "Something else" clears the normal
        // picks, and picking a normal option clears the custom sentinel. If both stayed selected,
        // submit would send only the free text and silently drop the visibly-selected option.
        if (label === FREE_TEXT) {
          return { ...prev, [qi]: cur.includes(FREE_TEXT) ? cur.filter((l) => l !== FREE_TEXT) : [FREE_TEXT] }
        }
        const normal = cur.filter((l) => l !== FREE_TEXT)
        return {
          ...prev,
          [qi]: normal.includes(label) ? normal.filter((l) => l !== label) : [...normal, label]
        }
      }
      return { ...prev, [qi]: [label] }
    })
    if (label === FREE_TEXT) setTimeout(() => freeRef.current?.focus(), 0)
  }

  const submit = (): void => {
    if (!allAnswered) return
    const answers: Record<string, string | string[]> = {}
    questions.forEach((q, qi) => {
      const p = picked[qi] ?? []
      // The note folds into the answer value: the only channel the model receives.
      const n = note[qi]?.trim()
      const withNote = (v: string): string => (n ? `${v} (note: ${n})` : v)
      if (p.includes(FREE_TEXT)) {
        answers[q.question] = withNote(freeText[qi].trim())
      } else if (q.multiSelect) {
        // Carry the note as a trailing element so each pick stays clean.
        answers[q.question] = n ? [...p, `(note: ${n})`] : p
      } else {
        answers[q.question] = withNote(p[0])
      }
    })
    void respond({ requestId: request.requestId, behavior: 'allow', updatedInput: { questions, answers } })
  }

  // "Chat about this": deny the structured question so the user can free-type a reply.
  const chatInstead = (): void => {
    void respond({
      requestId: request.requestId,
      behavior: 'deny',
      message: 'The user chose to chat about this instead of answering the question.'
    })
  }

  // Cancel is a neutral skip (allow with empty answers). Unlike chat, it sends the model no message.
  const cancel = (): void => {
    void respond({ requestId: request.requestId, behavior: 'allow', updatedInput: { questions, answers: {} } })
  }

  const tablistRef = useRef<HTMLDivElement>(null)

  // Enter submits when every question is answered, but not while an option button or the
  // free-text input has focus.
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'INPUT' || tag === 'BUTTON') return
    if (e.key === 'Enter' && allAnswered) {
      e.preventDefault()
      submit()
    }
  }

  // W3C tabs pattern: Left/Right move both the selected tab and DOM focus; roving tabindex keeps
  // the tablist a single Tab stop.
  const onTablistKeyDown = (e: React.KeyboardEvent): void => {
    const last = questions.length - 1
    let next = tab
    if (e.key === 'ArrowRight') next = tab === last ? 0 : tab + 1
    else if (e.key === 'ArrowLeft') next = tab === 0 ? last : tab - 1
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = last
    else return
    e.preventDefault()
    setTab(next)
    tablistRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  if (questions.length === 0) {
    return (
      <GateFrame
        icon={<IconMessage className="h-3.5 w-3.5" />}
        kicker="Question"
        title="Claude is asking"
        count={count}
        footer={
          <QuestionFooter onCancel={cancel} onChat={chatInstead} submitDisabled onSubmit={submit} answeredCount={0} total={0} />
        }
      >
        <p className="pb-1 text-sm text-dim">Claude asked a question, but it couldn’t be parsed.</p>
      </GateFrame>
    )
  }

  const qi = Math.min(tab, questions.length - 1)
  const q = questions[qi]
  const showTabs = questions.length > 1

  // The pane follows the selected option (the first one, for multiSelect) and stays empty until
  // something is picked. Hover never drives it.
  const hasPreviews = q.options.some((o) => !!o.preview)
  const selectedIdx = q.options.findIndex((o) => (picked[qi] ?? []).includes(o.label))
  const selectedOption = selectedIdx >= 0 ? q.options[selectedIdx] : null
  const rawPreview = selectedOption?.preview
  const activePreview = typeof rawPreview === 'string' ? rawPreview : ''

  const group = (
    <div
      role={q.multiSelect ? 'group' : 'radiogroup'}
      aria-label={q.question}
      className={`flex flex-col gap-1.5 ${hasPreviews ? 'w-full shrink-0 @min-[640px]:w-[300px]' : ''}`}
    >
      {q.options.map((opt, oi) => (
        <OptionRow
          key={opt.label}
          index={oi + 1}
          label={opt.label}
          description={opt.description}
          multi={!!q.multiSelect}
          selected={(picked[qi] ?? []).includes(opt.label)}
          onClick={() => choose(qi, opt.label, !!q.multiSelect)}
        />
      ))}
      {/* The "Something else" row itself becomes the text input once chosen. */}
      {(picked[qi] ?? []).includes(FREE_TEXT) ? (
        <div className="flex items-center gap-2.5 rounded-md border border-content bg-tool px-3 py-2">
          <span className="w-4 shrink-0 text-center font-mono text-meta text-dim">{q.options.length + 1}</span>
          <input
            ref={freeRef}
            value={freeText[qi] ?? ''}
            onChange={(e) => setFreeText((p) => ({ ...p, [qi]: e.target.value }))}
            placeholder="Type your answer…"
            className="min-w-0 flex-1 bg-transparent text-sm text-content outline-none placeholder:text-dim"
          />
          <IconCheck className="h-3.5 w-3.5 shrink-0 text-content" />
        </div>
      ) : (
        <OptionRow
          index={q.options.length + 1}
          label="Something else…"
          multi={!!q.multiSelect}
          selected={false}
          onClick={() => choose(qi, FREE_TEXT, false)}
        />
      )}
    </div>
  )

  return (
    <GateFrame
      icon={<IconMessage className="h-3.5 w-3.5" />}
      kicker="Question"
      title={q.question}
      count={count}
      onKeyDown={onKeyDown}
      tabs={
        showTabs ? (
          <div
            ref={tablistRef}
            role="tablist"
            aria-label="Questions"
            onKeyDown={onTablistKeyDown}
            className="flex shrink-0 items-stretch gap-1 overflow-x-auto overflow-y-hidden px-4 shadow-[inset_0_-1px_0_var(--color-border)]"
          >
            {questions.map((qq, i) => (
              <button
                key={i}
                role="tab"
                aria-selected={i === tab}
                tabIndex={i === tab ? 0 : -1}
                onClick={() => setTab(i)}
                className={`flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent ${
                  i === tab ? 'border-content font-medium text-content' : 'border-transparent text-dim hover:text-content'
                }`}
              >
                {qq.header || `Q${i + 1}`}
                {/* title, not aria-label: Svg renders it as a real <title>, so "answered" reaches AT. */}
                {isAnswered(i) && <IconCheck className="h-3 w-3 text-ok" title="answered" />}
              </button>
            ))}
          </div>
        ) : undefined
      }
      footer={
        <QuestionFooter
          onCancel={cancel}
          onChat={chatInstead}
          submitDisabled={!allAnswered}
          onSubmit={submit}
          answeredCount={answeredCount}
          total={questions.length}
        />
      }
    >
      <div className="flex flex-col gap-3 pt-1 pb-1">
        {q.multiSelect && <div className="text-meta text-dim">Select all that apply</div>}
        {hasPreviews ? (
          <div className="flex flex-col gap-4 @min-[640px]:flex-row @min-[640px]:items-start">
            {group}
            <PreviewPane text={activePreview} selectedLabel={selectedOption?.label ?? null} />
          </div>
        ) : (
          group
        )}
        {hasPreviews && (
          <label className="mt-1 flex flex-col gap-1.5">
            <span className="text-meta text-dim">Note (optional)</span>
            <input
              value={note[qi] ?? ''}
              onChange={(e) => setNote((p) => ({ ...p, [qi]: e.target.value }))}
              placeholder="Add a note for Claude…"
              className="rounded-md border border-border bg-tool px-3 py-2 text-sm text-content outline-none placeholder:text-dim focus:border-accent"
            />
          </label>
        )}
      </div>
    </GateFrame>
  )
}

function OptionRow({
  index,
  label,
  description,
  multi,
  selected,
  onClick
}: {
  index: number
  label: string
  description?: string
  // multi-select → checkbox semantics, single → radio; the pressed state reaches AT.
  multi: boolean
  selected: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      role={multi ? 'checkbox' : 'radio'}
      aria-checked={selected}
      onClick={onClick}
      className={`flex items-start gap-2.5 rounded-md border bg-tool px-3 py-2 text-left transition-colors ${
        selected ? 'border-content' : 'border-border hover:border-border-strong hover:bg-bg-raised'
      }`}
    >
      <span className="mt-0.5 w-4 shrink-0 text-center font-mono text-meta text-dim">{index}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-content">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-dim">{description}</span>}
      </span>
      {selected && <IconCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-content" />}
    </button>
  )
}

/** Preview side-panel. Reuses the existing surface styling so it doesn't read as a separate widget.
 *  selectedLabel null means nothing is picked yet. */
function PreviewPane({ text, selectedLabel }: { text: string; selectedLabel: string | null }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-tool">
      <div className="flex min-w-0 items-baseline gap-1.5 border-b border-border/60 px-3 py-1.5">
        <span className="shrink-0 text-caps uppercase text-dim">Preview</span>
        {selectedLabel && <span className="min-w-0 truncate text-meta text-dim">{selectedLabel}</span>}
      </div>
      {selectedLabel === null ? (
        <div className="flex flex-1 items-center justify-center px-3 py-2.5 text-center text-sm text-dim">
          Select an option to preview it.
        </div>
      ) : text ? (
        <pre className="max-h-[40vh] overflow-auto whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-xs text-content">
          {text}
        </pre>
      ) : (
        // This option carries no preview; say so rather than showing an empty box.
        <div className="px-3 py-2.5 text-xs text-dim">No preview for this option.</div>
      )}
    </div>
  )
}

function QuestionFooter({
  onCancel,
  onChat,
  submitDisabled,
  onSubmit,
  answeredCount,
  total
}: {
  onCancel: () => void
  onChat: () => void
  submitDisabled: boolean
  onSubmit: () => void
  answeredCount: number
  total: number
}): JSX.Element {
  return (
    <div className="flex w-full items-center gap-2">
      <Button data-ui="gate-secondary" variant="ghost" size="md" onClick={onChat} title="Skip the question and chat freely instead">
        Chat about this
      </Button>
      <div className="ml-auto flex items-center gap-3">
        {/* Doubles as a submit-scope cue and announces progress so the disabled Submit isn't a dead end for AT. */}
        {total > 0 && (
          <span aria-live="polite" className="text-xs text-dim">
            {answeredCount} of {total} answered
          </span>
        )}
        <div className="flex gap-2">
          <Button data-ui="gate-secondary" variant="control" size="md" onClick={onCancel}>
            Cancel
          </Button>
          <Button data-ui="gate-primary" variant="primary" size="md" onClick={onSubmit} disabled={submitDisabled}>
            {total > 1 ? 'Send answers' : 'Send answer'}
          </Button>
        </div>
      </div>
    </div>
  )
}
