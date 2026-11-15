/** Asks before a side chat with answers Claude hasn't seen is closed or replaced by a new `/side`. */
import { useId, useRef } from 'react'
import { sideFor, useSession, type SideConfirm as Ask } from '../store'
import { replaceSide } from '../lib/sideEntry'
import { useDialogFocus } from '../lib/useDialogFocus'
import { useEscape } from '../lib/useEscape'
import { useOverlayCovered, useOverlayEnter } from '../lib/overlayOrigin'
import { tabButton } from './surfaces/SurfaceTabs'
import { Button } from './Button'

const IN_PROGRESS = " The answer in progress stops and isn't included."

// Next frame, so it wins over App putting focus back where it was before the dialog.
const later = (el: () => HTMLElement | null): void =>
  void requestAnimationFrame(() => {
    const t = el()
    t?.focus()
    if (t instanceof HTMLTextAreaElement) t.setSelectionRange(t.value.length, t.value.length)
  })
const mainComposer = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-composer-input]')
/** After a hand-back, the caret goes to the end of the draft the chip just joined. */
export const toMainDraft = (): void => later(mainComposer)

export function SideConfirm({ covered }: { covered: boolean }): JSX.Element | null {
  const ask = useSession((s) => s.sideConfirm)
  return ask ? <Dialog ask={ask} covered={covered} /> : null
}

function Dialog({ ask, covered }: { ask: Ask; covered: boolean }): JSX.Element {
  const { parent } = ask
  const replacing = ask.reason === 'replace'
  const answering = useSession((s) => !!sideFor(s, parent)?.busy)
  const scrimRef = useRef<HTMLDivElement>(null)
  const panelRef = useDialogFocus<HTMLDivElement>()
  useOverlayEnter(scrimRef, panelRef)
  useOverlayCovered(scrimRef, covered)
  const titleId = useId()
  const bodyId = useId()
  const close = (): void => useSession.setState({ sideConfirm: null })
  useEscape(true, close)

  const discard = (): void => {
    close()
    if (ask.reason === 'replace') return void replaceSide(parent, ask.question)
    const st = useSession.getState()
    const order = st.sessions[parent]?.surfaces.order ?? []
    const i = order.indexOf('side')
    const next = order[i + 1] ?? order[i - 1]
    void st.endSide(parent)
    later(() => (next ? tabButton(next) : null) ?? mainComposer())
  }
  const hand = (): void => {
    close()
    if (!useSession.getState().handBackSide(parent)) return
    if (ask.reason === 'close') return toMainDraft()
    void replaceSide(parent, ask.question).then((ok) => ok && useSession.getState().announceRefs(parent, 'Side chat added to your message. New side chat started.'))
  }

  return (
    <div ref={scrimRef} className="fixed inset-0 z-40 flex items-center justify-center scrim">
      <div
        ref={panelRef}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-ui="side-confirm"
        className="w-[min(400px,calc(100vw-3rem))] rounded-lg border border-border bg-bg-elev p-4 shadow-[var(--shadow-float)] outline-none"
      >
        <h2 id={titleId} className="text-title text-content">
          {replacing ? 'Replace the open side chat?' : 'Hand back this side chat?'}
        </h2>
        <p id={bodyId} className="mt-1.5 text-ui text-dim">
          {replacing
            ? "It has answers Claude hasn't seen. Replacing discards them. The new side chat starts from the conversation as it is now."
            : "It has answers Claude hasn't seen. Closing ends the thread."}
          {answering && IN_PROGRESS}
        </p>
        <div className="mt-4 flex items-center gap-2">
          <Button data-ui="side-confirm-discard" variant="control" className="hover:border-err" onClick={discard}>
            {replacing ? 'Replace' : 'Discard'}
          </Button>
          <Button data-ui="side-confirm-cancel" variant="ghost" className="ml-auto" onClick={close}>
            Cancel
          </Button>
          <Button data-ui="side-confirm-hand-back" variant="primary" onClick={hand}>
            {replacing ? 'Hand back first' : 'Hand back'}
          </Button>
        </div>
      </div>
    </div>
  )
}
