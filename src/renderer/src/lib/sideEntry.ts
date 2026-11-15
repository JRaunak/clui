/** The ways into a side chat: `/side` and `/btw`, ⌘/, the pane picker and `+` menu, the palette. */
import { canFork, sideFor, sideShown, useSession } from '../store'
import { REFUSAL_NOTICE, SIDE_TITLE, unhanded } from './side'
import { requestSurfaceFocus, takeSurfaceFocus } from './surfaceFocus'

export const SIDE_COMPOSER = '[data-ui="side-composer"]'

/** Opens a fresh side and puts focus in its composer once the tab mounts. False, with the reason shown, if it can't. */
async function open(parent: string, question?: string): Promise<boolean> {
  requestSurfaceFocus('side')
  const st = useSession.getState()
  const r = await st.openSide(parent, question)
  if (r.ok) return true
  takeSurfaceFocus('side')
  st.setNotice(REFUSAL_NOTICE[r.reason], 'info')
  return false
}

/** ⌘/, the picker and the palette: brings the open side chat to the front, else opens one. Never replaces it. */
export async function showSide(parent: string): Promise<void> {
  const st = useSession.getState()
  if (!sideFor(st, parent)) {
    const refused = canFork(st.sessions[parent] ?? null)
    if (refused) return st.setNotice(REFUSAL_NOTICE[refused], 'info')
    return void (await open(parent))
  }
  const box = document.querySelector<HTMLElement>(SIDE_COMPOSER)
  if (sideShown(st, parent) && box) return box.focus()
  requestSurfaceFocus('side')
  st.openSurface(parent, { kind: 'side', key: '', title: SIDE_TITLE }, 'focus', 'user', 'user')
}

/** `/side` from the main composer. The draft's text clears once the new side opens, and only if it's still what
 *  was submitted; attachments and chips stay. A thread with unhanded answers asks before it's replaced. */
export async function askSide(parent: string, question: string): Promise<void> {
  const st = useSession.getState()
  const refused = canFork(st.sessions[parent] ?? null)
  if (refused) return st.setNotice(REFUSAL_NOTICE[refused], 'info')
  const x = sideFor(st, parent)
  if (x && unhanded(x)) return useSession.setState({ sideConfirm: { parent, reason: 'replace', question } })
  await replaceSide(parent, question)
}

/** Ends any open side and opens one with the question, clearing the `/side` draft that asked for it. */
export async function replaceSide(parent: string, question: string): Promise<boolean> {
  const typed = useSession.getState().sessions[parent]?.draftText
  if (!(await open(parent, question))) return false
  const st = useSession.getState()
  if (st.sessions[parent]?.draftText === typed) st.setDraftText(parent, '')
  return true
}
