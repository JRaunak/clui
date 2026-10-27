import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useActive, useSession, viewedTabOf } from '../../store'
import { onOcclusion } from '../../lib/browserOcclusion'
import { getStage } from '../../lib/stage'
import { takeSurfaceFocus } from '../../lib/surfaceFocus'
import { PANE_BTN, type PaneExternal } from './PaneHeader'
import { BrowserDriveStrip, BrowserNetStrip, BrowserToolbar } from '../BrowserToolbar'
import { Button } from '../Button'
import { IconSettings } from '../Icon'
import { loadFailureOf, type LoadError } from '../../../../shared/browser'

const EXTERNAL_LABEL = 'Open in default browser'

/** Why the viewed page can't go to the default browser, which only takes web addresses. */
export function browserExternalBlock(url: string): string | undefined {
  if (!url || url === 'about:blank') return 'Nothing to open yet.'
  if (!/^https?:\/\//i.test(url)) return 'Only web addresses open there.'
}

export function useBrowserExternal(): PaneExternal {
  const url = useActive((s) => viewedTabOf(s?.browser)?.url ?? '')
  return { label: EXTERNAL_LABEL, disabledReason: browserExternalBlock(url), onOpen: () => window.clui.openExternal(url) }
}

export function BrowserSettingsButton(): JSX.Element {
  const openSettings = useSession((s) => s.openSettings)
  return (
    <button
      type="button"
      data-ui="browser-settings"
      aria-label="Browser settings"
      title="Browser settings"
      onClick={() => openSettings('pane', 'browser')}
      className={PANE_BTN}
    >
      <IconSettings className="h-4 w-4" />
    </button>
  )
}

/** An overlay rather than a page in the view, which Claude's snapshot would read as the site's own. */
function LoadFailure({ handleId, tab, err, committed }: { handleId: string; tab: number; err: LoadError; committed: boolean }): JSX.Element {
  const f = loadFailureOf(err)
  const http = err.httpUrl
  // A failure from a blank tab has no page to reload.
  const retry = (): void =>
    void (committed ? window.clui.browserNav(handleId, tab, 'reload') : window.clui.browserNavigate(handleId, tab, err.url))
  return (
    <div data-ui="browser-load-error" className="absolute inset-0 flex flex-col items-start gap-2 bg-bg px-3 py-6">
      <p className="text-ui font-medium text-content">
        {f.pre}
        {f.host && <span className="font-mono">{f.host}</span>}
        {f.post}
      </p>
      <p className="max-w-[60ch] text-meta text-dim">{f.body}</p>
      <p className="font-mono text-meta text-faint">{err.name}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" data-pane-title="" onClick={retry}>
          Retry
        </Button>
        {http && (
          <Button variant="secondary" size="sm" onClick={() => void window.clui.browserNavigate(handleId, tab, http)}>
            Try http://{f.host}
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * The page area is a placeholder the native view is laid over, so the page starts below the band
 * and the pane header: the view covers anything it overlaps. Whenever the view is hidden (another
 * surface overlaps it, a transition runs, a suspended tab is reloading) the viewed tab's last still
 * shows in its place.
 */
export function BrowserSurface({ handleId }: { handleId: string }): JSX.Element {
  const areaRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (takeSurfaceFocus('browser')) document.querySelector<HTMLElement>('[data-ui="browser-url"]')?.focus()
  }, [])
  const url = useActive((s) => viewedTabOf(s?.browser)?.url ?? '')
  const still = useActive((s) => viewedTabOf(s?.browser)?.still ?? null)
  const wall = useActive((s) => viewedTabOf(s?.browser)?.loginWall === 'hardware')
  const loadError = useActive((s) => viewedTabOf(s?.browser)?.loadError ?? null)
  const tab = useActive((s) => s?.browser?.viewed ?? 0)
  const announce = useSession((s) => s.browserAnnounce)

  useEffect(() => {
    const el = areaRef.current
    const stage = getStage()
    if (!el) return
    let raf = 0
    const schedule = (): void => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const r = el.getBoundingClientRect()
        window.clui.browserSetBounds(handleId, {
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height)
        })
      })
    }
    schedule()
    const ro = new ResizeObserver(schedule)
    ro.observe(el)
    window.addEventListener('resize', schedule)
    stage?.addEventListener('transitionend', schedule)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', schedule)
      stage?.removeEventListener('transitionend', schedule)
      cancelAnimationFrame(raf)
    }
  }, [handleId])

  const [occluded, setOccluded] = useState(false)
  useEffect(() => onOcclusion(setOccluded), [])
  // The card and the failure panel sit in the page area, so the view has to step aside for them too.
  const visible = !occluded && !wall && !loadError
  useLayoutEffect(() => {
    void window.clui.browserSetVisible(handleId, visible)
  }, [handleId, visible])
  // Collapsing unmounts the pane; the page stays live in main, only off screen.
  useEffect(
    () => () => {
      void window.clui.browserSetVisible(handleId, false)
    },
    [handleId]
  )

  return (
    <>
      <div aria-hidden="true" className="shrink-0" style={{ height: 'var(--top-h, 0px)' }} />
      <BrowserToolbar handleId={handleId} />
      <BrowserNetStrip />
      <BrowserDriveStrip key={handleId} />
      <div data-ui="browser-pane" ref={areaRef} className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-bg">
        {still && !loadError && <img src={still} alt="" className="absolute inset-0 h-full w-full object-cover object-left-top" />}
        {loadError && <LoadFailure handleId={handleId} tab={tab} err={loadError} committed={!!url && url !== 'about:blank'} />}
        {wall && (
          <div className="absolute inset-0 grid place-items-center scrim">
            <div className="surface-content flex max-w-[320px] flex-col gap-2 rounded-lg bg-bg-elev p-4">
              <p className="text-ui font-medium text-content">This sign-in needs a hardware key or passkey</p>
              <p className="text-meta text-dim">
                Clui&apos;s browser can&apos;t use security keys or device-bound passkeys. Sign in to this site in your
                regular browser, or use a password sign-in if the site offers one.
              </p>
              <Button variant="control" size="sm" data-pane-title="" className="self-start" onClick={() => void window.clui.openExternal(url)}>
                {EXTERNAL_LABEL}
              </Button>
            </div>
          </div>
        )}
        <span className="sr-only" aria-live="polite">
          {announce}
        </span>
      </div>
    </>
  )
}
