import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useActive, useSession, EMPTY_PENDING, type PendingPermission } from '../store'
import { reducedMotion } from '../lib/motion'
import { PermissionGate } from './gates/PermissionGate'
import { PlanGate } from './gates/PlanGate'
import { QuestionGate } from './gates/QuestionGate'
import { LoginGate } from './gates/LoginGate'
import { focusComposer, type GateCount } from './gates/GateFrame'

const cssVar = (name: string): string => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
// The minifier rewrites 150ms as .15s, so the unit has to be read, not assumed.
const cssMs = (name: string): number => {
  const v = cssVar(name)
  const n = parseFloat(v) || 0
  return v.endsWith('ms') ? n : v.endsWith('s') ? n * 1000 : n
}

/**
 * The active session's oldest pending request, rendered as a Gate at the top of the composer dock.
 * The dock and the Gate are one surface: on arrival the dock takes its new height at once and a clip
 * reveals the Gate upward, so it reads as the dock growing. The request leaves the store the moment
 * it's answered, so the leaving Gate is kept (inert) until its exit finishes.
 */
export function GateHost(): JSX.Element | null {
  const pending = useActive((s) => s?.pendingPermissions ?? EMPTY_PENDING)
  const handleId = useSession((s) => s.activeHandleId)
  const current = pending[0] ?? null

  const [shown, setShown] = useState<PendingPermission | null>(current)
  const [leaving, setLeaving] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const anims = useRef<Animation[]>([])
  const shownRef = useRef(shown)
  const lastHandle = useRef(handleId)
  const mounted = useRef(false)
  // True when the next Gate should appear without motion: first mount, or a session switch.
  const instant = useRef(true)
  const prevShownId = useRef<string | null>(current?.requestId ?? null)

  const stop = (): void => {
    for (const a of anims.current) a.cancel()
    anims.current = []
  }

  useLayoutEffect(() => {
    shownRef.current = shown
  })

  // Follow the store. A new request replaces whatever is shown; an emptied queue starts the exit,
  // except on a session switch or under reduced motion, where the Gate simply goes.
  useLayoutEffect(() => {
    const first = !mounted.current
    mounted.current = true
    const switched = lastHandle.current !== handleId
    lastHandle.current = handleId
    stop()
    if (current) {
      instant.current = first || switched
      setLeaving(false)
      setShown(current)
      return
    }
    if (!shownRef.current) return
    if (first || switched || reducedMotion() || !wrapRef.current) {
      setLeaving(false)
      setShown(null)
      return
    }
    // The Gate goes inert while it leaves, which would drop focus to body.
    if (wrapRef.current.contains(document.activeElement)) focusComposer()
    setLeaving(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.requestId, handleId])

  // Enter: content rises in; the clip reveal runs only when the dock had no Gate before.
  useLayoutEffect(() => {
    const id = shown?.requestId ?? null
    const from = prevShownId.current
    prevShownId.current = id
    const wrap = wrapRef.current
    if (!id || !wrap || leaving || id === from || instant.current || reducedMotion()) return
    const dur = cssMs('--dur-base')
    anims.current.push(
      wrap.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], {
        duration: dur,
        easing: cssVar('--ease-out')
      })
    )
    const dock = wrap.closest<HTMLElement>('[data-ui="composer-dock"]')
    if (from === null && dock) {
      // The negative side and bottom insets keep the dock's halo outside the clip, so it doesn't
      // pop back when the clip releases.
      anims.current.push(
        dock.animate(
          [{ clipPath: `inset(${wrap.offsetHeight}px -64px -64px -64px)` }, { clipPath: 'inset(0 -64px -64px -64px)' }],
          { duration: dur, easing: cssVar('--ease-snap') }
        )
      )
    }
  }, [shown?.requestId, leaving])

  // Exit: contents fade, then the clip closes the Gate area back into the dock.
  useEffect(() => {
    if (!leaving) return
    const wrap = wrapRef.current
    const dock = wrap?.closest<HTMLElement>('[data-ui="composer-dock"]')
    if (!wrap || !dock) {
      setLeaving(false)
      setShown(null)
      return
    }
    let live = true
    const fast = cssMs('--dur-fast')
    const easing = cssVar('--ease-in')
    const h = wrap.offsetHeight
    const fade = wrap.animate([{ opacity: 1 }, { opacity: 0 }], { duration: fast, easing, fill: 'forwards' })
    anims.current.push(fade)
    fade.finished
      .then(() => {
        if (!live) return
        const clip = dock.animate(
          [{ clipPath: 'inset(0 -64px -64px -64px)' }, { clipPath: `inset(${h}px -64px -64px -64px)` }],
          { duration: fast, easing, fill: 'forwards' }
        )
        anims.current.push(clip)
        return clip.finished
      })
      .then(() => {
        if (!live) return
        setLeaving(false)
        setShown(null)
      })
      // A new request cancelled the exit; the store-following effect already took over.
      .catch(() => {})
    return () => {
      live = false
    }
  }, [leaving])

  // The exit holds the dock clipped (fill: forwards). Release it before the Gate-less dock paints.
  useLayoutEffect(() => {
    if (!shown) stop()
  }, [shown])

  // React 18 doesn't forward the `inert` attribute, so set the DOM property.
  useLayoutEffect(() => {
    if (wrapRef.current) wrapRef.current.inert = leaving
  }, [leaving, shown])

  if (!shown) return null
  const count: GateCount = { index: 1, total: leaving ? 1 : pending.length }
  const key = `${handleId ?? ''}:${shown.requestId}`
  return (
    <div ref={wrapRef} className="-mx-2 -mt-2 border-b border-border">
      {shown.toolName === 'AskUserQuestion' ? (
        <QuestionGate key={key} request={shown} count={count} />
      ) : shown.toolName === 'ExitPlanMode' ? (
        <PlanGate key={key} request={shown} count={count} />
      ) : shown.toolName === 'BrowserSite' ? (
        <SiteGate key={key} request={shown} count={count} />
      ) : shown.toolName === 'BrowserLogin' ? (
        <LoginGate key={key} request={shown} count={count} />
      ) : (
        <PermissionGate key={key} request={shown} count={count} />
      )}
    </div>
  )
}

/** The first time Claude, or a page it drives, opens a site. One approval covers every session, so the copy says so. */
function SiteGate({ request, count }: { request: PendingPermission; count: GateCount }): JSX.Element {
  const bypass = useActive((s) => s?.permissionMode === 'bypassPermissions')
  const site = request.displayName ?? ''
  const input = request.input as { cause?: string; from?: string | null } | null
  const byPage = input?.cause === 'page'
  const from = input?.from ?? null
  return (
    <PermissionGate
      request={request}
      count={count}
      copy={{
        title: byPage ? (
          from ? (
            <>
              <span className="font-mono">{from}</span> wants to open <span className="font-mono">{site}</span>. Allow it?
            </>
          ) : (
            <>
              This page wants to open <span className="font-mono">{site}</span>. Allow it?
            </>
          )
        ) : (
          <>
            Allow Claude to open <span className="font-mono">{site}</span>?
          </>
        ),
        description: `This approves ${site} for every session. You can remove it in Settings → Browser.`,
        allowLabel: `Allow ${site}`,
        note: bypass ? "Autonomous mode doesn't skip site approvals." : undefined
      }}
    />
  )
}

function announcementOf(p: PendingPermission): string {
  if (p.toolName === 'ExitPlanMode') return 'Plan ready: review the plan'
  if (p.toolName === 'BrowserSite') return `Permission required: open ${p.displayName}`
  if (p.toolName === 'BrowserLogin') return `Sign-in needed: ${p.displayName}`
  if (p.toolName === 'AskUserQuestion') {
    const q = (p.input as { questions?: { question?: unknown }[] } | null)?.questions?.[0]?.question
    return typeof q === 'string' ? `Question: ${q}` : 'Question from Claude'
  }
  return `Permission required: Allow ${p.displayName || p.toolName}`
}

/**
 * Announces each new request assertively. It lives in App's overlay host, not in the Gate, so it
 * still speaks while the composer is unmounted (a subagent view). The keyed span remounts per
 * request, so two identical titles in a row are still announced.
 */
export function GateAnnouncer(): JSX.Element {
  const head = useActive((s) => (s?.pendingPermissions ?? EMPTY_PENDING)[0] ?? null)
  return (
    <div className="sr-only" aria-live="assertive">
      {head && <span key={head.requestId}>{announcementOf(head)}</span>}
    </div>
  )
}
