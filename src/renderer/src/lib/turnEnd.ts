import type { TurnEnd } from '../../../shared/events'
import type { WokenTask } from '../store'
import { formatCost } from './formatCost'

/** `47s` / `1m 03s` / `1h 02m`, shared by the live timers and a finished turn's record. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

export interface TurnLine {
  text: string
  /** Hover text: the line, plus any detail it doesn't show. */
  title: string
  glyph: 'stop' | 'warn' | null
}

const CONTINUE = ' · Send a message to continue'

/** A finished turn's footer line, or null when there's nothing to say. A completed turn whose
 *  background tasks still run says only that, since its duration isn't the whole story yet. */
export function turnEndLine(reason: TurnEnd | undefined, durationMs: number | undefined, waiting: number): TurnLine | null {
  const d = durationMs === undefined ? null : formatElapsed(durationMs)
  const after = d ? ` after ${d}` : ''
  const wait = waiting > 0 ? `Waiting for ${waiting} background task${waiting === 1 ? '' : 's'}` : ''
  const line = (lead: string, glyph: TurnLine['glyph'], opts: { cont?: boolean; detail?: string } = {}): TurnLine => {
    const text = `${lead}${wait ? ` · ${wait}` : ''}${opts.cont ? CONTINUE : ''}`
    return { text, title: opts.detail ? `${text}\n${opts.detail}` : text, glyph }
  }
  switch (reason?.kind) {
    case undefined:
      if (wait) return { text: wait, title: wait, glyph: null }
      return d ? { text: `Worked for ${d}`, title: `Worked for ${d}`, glyph: null } : null
    case 'stopped':
      return line(`Stopped by you${after}`, 'stop')
    case 'max-turns':
      return line(`Stopped at the ${reason.limit ? `${reason.limit}-turn` : 'turn'} limit${after}`, 'stop', { cont: true })
    case 'budget':
      return line(`Stopped at the ${reason.limit !== undefined ? `${formatCost(reason.limit)} ` : ''}budget limit${after}`, 'stop', { cont: true })
    case 'early':
      return line(`Turn ended early${after}`, 'stop', { cont: true, detail: reason.reason })
    case 'failed':
      return line(`Failed${after}`, 'warn')
  }
}

const VERB: Record<WokenTask['status'], string> = { completed: 'finished', failed: 'failed', killed: 'stopped' }

/** The caption over a turn a background task's end started. */
export function wokenLine(tasks: WokenTask[]): { text: string; title: string } {
  if (tasks.length === 1) {
    const [t] = tasks
    const lead = `Background ${t.kind} ${VERB[t.status]}`
    return { text: t.description ? `${lead}: ${t.description}` : lead, title: t.description || lead }
  }
  const failed = tasks.filter((t) => t.status === 'failed').length
  return {
    text: failed ? `${tasks.length} background tasks ended, ${failed} failed` : `${tasks.length} background tasks finished`,
    title: tasks.map((t) => t.description || `Background ${t.kind}`).join('\n')
  }
}
