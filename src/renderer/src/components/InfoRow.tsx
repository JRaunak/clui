import type { ReactNode } from 'react'

/** The pinned row at the top of a transcript tab: its identity on the first line, its state on the second. It starts
 *  under the pane header, and draws the band's edge only once the transcript below has scrolled. */
export function InfoRow({ ui, lead, line1, line2, scrolled }: { ui: string; lead: ReactNode; line1: ReactNode; line2: ReactNode; scrolled: boolean }): JSX.Element {
  return (
    <div data-ui={ui} data-scrolled={scrolled || undefined} className="shrink-0 bg-bg px-4 pb-2 pt-(--top-h) data-[scrolled]:shadow-[inset_0_-1px_0_var(--band-edge)]">
      <div className="flex min-h-8 items-center gap-2">
        <span aria-hidden="true" className="flex h-4 w-4 shrink-0 items-center justify-center text-content">
          {lead}
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-0.5">{line1}</div>
      </div>
      <div className="flex min-h-5 flex-wrap items-center gap-x-1.5 gap-y-1 pl-6 text-meta text-dim has-[button[data-ui=agent-stop]]:gap-y-2">{line2}</div>
    </div>
  )
}
