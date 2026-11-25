import type { MouseEvent, RefObject } from 'react'
import { useActive, type ToolCall } from '../store'
import { changeReadOf, isChangeRead, sentenceOf } from '../lib/instrument'
import { Bead } from './InstrumentRow'
import { IconChevron } from './Icon'

/** The one dim line a run's folded routine calls read as. Opening it un-hides their rows in place, so open is the
 *  full log. */
export function RunSentence({
  tools,
  open,
  onToggle,
  controls,
  placement,
  seg,
  hidden,
  buttonRef
}: {
  tools: ToolCall[]
  open: boolean
  onToggle: (e: MouseEvent) => void
  /** Space-joined ids of the folded rows. */
  controls: string
  placement: 'spine' | 'inline'
  seg: 'through' | 'end'
  hidden: boolean
  buttonRef: RefObject<HTMLButtonElement>
}): JSX.Element {
  // A change read is named by the change it points at, which only the user message that sent it knows. One string,
  // so a streaming token re-runs the selector but re-renders nothing.
  const changes = tools.filter((t) => isChangeRead(t.name))
  const labels = useActive((s) => (s ? changes.map((t) => changeReadOf(s.messages, t.input)?.label ?? '').join('\0') : '')).split('\0')
  const labelOf = new Map(changes.map((t, i) => [t.id, labels[i] || null]))
  // ponytail: every passed command is named, so a long Bash list clips under the 2-line clamp; fit the names to the
  // clamp by measuring once the clipped count phrase matters.
  const { parts, plain } = sentenceOf(tools, { changeLabel: (t) => labelOf.get(t.id) ?? null, bashNamed: Infinity })
  const n = tools.length
  return (
    <div data-ui="run-sentence" hidden={hidden} className={placement === 'spine' ? 'spine-seg' : 'relative'} data-seg={placement === 'spine' ? seg : undefined}>
      {placement === 'spine' && <Bead state="done" lit={false} placement="spine" />}
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={controls || undefined}
        aria-label={`${n} ${n === 1 ? 'call' : 'calls'}: ${plain}`}
        title={plain}
        onClick={onToggle}
        className="group/sentence grid w-full items-start gap-2 rounded-md py-1 pl-2 pr-1.5 text-left text-meta pointer-fine:hover:bg-row-hover focus-visible:outline-offset-[-2px]"
        style={{ gridTemplateColumns: placement === 'inline' ? '8px minmax(0,1fr) 24px' : 'minmax(0,1fr) 24px' }}
      >
        {placement === 'inline' && (
          <span className="flex h-4 items-center">
            <Bead state="done" lit={false} placement="inline" bare />
          </span>
        )}
        <span className={`line-clamp-2 break-words ${open ? 'text-content' : 'text-dim'}`}>
          {parts.map((p, i) => (p.mono ? <span key={i} className="font-mono">{p.text}</span> : <span key={i}>{p.text}</span>))}
        </span>
        <span className="flex h-4 items-center justify-center text-faint" aria-hidden="true">
          <IconChevron
            className={`h-4 w-4 transition-transform [transition-duration:var(--dur-fast)] [transition-timing-function:var(--ease-out)] ${
              open ? 'rotate-90' : 'opacity-0 pointer-fine:group-hover/sentence:opacity-100 group-focus-visible/sentence:opacity-100'
            }`}
          />
        </span>
      </button>
    </div>
  )
}
