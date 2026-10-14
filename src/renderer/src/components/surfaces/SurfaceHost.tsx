import { useSession } from '../../store'
import { PaneHeader } from './PaneHeader'
import { SurfaceTabs } from './SurfaceTabs'
import { BrowserSettingsButton, BrowserSurface, useBrowserExternal } from './BrowserSurface'

/** The Surfaces pane: the header and its tab strip over the active surface's body. */
export function SurfaceHost(): JSX.Element | null {
  const handleId = useSession((s) => s.activeHandleId)
  const external = useBrowserExternal()
  if (!handleId) return null
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <PaneHeader external={external} actions={<BrowserSettingsButton />}>
        <SurfaceTabs key={handleId} />
      </PaneHeader>
      <BrowserSurface handleId={handleId} />
    </div>
  )
}
