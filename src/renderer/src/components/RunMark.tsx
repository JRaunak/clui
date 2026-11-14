/** One status mark for every agent and workflow surface. Each state has its own shape, so it reads in greyscale; only
 *  failed and needs take a hue, and running is never the accent. */
import { useState } from 'react'
import { REASON_COPY, RUN_WORDS, type InterruptReason, type RunState } from '../lib/agents'
import { formatElapsed } from '../lib/turnEnd'
import { RunningTimer } from './InstrumentRow'

const INK: Record<RunState, string> = {
  queued: 'text-faint',
  unrun: 'text-faint',
  running: 'text-dim',
  background: 'text-dim',
  done: 'text-dim',
  failed: 'text-err',
  stopped: 'text-dim',
  interrupted: 'text-dim',
  needs: 'text-warn',
  stopping: 'text-dim'
}

const ARC = 'M6 1.75A4.25 4.25 0 1 1 1.75 6'

function Spin(): JSX.Element {
  const [delay] = useState(() => `-${Date.now() % 2800}ms`)
  return (
    <g className="run-spin" style={{ animationDelay: delay }}>
      <path d={ARC} />
    </g>
  )
}

function Shape({ state }: { state: RunState }): JSX.Element {
  switch (state) {
    case 'queued':
      return <circle cx="6" cy="6" r="4.25" strokeDasharray="2.2 2.25" />
    case 'unrun':
      return <path d="M3.5 6h5" />
    case 'running':
    case 'stopping':
      return <Spin />
    case 'background':
      return (
        <>
          <Spin />
          <circle cx="6" cy="6" r="1.5" fill="currentColor" stroke="none" />
        </>
      )
    case 'done':
      return <path d="M2.6 6.3 4.9 8.6 9.4 3.6" />
    case 'failed':
      return <path fill="currentColor" stroke="none" fillRule="evenodd" d="M6 .75a5.25 5.25 0 1 0 0 10.5A5.25 5.25 0 1 0 6 .75ZM5.25 3h1.5v4h-1.5ZM5.25 8.1h1.5v1.5h-1.5Z" />
    case 'stopped':
      return <rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" />
    case 'interrupted':
      return (
        <>
          <rect x="2.25" y="2.25" width="7.5" height="7.5" rx="1.5" />
          <path d="M4.1 7.9 7.9 4.1" />
        </>
      )
    case 'needs':
      return <path fill="currentColor" stroke="none" d="M6 .9 10.4 2.6v3.1c0 2.7-1.8 4.6-4.4 5.4-2.6-.8-4.4-2.7-4.4-5.4V2.6Z" />
  }
}

/** The bare mark. It has no text: whoever places it puts the word beside it or in an accessible name. */
export function RunMark({ state, className = '' }: { state: RunState; className?: string }): JSX.Element {
  return (
    <span data-run={state} className={`flex h-3 w-3 shrink-0 items-center justify-center ${INK[state]} ${className}`}>
      <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <Shape state={state} />
      </svg>
    </span>
  )
}

/** Mark, word and figure. An unknown duration shows nothing, never 0s. `word` renames the state for one caller. */
export function RunStatus({ state, startMs, durationMs, reason, word }: { state: RunState; startMs?: number; durationMs?: number; reason?: InterruptReason; word?: string }): JSX.Element {
  const live = state === 'running' || state === 'background' || state === 'needs'
  const ended = state === 'done' ? 'in' : state === 'failed' || state === 'stopped' ? 'after' : null
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-meta">
      <RunMark state={state} />
      <span className={state === 'failed' || state === 'needs' ? 'text-content' : 'text-dim'}>
        {word ?? RUN_WORDS[state].word}
        {live && startMs !== undefined && (
          <>
            {' '}
            <RunningTimer startMs={startMs} />
          </>
        )}
        {ended && durationMs !== undefined && (
          <>
            {` ${ended} `}
            <span className="font-mono tabular-nums text-dim">{formatElapsed(durationMs)}</span>
          </>
        )}
      </span>
      {state === 'interrupted' && reason && (
        <>
          <span className="text-faint" aria-hidden="true">
            ·
          </span>
          <span className="text-dim">{REASON_COPY[reason]}</span>
        </>
      )}
    </span>
  )
}
