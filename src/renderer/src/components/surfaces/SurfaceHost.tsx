import { surfaceKindOf, useActive, useSession } from '../../store'
import { PaneHeader } from './PaneHeader'
import { SurfaceTabs } from './SurfaceTabs'
import { BrowserSettingsButton, BrowserSurface, useBrowserExternal } from './BrowserSurface'
import { DiffSurface, useDiffExternal } from './DiffSurface'
import { FileSurface, GoToLineButton, useFileExternal } from './FileSurface'

/** The Surfaces pane: one header whose tab strip outlives a switch between kinds, over the active
 *  surface's body. Only the active surface is mounted, so the browser's native view shows only
 *  while a browser tab is active in an open pane. */
export function SurfaceHost(): JSX.Element | null {
  const handleId = useSession((s) => s.activeHandleId)
  const kind = useActive((s) => (s ? surfaceKindOf(s.surfaces, s.surfaces.active) : null))
  const browserExternal = useBrowserExternal()
  const diffExternal = useDiffExternal(handleId)
  const activeId = useActive((s) => s?.surfaces.active ?? null)
  const filePath = useActive((s) => (kind === 'file' && activeId ? (s?.surfaces.tabs[activeId]?.key ?? null) : null))
  const fileExternal = useFileExternal(handleId, filePath)
  if (!handleId) return null
  const browser = kind === 'browser'
  const external = browser ? browserExternal : kind === 'diff' ? diffExternal : kind === 'file' ? fileExternal : undefined
  const actions = browser ? <BrowserSettingsButton /> : kind === 'file' ? <GoToLineButton handleId={handleId} path={filePath} /> : undefined
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <PaneHeader external={external} actions={actions}>
        <SurfaceTabs key={handleId} />
      </PaneHeader>
      {browser && <BrowserSurface handleId={handleId} />}
      {kind === 'diff' && <DiffSurface key={handleId} handleId={handleId} />}
      {kind === 'file' && activeId && <FileSurface key={`${handleId}\0${activeId}`} handleId={handleId} tabId={activeId} />}
    </div>
  )
}
