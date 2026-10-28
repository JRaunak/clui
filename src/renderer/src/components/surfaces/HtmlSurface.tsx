import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { useActive, useSession } from '../../store'
import { useNativeSlot } from '../../lib/useNativeSlot'
import { requestSurfaceFocus, takePoint, takeSurfaceFocus, usePointRequest } from '../../lib/surfaceFocus'
import { markNoPreview, type NoPreview } from '../../lib/presentation'
import { blockedRow, hostLabel, hostsOf, noticeOf, pageLinkOf, policyParts, SELF_HOST } from '../../lib/htmlView'
import { followFileLink, openLink } from '../../lib/openLink'
import { tilde } from '../../lib/tree'
import { viaOf, type Via } from '../../lib/motion'
import { usePopover } from '../Popover'
import { Button } from '../Button'
import { STRIP_BTN } from '../BrowserToolbar'
import { IconFolderOpen, IconRefresh } from '../Icon'
import { PANE_BTN } from './PaneHeader'
import { cleanError, FileMissing, openDefault, REASON, RETRY, setStatus, STATE_BODY } from './fileDoc'
import type { HtmlBlocked, HtmlPolicy } from '../../../../shared/html-view'
import type { PaneBounds } from '../../../../shared/browser'
import type { Refusal } from '../../../../shared/files'
import { useSay } from '../../lib/useSay'

const LOADING_MS = 400
const MISSING_POLL_MS = 2000

type Opened =
  | { t: 'opening' }
  | { t: 'outside'; why: PageRefusal }
  | { t: 'missing' }
  | { t: 'refused'; reason: Refusal['reason']; message: string }
  | { t: 'open'; viewId: string; policy: HtmlPolicy }

type Failure = { t: 'failed'; name: string } | { t: 'crashed'; reason: string }

const baseOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1) || p
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** A blocked-content strip's message, its spoken form and the full origin list for its title. */
function blockedMessage(cause: 'remote' | 'data' | 'offline', count: number, hosts: string[]): { node: ReactNode; text: string; title: string } {
  const lead =
    cause === 'remote' ? `Blocked ${plural(count, 'file', 'files')}` : cause === 'data' ? `Blocked ${plural(count, 'data request', 'data requests')}` : `Blocked ${plural(count, 'load', 'loads')}`
  const prep = cause === 'data' ? ' to ' : ' from '
  const { shown, sep, rest } = hostsOf(hosts)
  const title = hosts.map(hostLabel).join(', ')
  if (!shown.length) return { node: `${lead}.`, text: `${lead}.`, title }
  return {
    node: (
      <>
        {lead}
        {prep}
        {shown.map((h, i) => (
          <span key={h}>
            {i ? sep : ''}
            {h === SELF_HOST ? h : <span className="font-mono text-code">{h}</span>}
          </span>
        ))}
        {rest}.
      </>
    ),
    text: `${lead}${prep}${shown.join(sep)}${rest}.`,
    title
  }
}

const BLOCKED_DETAIL = {
  remote: 'Web resources are off, so parts of this page may be missing.',
  data: 'Data requests are off. The page needs them to load its data.',
  eval: "Libraries that compile templates in the page, like Alpine or Vue's full build, won't run here.",
  offline: 'Local pages run offline. Pages Claude makes can load from the web.'
} as const
const OFFLINE_SELF = "Local pages run offline and can't fetch data, even from their own folder."
const NO_POINT = "Point isn't available on page previews yet."
/** Main's refusals of a page; size never sends a page to Source. */
type PageRefusal = Exclude<NoPreview, 'too-large'>
const OUTSIDE: Record<PageRefusal, { title: (name: string) => string; body: string }> = {
  denied: { title: (name) => `${name} is outside this session's folder`, body: "Clui runs pages only from the session's folder, so this one can't preview here." },
  'too-broad': {
    title: (name) => `${name} can't preview from this folder`,
    body: 'Pages preview only inside a project folder. With the session at your home folder, a page could read files across it.'
  }
}
const EVAL_MESSAGE = "A script on this page needs eval, which pages in Clui can't use."

/** A file link the user followed in the page at `page`. One that can't open says why and opens no tab. */
async function openPageLink(handleId: string, page: string, href: string, meta: boolean, via: Via): Promise<void> {
  const cwd = useSession.getState().sessions[handleId]?.cwd
  const link = cwd ? pageLinkOf(href, cwd, page) : null
  if (!cwd || !link) return
  const warn = (message: string): void => useSession.getState().setNotice(message, 'warn')
  if (link.t === 'outside') return warn(`${tilde(link.path, window.clui.homeDir)} is outside this session's folder, so the preview can't open it.`)
  if (link.t === 'hidden') return warn(`${link.rel} is a hidden file. Open it with ⌘P if you meant to.`)
  const { ref } = link
  const abs = `${cwd}/${ref.rel}`
  const dir = !(await window.clui.statFile(handleId, abs)).ok
  if (dir && !(await window.clui.listDir(handleId, ref.rel)).ok) return warn(`${ref.rel} doesn't exist in this session's folder.`)
  followFileLink(handleId, abs, ref, dir, meta, via)
}

function PolicyButton({ policy, changedSince, paneTitle, buttonRef }: { policy: HtmlPolicy; changedSince: boolean; paneTitle: boolean; buttonRef: (el: HTMLButtonElement | null) => void }): JSX.Element {
  const openSettings = useSession((s) => s.openSettings)
  const p = usePopover({ placement: 'down', align: 'start' })
  const titleId = useId()
  const parts = policyParts(policy, changedSince)
  const ref = useCallback(
    (el: HTMLButtonElement | null) => {
      p.triggerRef.current = el
      buttonRef(el)
    },
    [p.triggerRef, buttonRef]
  )
  return (
    <>
      <button
        {...p.triggerProps}
        ref={ref}
        type="button"
        data-ui="html-policy"
        aria-haspopup="dialog"
        aria-label={`${parts.join(', ')}. Page rules`}
        {...(paneTitle ? { 'data-pane-title': '' } : {})}
        className="min-h-7 min-w-0 rounded-md px-2 py-1 text-left text-label text-dim transition-colors pointer-fine:hover:bg-[var(--glass-row-hover)] pointer-fine:hover:text-content"
      >
        {parts.map((t, i) => (
          <span key={t}>
            {i ? <span aria-hidden="true"> · </span> : null}
            {t}
          </span>
        ))}
      </button>
      <div {...p.popoverProps} role="dialog" aria-labelledby={titleId} className="pop-base pop glass-thick flex max-w-[340px] flex-col gap-2 rounded-lg p-3 text-meta text-content">
        {policy.artifact ? (
          <>
            <p id={titleId} className="text-label font-semibold">
              What this page can load
            </p>
            <p>{`Scripts, styles and fonts from the web: ${policy.remote ? 'allowed' : 'blocked'}.`}</p>
            <p>{policy.data ? 'Data requests: allowed over HTTPS and WSS, and to localhost.' : 'Data requests: blocked.'}</p>
            <p>{"Files: only this page's folder. No browser logins or cookies."}</p>
            {policy.remote && <p className="text-dim">{"Web scripts run with the page's access and can send what it shows to their servers, even with data requests off."}</p>}
            <p className="text-dim">
              {changedSince ? 'Claude made this page, but it has changed since outside Claude.' : 'Claude made this page in this session. That says who wrote it, not that its code is safe.'}
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="self-start"
              onClick={() => {
                p.close({ returnFocus: false })
                openSettings('pane', 'artifacts')
              }}
            >
              Change in settings
            </Button>
          </>
        ) : (
          <>
            <p id={titleId} className="text-label font-semibold">
              This page runs offline
            </p>
            <p>{"Its own scripts and styles run. Only files in this page's folder load, nothing loads from the web, and it can't send requests."}</p>
            <p className="text-dim">Web access settings apply only to pages Claude makes.</p>
          </>
        )}
      </div>
    </>
  )
}

/**
 * A pane tab's Preview of an HTML file: a sandboxed native page laid over the slot, under a toolbar that states what
 * it may load. Main owns the page and decides its policy; this decides when it shows. The view is closed on unmount,
 * so an inactive tab holds no running page.
 */
export function HtmlSurface({ handleId, tabId, explicit }: { handleId: string; tabId: string; explicit: boolean }): JSX.Element | null {
  const path = useActive((s) => s?.surfaces.tabs[tabId]?.key ?? '')
  const anchor = useActive((s) => s?.surfaces.tabs[tabId]?.location?.anchor)
  const setView = useSession((s) => s.setSurfaceView)
  const openSettings = useSession((s) => s.openSettings)
  const name = baseOf(path)
  const statusKey = `${handleId}\0${path}`

  const [opened, setOpened] = useState<Opened>({ t: 'opening' })
  const [reopen, setReopen] = useState(0)
  // Changed since Claude made it and not run yet.
  const [gate, setGate] = useState(false)
  const [changedSince, setChangedSince] = useState(false)
  const [ready, setReady] = useState(false)
  // The page has painted once in this tab, so the slot is the page's canvas from here on.
  const [painted, setPainted] = useState(false)
  const [slow, setSlow] = useState(false)
  const [still, setStill] = useState<string | null>(null)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [outsideEdit, setOutsideEdit] = useState(false)
  const [stuck, setStuck] = useState(false)
  const [blocked, setBlocked] = useState<(HtmlBlocked & { generation: number }) | null>(null)
  const generation = useRef(0)
  const dismissed = useRef(-1)
  const reloadRef = useRef<HTMLButtonElement | null>(null)
  const policyRef = useRef<HTMLButtonElement | null>(null)
  const setPolicyRef = useCallback((el: HTMLButtonElement | null) => void (policyRef.current = el), [])

  const [said, say] = useSay()

  useEffect(() => {
    if (!path) return
    let live = true
    let id: string | null = null
    setOpened({ t: 'opening' })
    setReady(false)
    setFailure(null)
    setStuck(false)
    setBlocked(null)
    setOutsideEdit(false)
    const slowTimer = setTimeout(() => setSlow(true), LOADING_MS)
    window.clui.htmlOpen(handleId, tabId, path, anchor).then(
      (r) => {
        if (!live) return void (r.ok && window.clui.htmlClose(r.viewId))
        if (!r.ok) {
          if (r.reason === 'denied' || r.reason === 'too-broad') {
            markNoPreview(handleId, path, r.reason)
            return setOpened({ t: 'outside', why: r.reason })
          }
          if (r.reason === 'missing') {
            setStatus(statusKey, 'missing')
            return setOpened({ t: 'missing' })
          }
          return setOpened({ t: 'refused', reason: r.reason, message: REASON[r.reason] })
        }
        id = r.viewId
        setStatus(statusKey, null)
        setOpened({ t: 'open', viewId: r.viewId, policy: r.policy })
        setGate(r.changedSince)
        setChangedSince(r.changedSince)
      },
      (e: unknown) => live && setOpened({ t: 'refused', reason: 'unreadable', message: cleanError(e) })
    )
    return () => {
      live = false
      clearTimeout(slowTimer)
      if (id) void window.clui.htmlClose(id)
    }
  }, [handleId, tabId, path, anchor, statusKey, reopen])
  useEffect(() => () => setStatus(statusKey, null), [statusKey])

  // A deleted page comes back on its own, as a missing File tab does.
  useEffect(() => {
    if (opened.t !== 'missing') return
    const t = setInterval(() => void window.clui.statFile(handleId, path).then((s) => s.ok && setReopen((n) => n + 1)), MISSING_POLL_MS)
    return () => clearInterval(t)
  }, [opened.t, handleId, path])

  const viewId = opened.t === 'open' ? opened.viewId : null
  const artifact = opened.t === 'open' && opened.policy.artifact
  useEffect(() => {
    if (!viewId) return
    return window.clui.onHtmlEvent((e) => {
      if (e.viewId !== viewId) return
      switch (e.type) {
        case 'dom-ready':
          generation.current = e.generation
          setReady(true)
          setPainted(true)
          setFailure(null)
          setStuck(false)
          setBlocked((b) => (b && b.generation < e.generation ? null : b))
          break
        case 'load-failed':
          setFailure({ t: 'failed', name: e.name })
          break
        case 'crashed':
          setFailure({ t: 'crashed', reason: e.reason })
          setStuck(false)
          break
        case 'unresponsive':
          setStuck(true)
          break
        case 'responsive':
          setStuck(false)
          break
        case 'blocked':
          if (e.generation >= generation.current && e.generation !== dismissed.current) setBlocked(e)
          break
        case 'changed':
          if (e.byClaude) {
            setOutsideEdit(false)
            setChangedSince(false)
            setGate(false)
            void window.clui.htmlReload(viewId)
            say("Page updated with Claude's edit.")
          } else {
            if (artifact) setChangedSince(true)
            // A page that hasn't run yet already says it changed.
            if (!gate) setOutsideEdit(true)
          }
          break
        case 'missing':
          setStatus(statusKey, 'missing')
          setOpened({ t: 'missing' })
          break
        case 'still':
          setStill(e.still)
          break
        case 'link':
          void openLink(e.url, e.meta)
          break
        case 'file-link':
          void openPageLink(handleId, path, e.href, e.meta, e.via)
          break
        case 'recreated':
          setOpened((o) => (o.t === 'open' && o.viewId === e.viewId ? { ...o, policy: e.policy } : o))
          setBlocked(null)
          say('Page reloaded with the new settings.')
          break
      }
    })
  }, [viewId, artifact, gate, statusKey, say, handleId, path])

  const areaRef = useRef<HTMLDivElement>(null)
  const report = useCallback((b: PaneBounds) => viewId && window.clui.htmlSetBounds(viewId, b), [viewId])
  const occluded = useNativeSlot(areaRef, report)
  const shown = !!viewId && ready && !gate && !failure
  useLayoutEffect(() => {
    if (viewId) void window.clui.htmlSetVisible(viewId, shown && !occluded)
  }, [viewId, shown, occluded])
  // A user open lands on the page's region once there's a page, so its label is what a screen reader says.
  useEffect(() => {
    if (shown && takeSurfaceFocus(tabId)) areaRef.current?.focus({ preventScroll: true })
  }, [shown, tabId])

  // Under the changed-since gate any reload is Run, so it clears the gate.
  const reload = (): void => {
    if (!viewId) return setReopen((n) => n + 1)
    setGate(false)
    setOutsideEdit(false)
    void window.clui.htmlReload(viewId)
  }
  const showSource = (e: MouseEvent): void => {
    requestSurfaceFocus(tabId, viaOf(e))
    setView(handleId, tabId, { mode: 'source' })
  }
  const reveal = (): void =>
    void window.clui.revealPath(handleId, path).then((r) => {
      if (!r.ok) useSession.setState({ notice: { message: r.message, tone: 'error' } })
    })
  const toSettings = (): void => openSettings('pane', 'artifacts')

  const row = opened.t === 'open' && blocked ? blockedRow(opened.policy, blocked) : null
  const notice = viewId && !gate ? noticeOf({ changed: outsideEdit, stuck, blocked: !!row }) : null
  const message =
    notice === 'changed'
      ? { node: 'This page changed outside Claude.', text: 'This page changed outside Claude.', title: undefined }
      : notice === 'stuck'
        ? { node: "This page isn't responding.", text: "This page isn't responding.", title: undefined }
        : row
          ? row.cause === 'eval'
            ? { node: EVAL_MESSAGE, text: EVAL_MESSAGE, title: undefined }
            : blockedMessage(row.cause, row.count, blocked?.hosts ?? [])
          : null
  // Said once as a strip appears, not again as a later block in the same load updates its counts.
  const spoken = useRef('')
  spoken.current = message?.text ?? ''
  const noticeKey = notice === 'blocked' ? `blocked:${row?.cause}:${blocked?.generation}` : notice
  useEffect(() => {
    if (noticeKey) say(spoken.current)
  }, [noticeKey, say])

  const asked = usePointRequest(tabId)
  useEffect(() => {
    if (asked && takePoint(tabId)) say(NO_POINT)
  }, [asked, tabId, say])

  if (opened.t === 'outside' && !explicit) return null

  let state: JSX.Element | null = null
  if (opened.t === 'outside') {
    state = (
      <div className={STATE_BODY}>
        <p className="text-ui font-medium text-content">{OUTSIDE[opened.why].title(name)}</p>
        <p className="max-w-[60ch] text-meta text-dim">{OUTSIDE[opened.why].body}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" data-pane-title="" onClick={showSource}>
            Show source
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void openDefault(handleId, path)}>
            Open in default app
          </Button>
        </div>
      </div>
    )
  } else if (opened.t === 'missing') {
    state = <FileMissing handleId={handleId} path={path} />
  } else if (gate) {
    state = (
      <div className={STATE_BODY}>
        <p className="text-ui font-medium text-content">This page changed after Claude made it</p>
        <p className="max-w-[60ch] text-meta text-dim">{"The code that would run now isn't only Claude's."}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              reload()
              reloadRef.current?.focus()
            }}
          >
            Run the page
          </Button>
          <Button variant="secondary" size="sm" onClick={showSource}>
            Show source
          </Button>
        </div>
      </div>
    )
  } else if (failure || opened.t === 'refused') {
    const retry = !!failure || (opened.t === 'refused' && RETRY.has(opened.reason))
    state = (
      <div className={STATE_BODY}>
        <p className="text-ui font-medium text-content">{failure?.t === 'crashed' ? 'This page stopped' : `Couldn't load ${name}`}</p>
        {failure?.t === 'crashed' ? (
          <p className="max-w-[60ch] text-meta text-dim">{`Its process ended (${failure.reason}).`}</p>
        ) : failure ? (
          <p className="font-mono text-meta text-faint">{failure.name}</p>
        ) : (
          opened.t === 'refused' && opened.message && <p className="max-w-[60ch] text-meta text-dim">{opened.message}</p>
        )}
        <div className="flex flex-wrap gap-2">
          {retry && (
            <Button variant="secondary" size="sm" data-pane-title="" onClick={reload}>
              Reload
            </Button>
          )}
          <Button variant="secondary" size="sm" {...(retry ? {} : { 'data-pane-title': '' })} onClick={showSource}>
            Show source
          </Button>
        </div>
      </div>
    )
  }

  const loading = !painted && !state && slow
  return (
    <>
      <div aria-hidden="true" className="shrink-0" style={{ height: 'var(--top-h, 0px)' }} />
      {opened.t === 'open' && (
        <div data-ui="html-toolbar" className="flex min-h-9 shrink-0 flex-wrap items-center gap-1 border-b border-border px-1">
          <button ref={reloadRef} type="button" data-ui="html-reload" aria-label="Reload page" title="Reload ⌘R" onClick={reload} className={PANE_BTN}>
            <IconRefresh className="h-4 w-4" />
          </button>
          <div className="flex min-w-0 flex-1">
            <PolicyButton policy={opened.policy} changedSince={changedSince} paneTitle={!failure} buttonRef={setPolicyRef} />
          </div>
          <button type="button" data-ui="html-reveal" aria-label="Reveal in Finder" title="Reveal in Finder" onClick={reveal} className={PANE_BTN}>
            <IconFolderOpen className="h-4 w-4" />
          </button>
        </div>
      )}
      {notice && message && (
        <div
          role="region"
          aria-label={notice === 'changed' ? 'Page changed' : notice === 'stuck' ? 'Page not responding' : 'Blocked content'}
          data-ui="html-strip"
          data-notice={notice === 'blocked' ? row?.cause : notice}
          className="flex shrink-0 items-center gap-2 border-b border-border bg-tool px-3 py-1.5"
        >
          <div className="flex min-w-0 flex-1 flex-col">
            <p className="break-words text-label text-content" title={message.title}>
              {message.node}
            </p>
            <p className="text-label text-dim">
              {notice === 'changed' ? 'Reload to run the changed page.' : notice === 'stuck' ? 'A script may be stuck in a loop.' : row?.cause === 'offline' && blocked?.hosts.includes('self') ? OFFLINE_SELF : row && BLOCKED_DETAIL[row.cause]}
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {notice === 'changed' ? (
              <>
                <button
                  type="button"
                  className={STRIP_BTN}
                  onClick={() => {
                    reload()
                    reloadRef.current?.focus()
                  }}
                >
                  Reload
                </button>
                <button
                  type="button"
                  className={STRIP_BTN}
                  onClick={() => {
                    setOutsideEdit(false)
                    policyRef.current?.focus()
                  }}
                >
                  Dismiss
                </button>
              </>
            ) : notice === 'stuck' ? (
              <>
                <button type="button" className={STRIP_BTN} onClick={reload}>
                  Reload
                </button>
                <button type="button" className={STRIP_BTN} onClick={showSource}>
                  Show source
                </button>
              </>
            ) : (
              <>
                {row?.cause === 'remote' || row?.cause === 'data' ? (
                  <button type="button" className={STRIP_BTN} onClick={toSettings}>
                    Change in settings
                  </button>
                ) : (
                  <button type="button" className={STRIP_BTN} onClick={() => void openDefault(handleId, path)}>
                    Open in default app
                  </button>
                )}
                <button
                  type="button"
                  className={STRIP_BTN}
                  onClick={() => {
                    dismissed.current = blocked?.generation ?? -1
                    setBlocked(null)
                    policyRef.current?.focus()
                  }}
                >
                  Dismiss
                </button>
              </>
            )}
          </div>
        </div>
      )}
      <div
        ref={areaRef}
        data-ui="html-pane"
        data-native-slot=""
        role="region"
        aria-label={`${name}, page`}
        aria-busy={(!painted && !state) || undefined}
        tabIndex={shown ? 0 : undefined}
        // Only a DOM focus move: main refocusing the window lands here with no relatedTarget, and mustn't bounce focus back into the page.
        onFocus={(e) => {
          if (e.target === e.currentTarget && e.relatedTarget && viewId && shown) void window.clui.htmlFocus(viewId)
        }}
        className={`relative min-h-0 flex-1 overflow-hidden rounded-lg ${painted ? 'bg-page-canvas' : 'bg-bg'}`}
      >
        {still && !state && <img src={still} alt="" className="absolute inset-0 h-full w-full object-cover object-left-top" />}
        {loading && <p className="px-4 py-6 text-meta text-dim">{`Loading ${name}`}</p>}
        {state && <div className="absolute inset-0 overflow-y-auto bg-bg">{state}</div>}
      </div>
      <span className="sr-only" aria-live="polite">
        {said}
      </span>
    </>
  )
}
