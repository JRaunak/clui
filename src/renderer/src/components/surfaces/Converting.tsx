import { useCallback, useEffect, useRef, useState } from 'react'
import type { SourceVersion } from '../../../../shared/context'
import { isOds, type LoState } from '../../../../shared/office'
import { useSession } from '../../store'
import { TEXT_BTN } from './fileDoc'

/** Nothing shows for a second: a warm conversion lands in under one, and a cold one would flash its headline. */
const QUIET_MS = 1000
/** Once shown, the state stays this long, so it never blinks. */
const HOLD_MS = 500
/** A 10-page document's budget; past it the user is told the ceiling. */
const LONG_MS = 8000

export type Done = { id: string; by: string; version: SourceVersion; revision: string }
export type Conv =
  | { t: 'idle' }
  | LoState
  | { t: 'failed' | 'timeout' | 'stopped' }

/**
 * One tab's place on LibreOffice's conversion of a file at `revision`. `done` is the newest finished conversion and
 * outlives the next revision's job, so the old pages stay up while the new ones convert. `onStale`: the file changed
 * under the job; `onMissing`: LibreOffice is gone, so the pre-flight runs again. A null revision converts nothing.
 */
export function useConversion(handleId: string, path: string, revision: string | null, on: { onStale(): void; onMissing(): void }) {
  const [conv, setConv] = useState<Conv>({ t: 'idle' })
  const [done, setDone] = useState<Done | null>(null)
  const [shownAt, setShownAt] = useState(0)
  const [run, setRun] = useState({ n: 0, fresh: false })
  const onRef = useRef(on)
  onRef.current = on
  const shownRef = useRef(0)
  shownRef.current = shownAt
  const ticketRef = useRef('')

  useEffect(() => {
    if (revision === null) return
    const ticket = (ticketRef.current = crypto.randomUUID())
    let live = true
    let settled = false
    setConv({ t: 'idle' })
    setShownAt(0)
    const quiet = setTimeout(() => live && setShownAt(Date.now()), QUIET_MS)
    let hold: ReturnType<typeof setTimeout> | undefined
    const off = window.clui.onOfficeConvertState((e) => {
      if (e.ticket !== ticket || !live) return
      setConv(e.t === 'waiting' ? { t: 'waiting', other: e.other } : { t: 'running', startedAt: e.startedAt })
    })
    void window.clui
      .officeConvert(handleId, path, revision, ticket, run.fresh)
      .catch(() => ({ ok: false as const, why: 'failed' as const }))
      .then((r) => {
        settled = true
        if (!live) return
        clearTimeout(quiet)
        const land = (): void => {
          if (!live) return
          if (r.ok) {
            useSession.getState().invalidateSource(handleId, `${isOds(path) ? 'sheet' : 'doc'}:${path}`, { reason: 'reconverted', by: r.by })
            setDone({ id: r.id, by: r.by, version: r.version, revision })
            setConv({ t: 'idle' })
          } else if ('reason' in r || r.why === 'changed') onRef.current.onStale()
          else if (r.why === 'missing') onRef.current.onMissing()
          else setConv({ t: r.why })
        }
        const left = shownRef.current ? HOLD_MS - (Date.now() - shownRef.current) : 0
        if (left > 0) hold = setTimeout(land, left)
        else land()
      })
    return () => {
      live = false
      off()
      clearTimeout(quiet)
      clearTimeout(hold)
      if (!settled) void window.clui.officeConvertStop(ticket)
    }
  }, [handleId, path, revision, run])

  // main answers the detached ticket's ask with `stopped`, which lands as the state.
  const stop = useCallback(() => void window.clui.officeConvertStop(ticketRef.current), [])
  const again = useCallback((fresh = false) => setRun((r) => ({ n: r.n + 1, fresh })), [])
  return { conv, done, shown: shownAt > 0, stop, again }
}

/** `4s`, from the job's start, never `0s`. */
function Elapsed({ startedAt }: { startedAt: number }): JSX.Element {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <span aria-hidden="true" className="tabular-nums">
      {`${Math.max(1, Math.floor((now - startedAt) / 1000))}s`}
    </span>
  )
}

/** Whether a running job has passed the 8s budget, flipping once. */
function useLong(conv: Conv): boolean {
  const startedAt = conv.t === 'running' ? conv.startedAt : 0
  const [long, setLong] = useState(false)
  useEffect(() => {
    setLong(false)
    if (!startedAt) return
    const left = LONG_MS - (Date.now() - startedAt)
    if (left <= 0) return setLong(true)
    const t = setTimeout(() => setLong(true), left)
    return () => clearTimeout(t)
  }, [startedAt])
  return long
}

const LONG = 'Long documents can take up to a minute.'

/** The converting state in a viewport: a still headline and a seconds count, never a bar or a spinner. */
export function ConvertingBody({ name, conv, onStop }: { name: string; conv: Conv; onStop(): void }): JSX.Element | null {
  const long = useLong(conv)
  if (conv.t !== 'waiting' && conv.t !== 'running') return null
  return (
    <>
      <div role="status" className="flex flex-col items-start gap-1">
        <p className="text-ui font-medium text-content">{conv.t === 'waiting' ? `Waiting to convert ${name}` : `Converting ${name}`}</p>
        {conv.t === 'waiting' ? (
          <p className="max-w-[60ch] text-meta text-dim">{`Clui converts one document at a time. ${conv.other} is converting now.`}</p>
        ) : (
          <p className="text-meta text-dim">
            <Elapsed startedAt={conv.startedAt} />
          </p>
        )}
        {long && <p className="text-meta text-dim">{LONG}</p>}
      </div>
      <button type="button" data-ui="convert-stop" className={`${TEXT_BTN} -ml-2`} onClick={onStop}>
        Stop
      </button>
    </>
  )
}

/** The New version banner's words and controls, over the pages of the version before. */
export function ConvertingBanner({ name, conv, onStop, onAgain }: { name: string; conv: Conv; onStop(): void; onAgain(): void }): JSX.Element | null {
  if (conv.t === 'stopped')
    return (
      <>
        <p className="min-w-0 flex-1 py-1">{`Showing the previous version. ${name} changed on disk.`}</p>
        <button type="button" className={TEXT_BTN} onClick={onAgain}>
          Convert again
        </button>
      </>
    )
  if (conv.t !== 'waiting' && conv.t !== 'running') return null
  return (
    <>
      <p role="status" className="min-w-0 flex-1 py-1">
        {`${name} changed. Converting the new version.`}{' '}
        {conv.t === 'running' && <Elapsed startedAt={conv.startedAt} />}
      </p>
      <button type="button" data-ui="convert-stop" className={TEXT_BTN} onClick={onStop}>
        Stop
      </button>
    </>
  )
}
