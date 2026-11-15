/** The ways into a side chat: `/side` and `/btw`, ⌘/, the pane picker and `+` menu, the palette. */
import { canFork, resumeStopped, sideFor, sideShown, useSession, type SideRefusal } from '../store'
import { REFUSAL_NOTICE, SIDE_TITLE, unhanded } from './side'
import { requestSurfaceFocus, takeSurfaceFocus } from './surfaceFocus'

export const SIDE_COMPOSER = '[data-ui="side-composer"]'

/** Opens a fresh side and puts focus in its composer once the tab mounts. False, with the reason shown, if it can't. */
async function open(parent: string, question?: string, resumed = false): Promise<boolean> {
  requestSurfaceFocus('side')
  const st = useSession.getState()
  const r = await st.openSide(parent, question)
  if (r.ok) return true
  takeSurfaceFocus('side')
  // A session that stops again right after its resume isn't offered another one.
  refuse(parent, resumed && r.reason === 'stopped' ? 'not-live' : r.reason, question)
  return false
}

/** Shows why a side chat can't open. A stopped session offers to resume and open it, carrying the question. */
export function refuse(parent: string | null, reason: SideRefusal, question?: string, keyed = false): void {
  const st = useSession.getState()
  if (reason !== 'stopped' || !parent) return st.setNotice(REFUSAL_NOTICE[reason], reason === 'not-live' ? 'warn' : 'info')
  st.setNotice(REFUSAL_NOTICE.stopped, 'warn', { label: 'Resume and open side chat', run: () => void resumeThenOpen(parent, question), focus: keyed })
}

/** Resume seeds the new slice's id and main knows it from the launch, so the side can fork before the first turn. */
async function resumeThenOpen(parent: string, question?: string): Promise<void> {
  const h = await resumeStopped(parent)
  if (!h) return
  if (question === undefined) await open(h, undefined, true)
  else await replaceSide(h, question, true)
}

/** ⌘/, the picker and the palette: brings the open side chat to the front, else opens one. Never replaces it. */
export async function showSide(parent: string, keyed = false): Promise<void> {
  const st = useSession.getState()
  if (!sideFor(st, parent)) {
    const refused = canFork(st.sessions[parent] ?? null)
    if (refused) return refuse(parent, refused, undefined, keyed)
    return void (await open(parent))
  }
  const box = document.querySelector<HTMLElement>(SIDE_COMPOSER)
  if (sideShown(st, parent) && box) return box.focus()
  requestSurfaceFocus('side')
  st.openSurface(parent, { kind: 'side', key: '', title: SIDE_TITLE }, 'focus', 'user', 'user')
}

/** `/side` from the main composer. The draft's text clears once the new side opens, and only if it's still what
 *  was submitted; attachments and chips stay. A thread with unhanded answers asks before it's replaced. */
export async function askSide(parent: string, question: string, keyed = false): Promise<void> {
  const st = useSession.getState()
  const refused = canFork(st.sessions[parent] ?? null)
  if (refused) return refuse(parent, refused, question, keyed)
  const x = sideFor(st, parent)
  if (x && unhanded(x)) return useSession.setState({ sideConfirm: { parent, reason: 'replace', question } })
  await replaceSide(parent, question)
}

/** Ends any open side and opens one with the question, clearing the `/side` draft that asked for it. */
export async function replaceSide(parent: string, question: string, resumed = false): Promise<boolean> {
  const typed = useSession.getState().sessions[parent]?.draftText
  if (!(await open(parent, question, resumed))) return false
  const st = useSession.getState()
  if (st.sessions[parent]?.draftText === typed) st.setDraftText(parent, '')
  return true
}
