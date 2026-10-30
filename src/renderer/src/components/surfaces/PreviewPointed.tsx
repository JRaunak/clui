import { useActive } from '../../store'
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
      <PointedRow label={`Claude pointed to ${rangeText(lines, ' to ')}.`}>
        <button type="button" className={TEXT_BTN} onClick={(e) => viewSourceAt(handleId, tabId, lines.start, viaOf(e), lines.end > lines.start ? lines.end : undefined)}>
          Show in Source
        </button>
      </PointedRow>
    </div>
  )
}
