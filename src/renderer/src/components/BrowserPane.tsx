import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useActive, useSession } from '../store'
import { onOcclusion } from '../lib/browserOcclusion'
import { getStage } from '../lib/stage'
import { siteKeyOf } from '../../../shared/browser'
import { PaneHeader, PANE_BTN } from './Stage'
import { BrowserDriveStrip, BrowserToolbar } from './BrowserToolbar'
import { Button } from './Button'
import { IconExternal, IconSettings } from './Icon'

export function BrowserPane(): JSX.Element | null {
  const handleId = useSession((s) => s.activeHandleId)
  return handleId ? <Pane handleId={handleId} /> : null
}

/**
 * The page area is a placeholder the native view is laid over, so the page starts below the band
 * and the pane header: the view covers anything it overlaps. Whenever the view is hidden (another
 * surface overlaps it, a transition runs, the page is suspended) the last still shows in its place.
 */
function Pane({ handleId }: { handleId: string }): JSX.Element {
  const areaRef = useRef<HTMLDivElement>(null)
  const title = useActive((s) => s?.browser?.title ?? '')
  const url = useActive((s) => s?.browser?.url ?? '')
  const still = useActive((s) => s?.browser?.still ?? null)
  const suspended = useActive((s) => s?.browser?.suspended ?? false)
  const wall = useActive((s) => s?.browser?.loginWall === 'hardware')
  const announce = useSession((s) => s.browserAnnounce)
  const openSettings = useSession((s) => s.openSettings)
  const external = !!siteKeyOf(url)

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
  // The cards sit in the page area, so the view has to step aside for them too.
  const visible = !occluded && !suspended && !wall
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
    <div className="relative flex min-h-0 flex-1 flex-col">
      <PaneHeader
        kind="Browser"
        actions={
          <>
            <button
              type="button"
              data-ui="browser-external"
              aria-label="Open in your browser"
              title={external ? 'Open in your browser' : 'Open in your browser. Nothing to open yet.'}
              aria-disabled={!external || undefined}
              onClick={() => {
                if (external) void window.clui.openExternal(url)
              }}
              className={`${PANE_BTN} aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:pointer-fine:hover:bg-transparent aria-disabled:pointer-fine:hover:text-dim`}
            >
              <IconExternal className="h-4 w-4" />
            </button>
            <button
              type="button"
              data-ui="browser-settings"
              aria-label="Browser settings"
              title="Browser settings"
              onClick={() => openSettings('browser')}
              className={PANE_BTN}
            >
              <IconSettings className="h-4 w-4" />
            </button>
          </>
        }
      >
        <span
          data-ui="pane-title"
          tabIndex={-1}
          title={url === 'about:blank' ? undefined : url}
          className="min-w-0 truncate text-ui font-medium text-content"
        >
          {title || siteKeyOf(url) || 'New page'}
        </span>
      </PaneHeader>
      <div aria-hidden="true" className="shrink-0" style={{ height: 'var(--top-h, 0px)' }} />
      <BrowserToolbar handleId={handleId} />
      <BrowserDriveStrip />
      <div data-ui="browser-pane" ref={areaRef} className="relative min-h-0 flex-1 overflow-hidden rounded-lg bg-bg">
        {still && <img src={still} alt="" className="absolute inset-0 h-full w-full object-cover object-left-top" />}
        {suspended ? (
          <div className="absolute inset-0 grid place-items-center scrim">
            <div className="surface-content flex max-w-[320px] flex-col gap-2 rounded-lg bg-bg-elev p-4">
              <p className="text-ui font-medium text-content">Paused to save memory</p>
              <p className="text-meta text-dim">
                Clui keeps 3 pages live at once. Reloading opens the same address; anything typed into the page and the
                scroll position are gone.
              </p>
              {/* Opening a suspended pane lands here rather than on the address. */}
              <button
                type="button"
                data-pane-title=""
                className="btn-primary self-start"
                onClick={() => void window.clui.browserNav(handleId, 'reload')}
              >
                Reload page
              </button>
            </div>
          </div>
        ) : wall ? (
          <div className="absolute inset-0 grid place-items-center scrim">
            <div className="surface-content flex max-w-[320px] flex-col gap-2 rounded-lg bg-bg-elev p-4">
              <p className="text-ui font-medium text-content">This sign-in needs a hardware key or passkey</p>
              <p className="text-meta text-dim">
                Clui&apos;s browser can&apos;t use security keys or device-bound passkeys. Sign in to this site in your
                regular browser, or use a password sign-in if the site offers one.
              </p>
              <Button variant="control" size="sm" data-pane-title="" className="self-start" onClick={() => void window.clui.openExternal(url)}>
                Open in your browser
              </Button>
            </div>
          </div>
        ) : null}
        <span className="sr-only" aria-live="polite">
          {announce}
        </span>
      </div>
    </div>
  )
}
