import { useActive, useSession } from '../../store'
import { viaOf } from '../../lib/motion'
import { PointedRow } from '../Markdown'
import { rangeText, TEXT_BTN, viewSourceAt } from './fileDoc'

/** Claude's lines on an HTML or SVG Preview, which can't mark them: the row says so and goes to them in Source. The
 *  tab stays in Preview, since swapping a running page out from under the user is worse than a row. */
export function PreviewPointed({ handleId, tabId }: { handleId: string; tabId: string }): JSX.Element | null {
  const lines = useActive((s) => s?.surfaces.tabs[tabId]?.highlight?.lines)
  if (!lines) return null
  return (
    <div data-ui="preview-pointed" className="shrink-0 border-b border-border px-3 py-1">
      <PointedRow label={`Claude pointed to ${rangeText(lines)}.`}>
        <button type="button" className={TEXT_BTN} onClick={(e) => viewSourceAt(handleId, tabId, lines.start, viaOf(e), lines.end > lines.start ? lines.end : undefined)}>
          Show in Source
        </button>
      </PointedRow>
    </div>
  )
}

/** Claude's diagram parts on a tab the user put in Source, which can't mark them without drawing. */
export function SourcePointedParts({ handleId, tabId }: { handleId: string; tabId: string }): JSX.Element | null {
  const shown = useActive((s) => {
    const t = s?.surfaces.tabs[tabId]
    return !!t?.highlight?.parts && t.mode === 'source'
  })
  const setView = useSession((s) => s.setSurfaceView)
  if (!shown) return null
  return (
    <div data-ui="source-pointed" className="shrink-0 border-b border-border px-3 py-1">
      <PointedRow label="Claude pointed to parts of the diagram.">
        <button type="button" className={TEXT_BTN} onClick={() => setView(handleId, tabId, { mode: 'preview' })}>
          Show in Preview
        </button>
      </PointedRow>
    </div>
  )
}
