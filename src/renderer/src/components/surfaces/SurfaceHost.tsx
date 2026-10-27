import { surfaceKindOf, useActive, useSession } from '../../store'
import { PaneHeader } from './PaneHeader'
import { SurfaceTabs } from './SurfaceTabs'
import { BrowserSettingsButton, BrowserSurface, useBrowserExternal } from './BrowserSurface'
import { DiffSurface, useDiffExternal } from './DiffSurface'
import { FileSurface, useFileExternal } from './FileSurface'
import { TreeSurface, treeExternal } from './TreeSurface'
import { PanePicker } from './PanePicker'
import { PointButton } from './PointButton'
import { HtmlSurface } from './HtmlSurface'
import { PresentationButton } from './PresentationButton'
import { fileLike, presentationOf, useNoPreview } from '../../lib/presentation'

/** The Surfaces pane: one header whose tab strip outlives a switch between kinds, over the active
 *  surface's body, or the picker when there are no tabs. Only the active surface is mounted, so the
 *  browser's native view shows only while a browser tab is active in an open pane. */
export function SurfaceHost(): JSX.Element | null {
  const handleId = useSession((s) => s.activeHandleId)
  const kind = useActive((s) => (s ? surfaceKindOf(s.surfaces, s.surfaces.active) : null))
  const browserExternal = useBrowserExternal()
  const diffExternal = useDiffExternal(handleId)
  const activeId = useActive((s) => s?.surfaces.active ?? null)
  const fileTab = fileLike(kind)
  const filePath = useActive((s) => (fileTab && activeId ? (s?.surfaces.tabs[activeId]?.key ?? null) : null))
  const mode = useActive((s) => (fileTab && activeId ? s?.surfaces.tabs[activeId]?.mode : undefined))
  const noPreview = useNoPreview(handleId, filePath)
  const shown = presentationOf(fileTab && filePath !== null ? { kind, key: filePath, mode } : undefined, !!noPreview)
  const fileExternal = useFileExternal(handleId, filePath, shown === 'preview')
  const cwd = useActive((s) => s?.cwd ?? null)
  if (!handleId) return null
  const browser = kind === 'browser'
  const external =
    browser ? browserExternal : kind === 'diff' ? diffExternal : fileTab ? fileExternal : kind === 'tree' ? treeExternal(handleId, cwd) : undefined
  const pointer = (browser || kind === 'diff') && activeId && <PointButton kind={kind} id={activeId} />
  const actions = browser ? (
    <>
      {pointer}
      <BrowserSettingsButton />
    </>
  ) : shown && activeId ? (
    <PresentationButton handleId={handleId} tabId={activeId} shown={shown} noPreview={noPreview} />
  ) : (
    pointer
  )
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <PaneHeader external={external} actions={actions}>
        <SurfaceTabs key={handleId} />
      </PaneHeader>
      {browser && <BrowserSurface handleId={handleId} />}
      {kind === 'diff' && <DiffSurface key={handleId} handleId={handleId} />}
      {kind === 'tree' && cwd && <TreeSurface key={handleId} handleId={handleId} cwd={cwd} />}
      {fileTab &&
        activeId &&
        (shown === 'preview' ? (
          <HtmlSurface key={`${handleId}\0${activeId}`} handleId={handleId} tabId={activeId} explicit={mode === 'preview'} />
        ) : (
          <FileSurface key={`${handleId}\0${activeId}`} handleId={handleId} tabId={activeId} />
        ))}
      {!kind && <PanePicker key={handleId} />}
    </div>
  )
}
