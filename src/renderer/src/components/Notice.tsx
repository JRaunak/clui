import { useSession, type NoticeTone } from '../store'
import { IconCheck, IconWarn, IconNoEntry, IconClose } from './Icon'

/** Per-tone notice styling. Message text stays text-content in the render, not the tone color:
 *  content on any 10% tint clears 4.5:1, a colored body would not. */
const NOTICE_STYLES: Record<
  NoticeTone,
  { cls: string; Icon: (p: { className?: string }) => JSX.Element; tint: string }
> = {
  success: { cls: 'border-ok/40 bg-ok/10', Icon: IconCheck, tint: 'text-ok' },
  warn: { cls: 'border-warn/40 bg-warn/10', Icon: IconWarn, tint: 'text-warn' },
  error: { cls: 'border-err/40 bg-err/10', Icon: IconNoEntry, tint: 'text-err' }
}

/** The app-level notice strip. Its tint is translucent, so it sits on an opaque bg-bg base and the
 *  transcript never shows through it. */
export function Notice(): JSX.Element | null {
  const notice = useSession((s) => s.notice)
  const dismissNotice = useSession((s) => s.dismissNotice)
  if (!notice) return null
  const { cls, Icon, tint } = NOTICE_STYLES[notice.tone]
  return (
    <div data-ui="notice" className="bg-bg">
      <div className={`flex items-center gap-2 border-b py-1 pl-4 pr-2 text-label text-content ${cls}`}>
        <Icon className={`h-3.5 w-3.5 shrink-0 ${tint}`} />
        <span className="flex-1">{notice.message}</span>
        <button
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-dim transition-colors hover:bg-bg-raised hover:text-content"
          onClick={dismissNotice}
          aria-label="Dismiss"
          title="Dismiss"
        >
          <IconClose className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
