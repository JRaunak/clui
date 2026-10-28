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
import { MarkdownSurface } from './MarkdownSurface'
import { MermaidSurface } from './MermaidSurface'
import { ImageSurface } from './ImageSurface'
import { PresentationButton } from './PresentationButton'
import { fileLike, isMarkdown, isMermaid, opensDefault, presentationOf, useNoPreview } from '../../lib/presentation'
import { isHtml } from '../../../../shared/html-view'

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
  const fileExternal = useFileExternal(handleId, filePath, opensDefault(kind, shown))
  const cwd = useActive((s) => s?.cwd ?? null)
  if (!handleId) return null
  const browser = kind === 'browser'
  const external =
    browser ? browserExternal : kind === 'diff' ? diffExternal : fileTab ? fileExternal : kind === 'tree' ? treeExternal(handleId, cwd) : undefined
  const pointer = (browser || kind === 'diff') && activeId && <PointButton kind={kind} id={activeId} />
  const image = kind === 'image'
  const actions = browser ? (
    <>
      {pointer}
      <BrowserSettingsButton />
    </>
  ) : image && activeId ? (
    <>
      {shown !== 'source' && <PointButton kind="image" id={activeId} />}
      {shown && <PresentationButton handleId={handleId} tabId={activeId} shown={shown} noPreview={noPreview} />}
    </>
  ) : shown && activeId ? (
    <>
      <PresentationButton handleId={handleId} tabId={activeId} shown={shown} noPreview={noPreview} />
      {/* After the presentation button, so swapping to Source, which has no Point, never moves it under the pointer. */}
      {shown === 'preview' && filePath && isHtml(filePath) && <PointButton kind="html" id={activeId} />}
    </>
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
        (image && shown !== 'source' ? (
          <ImageSurface key={`${handleId}\0${activeId}`} handleId={handleId} tabId={activeId} />
        ) : shown === 'preview' ? (
          filePath && isMarkdown(filePath) ? (
            <MarkdownSurface key={`${handleId}\0${activeId}`} handleId={handleId} tabId={activeId} />
          ) : filePath && isMermaid(filePath) ? (
            <MermaidSurface key={`${handleId}\0${activeId}`} handleId={handleId} tabId={activeId} />
          ) : (
            <HtmlSurface key={`${handleId}\0${activeId}`} handleId={handleId} tabId={activeId} explicit={mode === 'preview'} />
          )
        ) : (
          <FileSurface key={`${handleId}\0${activeId}`} handleId={handleId} tabId={activeId} />
        ))}
      {!kind && <PanePicker key={handleId} />}
    </div>
  )
}
