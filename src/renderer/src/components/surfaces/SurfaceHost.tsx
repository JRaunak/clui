import { surfaceKindOf, useActive, useSession } from '../../store'
import { PaneHeader } from './PaneHeader'
import { SurfaceTabs } from './SurfaceTabs'
import { BrowserSettingsButton, BrowserSurface, useBrowserExternal } from './BrowserSurface'

/** The Surfaces pane: one header whose tab strip outlives a switch between kinds, over the active
 *  surface's body. Only the active surface is mounted, so the browser's native view shows only
 *  while a browser tab is active in an open pane. */
export function SurfaceHost(): JSX.Element | null {
  const handleId = useSession((s) => s.activeHandleId)
  const kind = useActive((s) => (s ? surfaceKindOf(s.surfaces, s.surfaces.active) : null))
  const browserExternal = useBrowserExternal()
  if (!handleId) return null
  const browser = kind === 'browser'
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <PaneHeader external={browser ? browserExternal : undefined} actions={browser ? <BrowserSettingsButton /> : undefined}>
        <SurfaceTabs key={handleId} />
      </PaneHeader>
      {browser && <BrowserSurface handleId={handleId} />}
    </div>
  )
}
