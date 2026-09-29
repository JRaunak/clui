import { runTagged, type Via } from './motion'
import { getStage } from './stage'
import { activeSlice, useSession } from '../store'
import type { BrowserPaneState } from '../../../shared/browser'

function openButtonFor(toolId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `[data-ui="row-open-transcript"][data-tool-id="${CSS.escape(toolId)}"]`
  )
}

function inView(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  return r.bottom > 0 && r.top < window.innerHeight
}

const pane = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-ui="pane-secondary"]')
// In full the primary pane is unmounted, so its presence is the half/full test.
const primaryShown = (): boolean => !!document.querySelector('[data-ui="pane-primary"]')

/** The browser pane has no title; its viewed tab stands in for one. */
export function focusPaneTitle(): void {
  document
    .querySelector<HTMLElement>('[data-ui="pane-title"], [data-ui="browser-tabs"] [aria-selected="true"]')
    ?.focus({ preventScroll: true })
}

/** Back on the transcript, return focus to the row that opened the pane. If the row isn't rendered,
 *  bring its message to the top of the viewport and retry once, then fall back to the composer. */
function focusOpener(toolId: string): void {
  const btn = openButtonFor(toolId)
  if (btn) return btn.focus({ preventScroll: true })
  const st = useSession.getState()
  const slice = st.activeHandleId ? st.sessions[st.activeHandleId] : null
  const msg = slice?.messages.find((m) => m.tools.some((t) => t.id === toolId))
  if (!msg) return void document.querySelector<HTMLElement>('[data-composer-input]')?.focus()
  st.requestScrollTo(msg.id, { align: 'start' })
  setTimeout(() => {
    ;(openButtonFor(toolId) ?? document.querySelector<HTMLElement>('[data-composer-input]'))?.focus()
  }, 300)
}

/** Open a subagent's transcript from its Agent row: the row becomes the pane. */
export function diveInto(toolId: string, via: Via): void {
  const stage = getStage()
  const row = openButtonFor(toolId)?.closest<HTMLElement>('[data-ui="instrument-row"]') ?? null
  row?.style.setProperty('view-transition-name', 'dive')
  const t = runTagged('dive', {
    via,
    scope: stage,
    update: () => useSession.getState().viewSubagent(toolId),
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

/** Close the subagent pane, the pane morphing back into its row. */
export function diveOut(via: Via): void {
  const st = useSession.getState()
  const toolId = st.subagentTrail[0] ?? st.viewingSubagent
  const stage = getStage()
  const p = pane()
  p?.style.setProperty('view-transition-name', 'dive')
  let row: HTMLElement | null = null
  const t = runTagged(primaryShown() ? 'undive-split' : 'undive', {
    via,
    scope: stage,
    update: () => useSession.getState().closeSubagentView(),
    after: () => {
      p?.style.removeProperty('view-transition-name')
      const btn = toolId ? openButtonFor(toolId) : null
      row = btn?.closest<HTMLElement>('[data-ui="instrument-row"]') ?? null
      // A row that isn't on screen has nothing to morph into; the pane just fades.
      if (row && inView(row)) row.style.setProperty('view-transition-name', 'dive')
      else row = null
      if (toolId) focusOpener(toolId)
    }
  })
  const clear = (): void => {
    p?.style.removeProperty('view-transition-name')
    row?.style.removeProperty('view-transition-name')
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
    update: () => {
      // The subagent pane outranks the browser in the Stage, so whichever is showing is resized.
      const st = useSession.getState()
      if (st.viewingSubagent) st.setPaneFull(full)
      else st.setBrowserPane(full ? 'full' : 'half')
    },
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

/** Open, hide or resize the browser pane. Opening slides it in from the right edge (and the
 *  transcript recedes when it opens to full); hiding slides it out and returns focus to the
 *  top-band toggle. Half and full go through resizePane. */
export function setBrowserPaneVia(next: BrowserPaneState, via: Via): void {
  const st = useSession.getState()
  const cur = activeSlice(st)
  if (!cur) return
  const from: BrowserPaneState = st.viewingSubagent || !cur.browserOpen ? 'collapsed' : st.browserPaneFull ? 'full' : 'half'
  if (from === next) return
  if (from !== 'collapsed' && next !== 'collapsed') return resizePane(next === 'full', via)
  const stage = getStage()
  const update = (): void => useSession.getState().setBrowserPane(next)
  if (next === 'collapsed') {
    const p = pane()
    p?.style.setProperty('view-transition-name', 'pane')
    const t = runTagged('pane-hide', {
      via,
      scope: stage,
      update,
      after: () => document.querySelector<HTMLElement>('[data-ui="browser-toggle"]')?.focus()
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
