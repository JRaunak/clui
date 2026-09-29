import { useSession, useActive, apiRetryCopy, type NoticeTone } from '../store'
import { IconCheck, IconWarn, IconNoEntry, IconClose, IconRefresh } from './Icon'

/** Per-tone notice styling. Message text stays text-content in the render, not the tone color:
 *  content on any 10% tint clears 4.5:1, a colored body would not. */
const NOTICE_STYLES: Record<
  NoticeTone,
  { cls: string; Icon: (p: { className?: string }) => JSX.Element; tint: string }
> = {
  success: { cls: 'border-ok/40 bg-ok/10', Icon: IconCheck, tint: 'text-ok' },
  warn: { cls: 'border-warn/40 bg-warn/10', Icon: IconWarn, tint: 'text-warn' },
  error: { cls: 'border-err/40 bg-err/10', Icon: IconNoEntry, tint: 'text-err' },
  // Static on purpose: WorkingStatus already carries the busy cue, and a retry run can last minutes.
  info: { cls: 'border-info/40 bg-info/10', Icon: IconRefresh, tint: 'text-info' }
}

/** The app-level notice strip, or else the viewed session's API retry. A global notice always
 *  wins, so a retry never hides an error. Its tint is translucent, so it sits on an opaque bg-bg
 *  base and the transcript never shows through it. */
export function Notice(): JSX.Element {
  const notice = useSession((s) => s.notice)
  const dismissNotice = useSession((s) => s.dismissNotice)
  const dismissApiRetry = useSession((s) => s.dismissApiRetry)
  const retry = useActive((s) => (s && !s.apiRetryDismissed ? s.apiRetry : null))
  const retryAnnounce = useActive((s) => s?.apiRetryAnnounce ?? '')
  const shown = notice ?? (retry ? { message: apiRetryCopy(retry), tone: 'info' as const } : null)
  const { cls, Icon, tint } = NOTICE_STYLES[shown?.tone ?? 'info']
  return (
    <>
      {/* Always mounted: a live region that mounts with its first message often goes unannounced. */}
      <span className="sr-only" role="status">
        {notice ? notice.message : retry ? retryAnnounce : ''}
      </span>
      {shown && (
        <div data-ui="notice" className="bg-bg">
          <div className={`flex items-center gap-2 border-b py-1 pl-4 pr-2 text-label text-content ${cls}`}>
            <Icon className={`h-3.5 w-3.5 shrink-0 ${tint}`} />
            <span className="flex-1 tabular-nums">{shown.message}</span>
            <button
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-dim transition-colors hover:bg-bg-raised hover:text-content"
              onClick={notice ? dismissNotice : dismissApiRetry}
              aria-label="Dismiss"
              title="Dismiss"
            >
              <IconClose className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </>
  )
}
