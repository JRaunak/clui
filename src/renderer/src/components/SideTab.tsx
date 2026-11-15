/** The side chat tab: a read-only fork of the session that answers beside it. Everything under SliceScope reads the
 *  side's slice, so the shared transcript, gate and queue components render it without a side branch. */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { sideFor, SliceScope, useActive, useSession, EMPTY_MESSAGES } from '../store'
import { askOf, forkedAt, SIDE_RUN, SIDE_TITLE, sidePhase, unhanded, type SidePhase } from '../lib/side'
import { deriveModelInfo, effortLabel, PERMISSION_MODE_LABELS } from '../../../shared/settings'
import type { RunState } from '../lib/agents'
import { formatCost } from '../lib/formatCost'
import { useDelayedFlag } from '../lib/useDelayedFlag'
import { useTranscriptFind } from '../lib/useTranscriptFind'
import { takeSurfaceFocus } from '../lib/surfaceFocus'
import { RunAnnounce, Sep, WorkingTail } from './AgentTab'
import { QueuedMessages, TurnError } from './Chat'
import { SendStop } from './Composer'
import { FindField } from './FindField'
import { GateAnnouncer, GateHost } from './Gate'
import { InfoRow } from './InfoRow'
import { MessageView } from './MessageView'
import { RunStatus } from './RunMark'
import { Button } from './Button'
import { toMainDraft } from './SideConfirm'
import { IconSideChat } from './Icon'

export interface SideStatus {
  /** Starting only once it has lasted 400ms, so a quick handshake never flashes. */
  phase: SidePhase
  openedAt: number
  ask: string | null
}

/** The parent's side chat as its tab and info row show it, one value per change. */
export function useSideStatus(parent: string | null): SideStatus | null {
  const sig = useSession((s) => {
    const x = parent ? sideFor(s, parent) : null
    const head = x?.pendingPermissions[0]
    return x?.side ? JSON.stringify([sidePhase(x), x.side.openedAt, head ? askOf(head) : null]) : ''
  })
  const starting = useDelayedFlag(sig.startsWith('["starting"'))
  return useMemo(() => {
    if (!sig) return null
    const [phase, openedAt, ask] = JSON.parse(sig) as [SidePhase, number, string | null]
    return { phase: phase === 'starting' && !starting ? 'idle' : phase, openedAt, ask }
  }, [sig, starting])
}

const CAPABILITY = "Reads files and web pages. It can't change anything."
const ENDED = 'This side chat ended. Hand back what it found, or close it.'
const HAND_BACK = 'Adds this thread to your message to Claude and closes the side chat.'
const SPOKEN: Partial<Record<RunState, string>> = { done: 'Side chat answered', failed: 'Side chat answer failed', stopped: 'Side chat answer stopped', interrupted: 'Side chat ended' }

export function SideTab({ handleId }: { handleId: string }): JSX.Element | null {
  const side = useSession((s) => sideFor(s, handleId)?.handleId ?? null)
  if (!side) return null
  return (
    <SliceScope.Provider value={side}>
      <SideBody parent={handleId} side={side} />
    </SliceScope.Provider>
  )
}

function SideBody({ parent, side }: { parent: string; side: string }): JSX.Element {
  const status = useSideStatus(parent)
  const phase = status?.phase ?? 'idle'
  const raw = useActive((s) => (s ? sidePhase(s) : 'idle'))
  const messages = useActive((s) => s?.messages ?? EMPTY_MESSAGES)
  const turnStartMs = useActive((s) => s?.turnStartMs ?? null)
  const lastError = useActive((s) => s?.lastError ?? null)
  const cacheMiss = useActive((s) => s?.side?.cacheMiss ?? null)
  const cacheCold = useActive((s) => s?.cacheCold ?? null)
  const handable = useActive((s) => !!s && unhanded(s))
  const ran = useActive((s) => (s ? [deriveModelInfo(s.modelChoice).label, effortLabel(s.effortChoice), PERMISSION_MODE_LABELS[s.modeChoice]] : []).join('\n'))
  const bodyRef = useRef<HTMLDivElement>(null)
  const [scrolled, setScrolled] = useState(false)
  const pinned = useRef(true)
  const find = useTranscriptFind(bodyRef, [messages], () => messages.length > 0)

  // A streaming answer stays in view unless the user has scrolled up to read.
  useLayoutEffect(() => {
    const el = bodyRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages, raw])

  const live = raw === 'starting' || raw === 'answering' || raw === 'stopping' || raw === 'needs'
  const asked = messages.length > 0
  const silent = useDelayedFlag(live && asked && !messages.some((m) => m.role === 'assistant'), 2000)
  // The answer that a cold cache cost, judged on the first one only.
  const firstEnd = cacheMiss ? messages.find((m) => m.role === 'assistant' && m.turnEnd)?.id : undefined
  const last = messages.findLast((m) => m.role === 'assistant')
  const announced: RunState =
    raw === 'idle' ? (last?.turnEnd?.reason?.kind === 'stopped' ? 'stopped' : 'done') : raw === 'starting' && !asked ? 'queued' : SIDE_RUN[raw].state
  const run = phase === 'idle' ? null : SIDE_RUN[phase]
  const at = status ? forkedAt(status.openedAt) : ''
  const showRequest = (): void => document.querySelector<HTMLElement>('[data-ui="side-dock"] [data-ui="gate-title"]')?.focus()
  const handBackWhy = !handable ? 'Nothing to hand back yet' : live ? "Hand back the finished answers. The answer in progress stops and isn't included." : null

  return (
    <div data-ui="side-tab" className="flex min-h-0 flex-1 flex-col bg-bg">
      <RunAnnounce state={announced} spoken={SPOKEN} />
      <GateAnnouncer />
      <InfoRow
        ui="side-info"
        scrolled={scrolled}
        lead={<IconSideChat className="h-3.5 w-3.5" />}
        line1={
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="text-ui font-semibold text-content">{SIDE_TITLE}</span>
            <span className="text-meta text-dim" title={`Sees the conversation up to ${at}. Open a new side chat to include later messages.`}>
              from {at}
            </span>
            <Button
              data-ui="side-hand-back"
              variant="control"
              size="sm"
              className="ml-auto"
              aria-disabled={!handable || undefined}
              aria-description={handBackWhy ?? HAND_BACK}
              title={handBackWhy ?? HAND_BACK}
              onClick={() => handable && useSession.getState().handBackSide(parent) && toMainDraft()}
            >
              Hand back
            </Button>
          </span>
        }
        line2={
          <>
            {run && (
              <>
                <RunStatus state={run.state} word={run.word} startMs={phase === 'answering' ? (turnStartMs ?? undefined) : undefined} />
                {phase === 'needs' && (
                  <>
                    <Sep />
                    <button type="button" onClick={showRequest} className="py-1 text-content underline decoration-faint underline-offset-2">
                      Show request
                    </button>
                  </>
                )}
                {phase === 'ended' && (
                  <>
                    <Sep />
                    <span>The side chat process quit</span>
                  </>
                )}
              </>
            )}
            {ran.split('\n').filter(Boolean).map((part, i) => (
              <Fragment key={i}>
                {(run || i > 0) && <Sep />}
                <span className="shrink-0">{part}</span>
              </Fragment>
            ))}
          </>
        }
      />
      {find.open && (
        <div className="shrink-0 px-4 pb-2">
          <FindField ui="side-find" {...find.field} placeholder="Find in side chat" label="Find in side chat" />
        </div>
      )}
      <div
        data-beside-header=""
        ref={bodyRef}
        onScroll={(e) => {
          const el = e.currentTarget
          setScrolled(el.scrollTop > 0)
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
        className="min-h-0 flex-1 overflow-y-auto px-6 pb-4 pt-2"
      >
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-4">
          {!asked && raw !== 'ended' ? (
            <div className="m-auto flex max-w-[44ch] flex-col gap-1 text-center">
              <p className="text-ui text-content">Ask a side question</p>
              <p className="text-meta text-dim">It sees this conversation up to now. Claude keeps going and won&apos;t see the side chat until you hand it back.</p>
            </div>
          ) : (
            messages.map((m) => (
              <Fragment key={m.id}>
                <MessageView message={m} />
                {m.id === firstEnd && cacheMiss && <CacheNote cost={cacheMiss.costUsd} cold={cacheCold === true} />}
              </Fragment>
            ))
          )}
          <QueuedMessages />
          {live && asked && (
            <div className="flex flex-col gap-1">
              <WorkingTail ui="side-working" bg={false} starting={raw === 'starting'} />
              {silent && <p className="text-meta text-dim">Starting the same MCP servers as this session so the side chat can reuse its prompt cache.</p>}
            </div>
          )}
          {lastError && <TurnError text={lastError} />}
        </div>
      </div>
      <SideDock side={side} ended={raw === 'ended'} asked={messages.some((m) => m.role === 'user')} />
    </div>
  )
}

function CacheNote({ cost, cold }: { cost: number | null; cold: boolean }): JSX.Element {
  const spent = cost === null ? '' : ` It cost ${formatCost(cost)}.`
  return (
    <p data-ui="side-cache-note" className="mt-1 text-meta text-dim">
      {cold
        ? `This answer missed the prompt cache because the side chat's tools didn't match this session's.${spent}`
        : `This answer missed the prompt cache, usually because this session was idle for a while.${spent} Claude's next turn reuses what it cached.`}
    </p>
  )
}

/** The side's composer: text only, Send and Stop in one slot, the gate on top. */
function SideDock({ side, ended, asked }: { side: string; ended: boolean; asked: boolean }): JSX.Element {
  const draft = useActive((s) => s?.draftText ?? '')
  const busy = useActive((s) => !!s?.busy)
  const interrupting = useActive((s) => !!s?.interrupting)
  const turnStartMs = useActive((s) => s?.turnStartMs ?? null)
  const label = asked ? 'Ask a follow-up' : 'Ask a side question'
  const boxRef = useRef<HTMLTextAreaElement>(null)
  // Focus lands here only when an entry point asked for it, never on a plain tab switch.
  useEffect(() => {
    if (takeSurfaceFocus('side')) boxRef.current?.focus()
  }, [])
  const textOnly = (): void => useSession.getState().setNotice('Side chat takes text only.', 'info')
  const send = (): void => {
    const text = draft.trim()
    if (!text || ended) return
    const st = useSession.getState()
    st.setDraftText(side, '')
    void st.sendSide(side, text)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
    e.preventDefault()
    send()
  }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (!e.clipboardData.files.length) return
    e.preventDefault()
    textOnly()
  }
  const files = (e: DragEvent): boolean => Array.from(e.dataTransfer.types).includes('Files')
  return (
    <div className="shrink-0 px-6 pb-4">
      <div
        data-ui="side-dock"
        onDragOver={(e) => files(e) && e.preventDefault()}
        onDrop={(e) => {
          if (!files(e)) return
          e.preventDefault()
          textOnly()
        }}
        className="relative mx-auto flex w-full max-w-3xl flex-col gap-2 rounded-xl border border-border bg-bg-elev p-2 has-[textarea:focus]:border-control-edge"
      >
        <GateHost />
        <p id="side-cap" data-ui="side-capability" className="px-2 pt-0.5 text-meta text-dim">
          {ended ? ENDED : CAPABILITY}
        </p>
        <textarea
          ref={boxRef}
          data-ui="side-composer"
          rows={2}
          aria-label={label}
          placeholder={ended ? '' : label}
          aria-describedby="side-cap"
          disabled={ended}
          value={draft}
          onChange={(e) => useSession.getState().setDraftText(side, e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          className="max-h-48 min-h-[52px] w-full resize-none bg-transparent [field-sizing:content] px-2 pt-1.5 text-sm leading-normal text-content outline-none placeholder:text-dim disabled:cursor-default"
        />
        <div className="flex items-center justify-end pr-[2px]">
          <SendStop
            ui="side-"
            busy={busy || interrupting}
            inert={ended || !draft.trim()}
            turnStartMs={turnStartMs}
            title={ended ? ENDED : undefined}
            onStop={() => !interrupting && void useSession.getState().interrupt(side)}
            onSend={send}
          />
        </div>
      </div>
    </div>
  )
}
