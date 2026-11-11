import { runTagged, type Via } from './motion'
import { getStage } from './stage'
import { activeSlice, useSession } from '../store'
import type { BrowserPaneState } from '../../../shared/browser'

function openButtonFor(toolId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-ui="row-open-transcript"][data-tool-id="${CSS.escape(toolId)}"]`
  )
}

const pane = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-ui="pane-secondary"]')
// In full the primary pane is unmounted, so its presence is the half/full test.
const primaryShown = (): boolean => !!document.querySelector('[data-ui="pane-primary"]')

/** The Surfaces pane has no title; its active tab stands in for one. */
export function focusPaneTitle(): void {
  document
    .querySelector<HTMLElement>('[data-ui="pane-title"], [data-ui="surface-tabs"] [aria-selected="true"]')
    ?.focus({ preventScroll: true })
}

/** Open a subagent's transcript tab from its Agent row. Into a closed pane by pointer, the row morphs into the pane;
 *  otherwise the tab opens as any tab does. Focus lands on the tab. */
export function diveInto(toolId: string, via: Via): void {
  const st = useSession.getState()
  const handleId = st.activeHandleId
  if (!handleId) return
  const open = (): void => useSession.getState().openAgentTab(handleId, { by: 'tool', id: toolId })
  if (activeSlice(st)?.paneOpen || via !== 'pointer') {
    open()
    return void requestAnimationFrame(focusPaneTitle)
  }
  const stage = getStage()
  const row = openButtonFor(toolId)?.closest<HTMLElement>('[data-ui="instrument-row"]') ?? null
  row?.style.setProperty('view-transition-name', 'dive')
  const t = runTagged('dive', {
    via,
    scope: stage,
    update: open,
    after: () => {
      // Whether the pane opened half or full is only known once the Stage has laid it out. The
      // pseudo tree is built after this callback, so retagging here still picks the right CSS.
      if (stage?.dataset.vt === 'dive' && primaryShown()) stage.dataset.vt = 'dive-split'
      // In half the row is still on screen; it must give the name up before the new state is
      // captured, or the transition aborts on a duplicate name.
      row?.style.removeProperty('view-transition-name')
      pane()?.style.setProperty('view-transition-name', 'dive')
      focusPaneTitle()
    }
  })
  const clear = (): void => {
    row?.style.removeProperty('view-transition-name')
    pane()?.style.removeProperty('view-transition-name')
  }
  if (t) t.finished.finally(clear)
  else clear()
}

/** The pane header's Full/Half button: the pane morphs its rect. Going full unmounts the
 *  transcript, so focus inside it moves to the pane title. */
export function resizePane(full: boolean, via: Via): void {
  const p = pane()
  // The header's controls sit at the pane's fixed right edge and its title reads from the moving left
  // edge, so each needs its own snapshot anchored to its own side.
  const head = p?.querySelector<HTMLElement>('[data-ui="pane-head-controls"]') ?? null
  const title = p?.querySelector<HTMLElement>('[data-ui="pane-head-title"]') ?? null
  const fromTranscript = !!document.activeElement?.closest('[data-ui="pane-primary"]')
  p?.style.setProperty('view-transition-name', 'pane')
  head?.style.setProperty('view-transition-name', 'pane-head')
  title?.style.setProperty('view-transition-name', 'pane-head-title')
  const t = runTagged(full ? 'pane-full' : 'pane-half', {
    via,
    scope: getStage(),
    update: () => useSession.getState().setPane(full ? 'full' : 'half'),
    after: () => {
      if (full && fromTranscript) focusPaneTitle()
    }
  })
  const clear = (): void => {
    p?.style.removeProperty('view-transition-name')
    head?.style.removeProperty('view-transition-name')
    title?.style.removeProperty('view-transition-name')
  }
  if (t) t.finished.finally(clear)
  else clear()
}

/** Open, hide or resize the Surfaces pane. Opening slides it in from the right edge (and the
 *  transcript recedes when it opens to full); hiding slides it out and returns focus to the
 *  top-band toggle. Half and full go through resizePane. */
export function setPaneVia(next: BrowserPaneState, via: Via): void {
  const st = useSession.getState()
  const cur = activeSlice(st)
  if (!cur) return
  const from: BrowserPaneState = !cur.paneOpen ? 'collapsed' : cur.surfacePaneFull ? 'full' : 'half'
  if (from === next) return
  if (from !== 'collapsed' && next !== 'collapsed') return resizePane(next === 'full', via)
  const stage = getStage()
  const update = (): void => useSession.getState().setPane(next)
  if (next === 'collapsed') {
    const p = pane()
    p?.style.setProperty('view-transition-name', 'pane')
    const t = runTagged('pane-hide', {
      via,
      scope: stage,
      update,
      after: () => document.querySelector<HTMLElement>('[data-ui="pane-toggle"]')?.focus()
    })
    const clear = (): void => {
      p?.style.removeProperty('view-transition-name')
    }
    if (t) t.finished.finally(clear)
    else clear()
    return
  }
  const t = runTagged('pane-open', {
    via,
    scope: stage,
    update,
    after: () => {
      // Half or full is only known once the Stage has laid the pane out; the pseudo tree is built
      // after this callback, so the retag still picks the right CSS.
      if (stage?.dataset.vt === 'pane-open' && !primaryShown()) stage.dataset.vt = 'pane-open-full'
      pane()?.style.setProperty('view-transition-name', 'pane')
    }
  })
  const clear = (): void => {
    pane()?.style.removeProperty('view-transition-name')
  }
  if (t) t.finished.finally(clear)
  else clear()
}
