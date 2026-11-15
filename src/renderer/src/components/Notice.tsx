import { useEffect, useRef } from 'react'
import { useSession, useActive, apiRetryCopy, rateLimitCopy, type NoticeAction, type NoticeTone } from '../store'
import { IconCheck, IconWarn, IconNoEntry, IconClose, IconInfo, IconRefresh } from './Icon'

type Glyph = (p: { className?: string }) => JSX.Element

/** Per-tone notice styling. Message text stays text-content in the render, not the tone color:
 *  content on any 10% tint clears 4.5:1, a colored body would not. */
const NOTICE_STYLES: Record<
  NoticeTone,
  { cls: string; Icon: Glyph; tint: string }
> = {
  success: { cls: 'border-ok/40 bg-ok/10', Icon: IconCheck, tint: 'text-ok' },
  warn: { cls: 'border-warn/40 bg-warn/10', Icon: IconWarn, tint: 'text-warn' },
  error: { cls: 'border-err/40 bg-err/10', Icon: IconNoEntry, tint: 'text-err' },
  info: { cls: 'border-info/40 bg-info/10', Icon: IconInfo, tint: 'text-info' }
}

const focusComposer = (): void => document.querySelector<HTMLElement>('[data-composer-input]')?.focus()

/** The app-level notice strip, or else the viewed session's usage limit or API retry. A global
 *  notice always wins, so a retry never hides an error, and a blocked account outranks a retry that
 *  can't succeed. Its tint is translucent, so it sits on an opaque bg-bg base and the transcript
 *  never shows through it. */
export function Notice(): JSX.Element {
  const notice = useSession((s) => s.notice)
  const dismissNotice = useSession((s) => s.dismissNotice)
  const dismissApiRetry = useSession((s) => s.dismissApiRetry)
  const retry = useActive((s) => (s && !s.apiRetryDismissed ? s.apiRetry : null))
  const retryAnnounce = useActive((s) => s?.apiRetryAnnounce ?? '')
  const dismissRateLimit = useSession((s) => s.dismissRateLimit)
  const limit = useActive((s) => (s && !s.rateLimitDismissed ? s.rateLimit : null))
  const limitAnnounce = useActive((s) => s?.rateLimitAnnounce ?? '')
  const blocked = limit?.status === 'rejected' && !limit.extraUsage
  const limitShown = limit && (blocked || !retry) ? { message: rateLimitCopy(limit), tone: blocked ? ('error' as const) : ('warn' as const) } : null
  // The retry glyph is static on purpose: WorkingStatus already carries the busy cue, and a retry run can last minutes.
  const shown: { message: string; tone: NoticeTone; icon?: Glyph } | null =
    notice ?? limitShown ?? (retry ? { message: apiRetryCopy(retry), tone: 'info', icon: IconRefresh } : null)
  const { cls, tint, Icon: toneIcon } = NOTICE_STYLES[shown?.tone ?? 'info']
  const Icon = shown?.icon ?? toneIcon
  const action: NoticeAction | undefined = notice?.action
  const actionRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (action?.focus) actionRef.current?.focus()
  }, [action])
  return (
    <>
      {/* Always mounted: a live region that mounts with its first message often goes unannounced. */}
      <span className="sr-only" role="status">
        {notice ? (action ? `${notice.message} ${action.label}` : notice.message) : limitShown ? limitAnnounce : retry ? retryAnnounce : ''}
      </span>
      {shown && (
        <div data-ui="notice" className="bg-bg">
          <div className={`flex items-center gap-2 border-b py-1 pl-4 pr-2 text-label text-content ${cls}`}>
            <Icon className={`h-3.5 w-3.5 shrink-0 ${tint}`} />
            <span className="flex-1 tabular-nums">{shown.message}</span>
            {action && (
              <button
                ref={actionRef}
                className="h-7 shrink-0 rounded-md border border-border px-2 text-label font-medium text-content pointer-fine:hover:bg-bg-raised"
                onClick={() => {
                  dismissNotice()
                  focusComposer()
                  action.run()
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') return
                  e.preventDefault()
                  dismissNotice()
                  focusComposer()
                }}
              >
                {action.label}
              </button>
            )}
            <button
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-dim transition-colors hover:bg-bg-raised hover:text-content"
              onClick={notice ? dismissNotice : limitShown ? dismissRateLimit : dismissApiRetry}
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
