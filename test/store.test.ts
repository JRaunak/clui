import { CHANGE_REFS, useSession, wakeCandidates, countWake, apiRetryCopy, effectiveMode, rateLimitCopy, chipMode, notePaneInput, paneTarget, restoredPane, evictionVictim, expireEvicted, PANE_RECENT_MS } from '../src/renderer/src/store.ts'
import { turnEndLine, wokenLine } from '../src/renderer/src/lib/turnEnd.ts'
import { monitorMeta } from '../src/renderer/src/lib/instrument.ts'
import { equal, ok } from './support/harness.mjs'

// The store's IPC is stubbed: each call is recorded and resolves true unless `replies` overrides it.
const calls: { name: string; args: unknown[] }[] = []
const replies: Record<string, (...args: any[]) => unknown> = { setModel: () => ({ ok: true }) }
;(globalThis as any).window = {
  clui: new Proxy({}, { get: (_t, name: string) => async (...args: unknown[]) => (calls.push({ name, args }), replies[name] ? replies[name](...args) : true) })
}
const slice = (over: Record<string, unknown> = {}): any => ({
  handleId: 'h1',
  cwd: '/tmp/w',
  sessionId: null,
  model: 'claude-opus-5-5[1m]',
  modelChoice: 'claude-opus-5-5[1m]',
  effortChoice: 'high',
  ultracode: true,
  contextTokens: null,
  contextPercent: null,
  contextWindow: null,
  costUsd: null,
  prevCumUsage: { costUSD: 0, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, thinkingTokens: 0, models: [] },
  busy: true,
  interrupting: false,
  thinkingTokens: null,
  messages: [],
  queuedMessages: [],
  lastError: null,
  exited: false,
  lastActivityMs: 0,
  backgroundTasks: {},
  subagentMessages: {},
  subagentChildren: {},
  checkingTools: {},
  pendingPermissions: [],
  rateLimit: null,
  rateLimitDismissed: false,
  rateLimitAnnounce: '',
  turnTasks: [],
  endedTasks: [],
  monitors: {},
  turnStartMs: null,
  annotate: { tab: null, note: null },
  contextRefs: [],
  referenceNotices: {},
  changeRead: null,
  referenceEditTarget: null,
  refAnnounce: '',
  surfaces: { order: [], active: null, tabs: {}, browserLastViewedAt: {}, browserUnseen: {} },
  ...over
})
const reset = (over?: Record<string, unknown>, caps = {}): void => {
  calls.length = 0
  useSession.setState({ sessions: { h1: slice(over) }, activeHandleId: 'h1', notice: null, effortCaps: caps })
}
const cur = (): any => useSession.getState().sessions.h1
const st = useSession.getState

// Ultra is only gated by the model: a cap keeps it on, a model without Ultra drops it.
{
  reset({}, { maxEffortLevel: 'medium' })
  await st().setModel('claude-opus-4-8[1m]')
  ok(cur().ultracode === true, 'store: a capped model keeps Ultra on')
  ok(!calls.some((c) => c.name === 'setUltracode'), 'store: a capped switch sends no ultracode change')
  reset()
  await st().setModel('claude-haiku-4-5')
  ok(cur().ultracode === false, 'store: a model without Ultra turns it off')
}

// A refused or unanswered switch reverts the picker and says why; a superseded reply changes nothing.
{
  const fail = (r: Record<string, unknown>) => (replies.setModel = () => ({ ok: false, ...r }))
  fail({ errorCode: 'check_rejected', reason: 'API error: 400 The provided model identifier is invalid · model not changed' })
  reset({ ultracode: false })
  await st().setModel('claude-haiku-4-5-20251001')
  equal(st().notice?.message, "Couldn't switch to Haiku 4.5. The provided model identifier is invalid. The session is still on Opus 5.5.", 'store: a rejected switch shows the cleaned reason')
  equal(cur().modelChoice, 'claude-opus-5-5[1m]', 'store: and reverts the picker')
  fail({ errorCode: 'unknown_subtype', reason: 'Unknown subtype set_model' })
  reset({ ultracode: false, modelChoice: 'claude-sonnet-4-6[1m]' })
  await st().setModel('claude-sonnet-4-6')
  equal(st().notice?.message, "Couldn't switch to Sonnet 4.6 (200K). The session is still on Sonnet 4.6 (1M).", 'store: other errors get the generic line, sizes split equal labels')
  fail({ timedOut: true })
  reset({ ultracode: false })
  await st().setModel('claude-sonnet-4-6')
  ok(st().notice?.tone === 'warn' && st().notice?.message.startsWith('The switch to Sonnet 4.6 timed out, so the picker is back on Opus 5.5.'), 'store: a timeout warns instead')
  let release = (): void => {}
  replies.setModel = (_h: string, m: string) => (m === 'claude-sonnet-4-6' ? new Promise((r) => (release = () => r({ ok: false }))) : { ok: true })
  reset({ ultracode: false })
  const first = st().setModel('claude-sonnet-4-6')
  await st().setModel('claude-opus-4-8[1m]')
  release()
  await first
  ok(cur().modelChoice === 'claude-opus-4-8[1m]' && !st().notice, 'store: a superseded failure neither reverts nor notifies')
  replies.setModel = () => ({ ok: true })
}

// A model with no effort keeps the stored one and sends none, so it's still there on the way back.
{
  reset({ ultracode: false, effortChoice: 'max' })
  await st().setModel('claude-haiku-4-5-20251001')
  ok(cur().effortChoice === 'max' && !calls.some((c) => c.name === 'setEffort'), 'store: no-effort switch keeps the effort and sends none')
  await st().setModel('claude-opus-5-5[1m]')
  equal(cur().effortChoice, 'max', 'store: the switch back restores it')
}

// Toggling Ultra never touches effort, and its IPC carries only the flag.
{
  reset({ ultracode: false, effortChoice: 'max' })
  await st().setUltracode(true)
  await st().setUltracode(false)
  await st().setUltracode(true)
  ok(cur().effortChoice === 'max', 'store: Ultra toggles keep the stored effort')
  ok(!calls.some((c) => c.name === 'setEffort'), 'store: Ultra toggles never send an effort')
  const ultraCalls = calls.filter((c) => c.name === 'setUltracode')
  ok(ultraCalls.length === 3 && ultraCalls.every((c) => c.args.length === 2 && typeof c.args[1] === 'boolean'), 'store: setUltracode IPC is only (handle, on)')
  calls.length = 0
  await st().setEffort('low')
  ok(cur().ultracode === true && cur().effortChoice === 'low', 'store: picking an effort with Ultra on keeps Ultra')
  ok(!calls.some((c) => c.name === 'setUltracode'), 'store: picking an effort sends no ultracode change')
}

// Under System Default the CLI's reported mode is the one in effect; under a concrete pick a mismatch is a downgrade.
{
  const m = (modeChoice: string, permissionMode: string | null) => effectiveMode({ modelMode: null, modeChoice: modeChoice as any, permissionMode })
  equal(JSON.stringify(m('inherit', 'plan')), JSON.stringify({ mode: 'plan', downgraded: false, inherited: true }), 'mode: inherit + reported plan shows plan, inherited')
  equal(JSON.stringify(m('inherit', null)), JSON.stringify({ mode: 'inherit', downgraded: false, inherited: false }), 'mode: inherit before a report stays System Default')
  equal(JSON.stringify(m('auto', 'default')), JSON.stringify({ mode: 'default', downgraded: true, inherited: false }), 'mode: auto run as default is a downgrade')
}

// Picking System Default shows no mode until main names the one settings.json resolved to.
{
  reset({ modeChoice: 'plan', modelMode: null, permissionMode: 'plan' })
  let release!: () => void
  replies.setPermissionMode = () => new Promise((r) => (release = () => r({ ok: true, mode: 'bypassPermissions' })))
  const p = st().setPermissionMode('inherit')
  ok(cur().modeChoice === 'inherit' && cur().permissionMode === null, 'store: inherit pick clears the reported mode while pending')
  release()
  await p
  ok(cur().permissionMode === 'bypassPermissions' && effectiveMode(cur()).inherited, 'store: inherit pick takes the resolved mode from main')
  delete replies.setPermissionMode
}

// Retry copy
{
  const r = { attempt: 3, maxRetries: 10, delayMs: 11200, status: 403 as number | null }
  equal(apiRetryCopy(r), 'The API returned 403. Retrying in 12s, attempt 3 of 10.', 'store: retry copy with a status')
  equal(apiRetryCopy({ ...r, status: null }), "Couldn't reach the API. Retrying in 12s, attempt 3 of 10.", 'store: retry copy without a response')
  equal(apiRetryCopy({ ...r, attempt: 10 }), 'The API returned 403. Last retry in 12s.', 'store: last retry copy')
  equal(apiRetryCopy({ ...r, status: null, attempt: 10 }), "Couldn't reach the API. Last retry in 12s.", 'store: last retry copy without a response')
  equal(apiRetryCopy({ ...r, delayMs: 200 }), 'The API returned 403. Retrying in 1s, attempt 3 of 10.', 'store: retry delay floors at 1s')
  ok(![apiRetryCopy(r), apiRetryCopy({ ...r, status: null, attempt: 10 })].some((c) => /[–—…]/.test(c)), 'store: retry copy has no dashes or ellipsis')
}

const retry = (attempt: number, status: number | null = 403): any => ({ type: 'api-retry', attempt, maxRetries: 10, delayMs: 11200, status })

// Retry state is set by api-retry and cleared by stream, result, exit and Stop.
{
  const clears: [string, () => void | Promise<void>][] = [
    ['text-delta', () => st().applyEvent('h1', { type: 'text-delta', text: 'hi' })],
    ['message-start', () => st().applyEvent('h1', { type: 'message-start' })],
    ['result', () => st().applyEvent('h1', { type: 'result', sessionId: 's', isError: true, result: null })],
    ['process-exit', () => st().applyEvent('h1', { type: 'process-exit', code: 1 })],
    ['Stop', () => st().interrupt()]
  ]
  for (const [name, clear] of clears) {
    reset()
    st().applyEvent('h1', retry(3))
    ok(cur().apiRetry?.attempt === 3, `store: api-retry sets retry state (${name})`)
    st().dismissApiRetry()
    await clear()
    ok(cur().apiRetry === null && cur().apiRetryDismissed === false, `store: ${name} clears retry state`)
  }
  reset()
  st().applyEvent('h1', retry(3))
  st().applyEvent('h1', { type: 'result', sessionId: 's', isError: false, result: null, fromTaskNotification: true } as any)
  ok(cur().apiRetry?.attempt === 3, 'store: a bg result leaves the foreground retry')
}

// Dismiss holds for the run; the live text changes only on the first and last attempts.
{
  reset()
  const said: string[] = []
  for (let a = 1; a <= 10; a++) {
    st().applyEvent('h1', retry(a))
    if (said.at(-1) !== cur().apiRetryAnnounce) said.push(cur().apiRetryAnnounce)
    if (a === 3) st().dismissApiRetry()
  }
  ok(said.length === 2 && said[1] === 'The API returned 403. Last retry in 12s.', 'store: ten attempts announce twice')
  ok(cur().apiRetryDismissed === true, 'store: a dismissed retry stays hidden for later attempts')
  st().applyEvent('h1', { type: 'result', sessionId: 's', isError: true, result: null })
  st().applyEvent('h1', retry(1))
  ok(cur().apiRetry?.attempt === 1 && cur().apiRetryDismissed === false, "store: the next turn's retry shows again")
}

// Plugin status: keyed by plugin in first-arrival order, null removes, exit clears.
{
  reset({ modStatus: [], busy: false })
  const status = (plugin: string, text: string | null): void => st().applyEvent('h1', { type: 'mod-status', plugin, text })
  status('a', '1')
  status('b', '1')
  status('a', '2')
  ok(cur().modStatus.map((l: any) => `${l.plugin}${l.text}`).join() === 'a2,b1', 'store: a repeat status replaces in place')
  status('a', null)
  ok(cur().modStatus.length === 1 && cur().modStatus[0].plugin === 'b', 'store: a null status removes the line')
  st().applyEvent('h1', { type: 'mod-status-reset' })
  ok(cur().modStatus.length === 0, 'store: a respawn clears plugin status')
}

// Plugin toasts: the viewed session pops (deduped, capped at 3); a background one logs instead.
{
  reset({ modStatus: [], busy: false })
  useSession.setState({ modToasts: [] })
  const toast = (text: string, h = 'h1'): void => st().applyEvent(h, { type: 'mod-toast', plugin: 'p', text, timeoutMs: 60_000 })
  toast('one')
  toast('one')
  ok(st().modToasts.length === 1 && st().modToasts[0].count === 2, 'store: a repeated toast bumps its count')
  ok(st().modToasts[0].durationMs === 20_000, 'store: toast duration clamps to 20s')
  toast('two')
  toast('three')
  toast('four')
  ok(st().modToasts.map((t) => t.text).join() === 'four,three,two', 'store: a 4th toast evicts the oldest')
  ok(st().modToastAnnounce.text.startsWith('p plugin: four'), 'store: the latest toast is announced')
  useSession.setState({ sessions: { ...st().sessions, h2: slice({ handleId: 'h2', modStatus: [], busy: false }) } })
  toast('bg', 'h2')
  ok(st().modToasts.length === 3, 'store: a background session does not pop')
  const note = st().sessions.h2.messages.at(-1)?.hookNotes?.[0]
  ok(note?.plugin === 'p' && note.text === 'bg', 'store: a background toast lands in its transcript')
  st().applyEvent('h1', { type: 'mod-log', plugin: 'p', text: 'logged' })
  ok(cur().messages.at(-1)?.hookNotes?.[0]?.plugin === 'p', 'store: an idle log is a standalone note')
  ok(!cur().messages.some((m: any) => m.blocks?.some((b: any) => b.kind === 'text')), 'store: a log never becomes a text block')
}

// Auto-open on Claude's browser use: half, only from closed, held back by a manual hide until the
// next prompt, deferred for a background session, skipped over a subagent pane or a narrow Stage.
{
  const browser = { tabs: [{ id: 1, url: 'about:blank', title: '', drive: 'idle' }], viewed: 1, multi: false, toolTabs: {}, enter: [], announce: '' }
  const surfaces = { order: ['browser:1'], active: 'browser:1', tabs: {}, browserLastViewedAt: {}, browserUnseen: {} }
  const pane = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    browser,
    surfaces,
    annotate: { tab: null, note: null },
    paneOpen: false,
    surfacePaneFull: true,
    paneAutoOpen: false,
    paneAutoOpenSuppressed: false,
    statusAnnounce: '',
    ...over
  })
  const fresh = (over?: Record<string, unknown>): void => {
    reset(pane(over))
    useSession.setState({ stageWide: true, viewingSubagent: null, subagentTrail: [] })
  }
  const said = (h = 'h1'): boolean => st().sessions[h].statusAnnounce.startsWith('Claude opened the browser')

  fresh()
  ok(st().autoOpenPane('h1', 'browser:1') && said(), 'browser auto-open: the viewed closed pane opens and is announced')
  fresh({ paneOpen: true })
  ok(!st().autoOpenPane('h1', 'browser:1') && !said(), 'browser auto-open: an open pane is left alone')
  fresh({ browser: null, surfaces: { ...surfaces, order: [], active: null } })
  ok(!st().autoOpenPane('h1', 'browser:1'), 'browser auto-open: a session without the browser never opens')

  fresh({ paneOpen: true, paneAutoOpen: true })
  st().togglePane()
  ok(!cur().paneOpen && cur().paneAutoOpenSuppressed, 'browser auto-open: a manual hide suppresses')
  ok(!cur().paneAutoOpen, 'browser auto-open: a manual hide drops a pending open')
  ok(!st().autoOpenPane('h1', 'browser:1'), 'browser auto-open: suppressed until the next prompt')
  await st().sendMessage('next')
  ok(!cur().paneAutoOpenSuppressed && st().autoOpenPane('h1', 'browser:1'), 'browser auto-open: a prompt lifts the suppression')

  fresh({ paneOpen: true })
  st().setPane('collapsed')
  ok(!cur().paneAutoOpenSuppressed, 'browser auto-open: a programmatic collapse does not suppress')

  fresh()
  useSession.setState({ viewingSubagent: 't1', subagentTrail: ['t1'] })
  ok(!st().autoOpenPane('h1', 'browser:1') && !cur().paneAutoOpen, 'browser auto-open: skipped, not deferred, over a subagent pane')
  fresh()
  useSession.setState({ stageWide: false })
  ok(!st().autoOpenPane('h1', 'browser:1') && !cur().paneAutoOpen, 'browser auto-open: skipped, not deferred, on a narrow Stage')

  fresh()
  useSession.setState({ sessions: { ...st().sessions, h2: slice({ handleId: 'h2', ...pane() }) } })
  ok(!st().autoOpenPane('h2', 'browser:1'), 'browser auto-open: a background session does not open now')
  const h2 = st().sessions.h2
  ok(h2.paneAutoOpen && !h2.paneOpen && !said('h2') && !said(), 'browser auto-open: a background session is marked, silently')
  ok(h2.surfacePaneFull, 'browser auto-open: a deferral leaves the pane size alone')
  useSession.setState({ stageWide: false })
  st().activateSession('h2')
  ok(!st().sessions.h2.paneOpen && st().sessions.h2.paneAutoOpen, 'browser auto-open: a narrow Stage holds the deferred open')
  st().activateSession('h1')
  useSession.setState({ stageWide: true })
  st().activateSession('h2')
  const back = st().sessions.h2
  ok(back.paneOpen && !back.paneAutoOpen && said('h2'), 'browser auto-open: activation opens the deferred pane and announces')
  ok(!back.surfacePaneFull, 'browser auto-open: the deferred open is half')

  // Arriving at a session whose pane is already open mounts it without taking focus. If the Stage
  // already shows a browser pane nothing mounts, so no flag may be left behind.
  fresh()
  useSession.setState({ paneOpenedQuietly: false, sessions: { ...st().sessions, h2: slice({ handleId: 'h2', ...pane({ paneOpen: true }) }) } })
  st().activateSession('h2')
  ok(st().paneOpenedQuietly, 'session switch: an open pane mounts quietly')
  useSession.setState({ paneOpenedQuietly: false, sessions: { ...st().sessions, h1: { ...st().sessions.h1, paneOpen: true } } })
  st().activateSession('h1')
  ok(!st().paneOpenedQuietly, 'session switch: a pane already on the Stage sets no flag')

  // The hand-offs that pick a neighbour without activateSession open it the same way.
  const pair = (h1: Record<string, unknown>): void => {
    fresh({ createdMs: 2, lastActivityMs: 2, ...h1 })
    const h2 = slice({ handleId: 'h2', createdMs: 1, lastActivityMs: 1, ...pane({ paneAutoOpen: true }) })
    useSession.setState({ sessions: { ...st().sessions, h2 } })
  }
  pair({})
  await st().closeSession('h1')
  ok(st().activeHandleId === 'h2' && st().sessions.h2.paneOpen && said('h2'), 'browser auto-open: closing hands off to an opened neighbour')
  pair({ model: null })
  st().applyEvent('h1', { type: 'process-exit', code: 1 })
  ok(st().activeHandleId === 'h2' && st().sessions.h2.paneOpen && said('h2'), 'browser auto-open: a failed launch hands off to an opened neighbour')
  pair({})
  useSession.setState({ activeHandleId: 'h2', sessions: { ...st().sessions, h3: slice({ handleId: 'h3', ...pane() }) } })
  await st().closeSession('h3')
  ok(!st().sessions.h2.paneOpen, 'browser auto-open: closing a background session leaves the viewed one alone')

  fresh({ paneOpen: true, surfacePaneFull: false })
  useSession.setState({ paneFull: false, sessions: { ...st().sessions, h2: slice({ handleId: 'h2', ...pane({ surfacePaneFull: false }) }) } })
  st().setPane('full')
  ok(cur().surfacePaneFull && !st().sessions.h2.surfacePaneFull && !st().paneFull, 'pane size: kept per session, apart from the subagent pane')
  st().setPane('collapsed')
  ok(cur().surfacePaneFull, 'pane size: hiding keeps the choice for the next open')
}

// Surface intents (focus, open, prepare) and browser placement reconciliation.
{
  const tab = (id: number, over: Record<string, unknown> = {}): any => ({ id, url: 'about:blank', title: '', drive: 'idle', ...over })
  const browserOf = (ids: number[], viewed = ids[0]): any => ({ tabs: ids.map((id) => tab(id)), viewed, multi: ids.length > 1, toolTabs: {}, enter: [], announce: '' })
  const empty = { order: [], active: null, tabs: {}, browserLastViewedAt: {}, browserUnseen: {} }
  const fresh = (over: Record<string, unknown> = {}): void => {
    reset({ browser: null, surfaces: empty, paneOpen: false, paneAutoOpen: false, paneAutoOpenSuppressed: false, surfacePaneFull: false, statusAnnounce: '', annotate: { tab: null, note: null }, ...over })
    useSession.setState({ stageWide: true, viewingSubagent: null, subagentTrail: [], paneOpenedQuietly: false, settingsSection: null })
    notePaneInput(0)
  }
  const sur = (): any => cur().surfaces
  const DIFF = { kind: 'diff' as const, key: '', title: 'Claude changes' }
  const FILE = { kind: 'file' as const, key: '/tmp/w/src/a.ts', title: 'a.ts' }
  const openDiff = (): void => void st().openSurface('h1', DIFF, 'open', 'user', 'user')

  // focus · user · any → active, pane opens, focus moves (the mount isn't quiet).
  fresh()
  const id = st().openSurface('h1', FILE, 'focus', 'user', 'user')
  ok(id === 'file:/tmp/w/src/a.ts' && sur().active === id && cur().paneOpen && !st().paneOpenedQuietly, 'intent: a user focus activates, opens and takes focus')
  useSession.setState({ viewingSubagent: 't1', subagentTrail: ['t1'] })
  st().openSurface('h1', DIFF, 'focus', 'user', 'user')
  ok(sur().active === 'diff' && st().viewingSubagent === null, 'intent: an explicit user activation closes the subagent view')

  // One resource, one tab: a file open of a page Claude made lands on its artifact tab.
  fresh()
  const art = st().openSurface('h1', { kind: 'artifact', key: '/tmp/w/index.html', title: 'index.html', provenance: { sessionId: 's', creatingEditId: 'e1' } }, 'prepare', 'claude', 'change')
  ok(st().openSurface('h1', { kind: 'file', key: '/tmp/w/index.html', title: 'index.html' }, 'focus', 'user', 'user') === art, 'identity: a file open of an artifact path returns the artifact tab')
  ok(sur().order.length === 1 && sur().active === art && sur().tabs[art].kind === 'artifact', 'identity: no second tab, and the artifact tab is active')
  st().openSurface('h1', { kind: 'file', key: '/tmp/w/other.html', title: 'other.html' }, 'focus', 'user', 'user')
  ok(sur().order.length === 2, 'identity: another path still gets its own file tab')

  // focus · Claude · open, user on another tab and touched the pane in the last 10s → prepare.
  fresh({ paneOpen: true })
  openDiff()
  notePaneInput(Date.now() - 2000)
  st().openSurface('h1', FILE, 'focus', 'claude', 'claude')
  ok(sur().active === 'diff' && sur().tabs[id].unseen === true, 'intent: Claude focus downgrades to prepare after recent pane input')
  notePaneInput(Date.now() - PANE_RECENT_MS - 1)
  st().openSurface('h1', FILE, 'focus', 'claude', 'claude')
  ok(sur().active === id && !sur().tabs[id].unseen && !st().paneOpenedQuietly, 'intent: Claude focus with an open pane activates once the input is older than 10s')

  // focus · Claude while a Gate or the subagent view is up → prepare.
  fresh({ paneOpen: true, pendingPermissions: [{ requestId: 'r', toolName: 'Bash', input: {} }] })
  openDiff()
  st().openSurface('h1', FILE, 'focus', 'claude', 'claude')
  ok(sur().active === 'diff', 'intent: Claude focus waits while a Gate is up')
  fresh({ paneOpen: true })
  openDiff()
  useSession.setState({ viewingSubagent: 't1', subagentTrail: ['t1'] })
  st().openSurface('h1', FILE, 'focus', 'claude', 'claude')
  ok(sur().active === 'diff' && st().viewingSubagent === 't1', 'intent: Claude focus preserves the subagent takeover')

  // focus · Claude · closed → active; the pane opens only under the auto-open conditions.
  fresh()
  st().openSurface('h1', FILE, 'focus', 'claude', 'claude')
  ok(sur().active === id && cur().paneOpen && st().paneOpenedQuietly && cur().statusAnnounce.startsWith('Claude opened a.ts'), 'intent: Claude focus on a closed pane auto-opens quietly and says so')
  fresh()
  useSession.setState({ stageWide: false })
  st().openSurface('h1', FILE, 'focus', 'claude', 'claude')
  ok(sur().active === id && !cur().paneOpen, 'intent: a narrow Stage keeps the pane closed')
  fresh({ paneAutoOpenSuppressed: true })
  st().openSurface('h1', FILE, 'focus', 'claude', 'claude')
  ok(sur().active === id && !cur().paneOpen, 'intent: a manual hide keeps the pane closed')
  fresh()
  useSession.setState({ sessions: { ...st().sessions, h2: slice({ handleId: 'h2', browser: null, surfaces: empty, paneOpen: false, annotate: { tab: null, note: null } }) } })
  st().openSurface('h2', FILE, 'focus', 'claude', 'claude')
  ok(st().sessions.h2.surfaces.active === id && !st().sessions.h2.paneOpen && st().sessions.h2.paneAutoOpen, 'intent: a background session opens on its next visit')

  // The announcement says what became visible, by kind, and only when it did.
  const heard = (): string => cur().statusAnnounce.replace(/\u200b/g, '')
  fresh()
  st().openSurface('h1', DIFF, 'focus', 'claude', 'claude')
  ok(heard() === 'Claude opened its changes', 'announce: a diff opening the pane says "its changes"')
  fresh({ paneOpen: true })
  openDiff()
  st().openSurface('h1', { ...FILE, location: { line: 40, endLine: 52 } }, 'focus', 'claude', 'claude')
  ok(heard() === 'Claude opened lines 40 to 52 of a.ts', 'announce: a new tab in a visible pane is opened, with its range')
  st().openSurface('h1', DIFF, 'focus', 'claude', 'claude')
  ok(heard() === 'Claude is showing its changes', 'announce: an existing tab made active is showing')
  st().openSurface('h1', { kind: 'file', key: '/tmp/w/main/a.ts', title: 'a.ts', location: { line: 142 } }, 'focus', 'claude', 'claude')
  ok(heard() === 'Claude opened a.ts in main at line 142', 'announce: a shared basename adds its distinguishing folder')
  st().openSurface('h1', { kind: 'tree', key: '', title: 'w', location: { file: '/tmp/w/src/main' } }, 'focus', 'claude', 'claude')
  ok(heard() === 'Claude opened src/main in the file tree', 'announce: a tree location reads cwd-relative')
  const before = cur().statusAnnounce
  st().openSurface('h1', DIFF, 'prepare', 'claude', 'claude')
  st().openSurface('h1', FILE, 'focus', 'user', 'user')
  ok(cur().statusAnnounce === before, 'announce: prepare and user opens say nothing')

  // open · any · open → active; open · closed → a user open opens the pane, Claude's follows the auto-open conditions.
  fresh({ paneOpen: true })
  openDiff()
  st().openSurface('h1', FILE, 'open', 'claude', 'link')
  ok(sur().active === id, 'intent: open with the pane up activates')
  fresh()
  st().openSurface('h1', FILE, 'open', 'user', 'link')
  ok(cur().paneOpen && !st().paneOpenedQuietly, 'intent: a user open on a closed pane opens it with focus')
  fresh()
  useSession.setState({ stageWide: false })
  st().openSurface('h1', FILE, 'open', 'claude', 'link')
  ok(sur().active === id && !cur().paneOpen, 'intent: a Claude open on a closed pane follows the auto-open conditions')

  // prepare → placed unseen, nothing else moves; on the active tab the destination waits in pendingShow.
  fresh({ paneOpen: true })
  openDiff()
  st().openSurface('h1', { ...FILE, location: { line: 9 } }, 'prepare', 'claude', 'claude')
  ok(sur().active === 'diff' && sur().tabs[id].unseen && sur().tabs[id].location.line === 9, 'intent: prepare places an unseen tab behind')
  fresh()
  st().openSurface('h1', DIFF, 'prepare', 'claude', 'change')
  ok(!cur().paneOpen && sur().active === null && sur().order.join() === 'diff', 'intent: prepare never opens the pane')
  fresh({ paneOpen: true })
  openDiff()
  st().openSurface('h1', { ...DIFF, location: { file: 'b.ts' } }, 'prepare', 'claude', 'change')
  ok(sur().tabs.diff.pendingShow?.location.file === 'b.ts' && !sur().tabs.diff.location, 'intent: prepare on the active tab only records pendingShow')
  st().openSurface('h1', FILE, 'open', 'user', 'user')
  st().activateSurface('h1', 'diff')
  ok(sur().tabs.diff.location?.file === 'b.ts' && !sur().tabs.diff.pendingShow, 'intent: a later activation applies the pending destination')
  st().openSurface('h1', DIFF, 'open', 'user', 'user')
  ok(sur().order.filter((x: string) => x === 'diff').length === 1, 'intent: the diff is a session singleton')

  // The tree taking over from a file in the cwd reveals it once; other tabs, outside files and a sent destination don't.
  const TREE = { kind: 'tree' as const, key: '', title: 'w' }
  fresh({ paneOpen: true })
  st().openSurface('h1', FILE, 'open', 'user', 'user')
  st().openSurface('h1', TREE, 'open', 'user', 'user')
  ok(sur().active === 'tree' && sur().tabs.tree.reveal === FILE.key, 'reveal: the tree opened from a cwd file reveals it')
  st().activateSurface('h1', 'tree')
  ok(!sur().tabs.tree.reveal, 'reveal: re-activating the active tree reveals nothing')
  openDiff()
  st().activateSurface('h1', 'tree')
  ok(!sur().tabs.tree.reveal, 'reveal: from a non-file tab nothing is revealed')
  st().openSurface('h1', { kind: 'file', key: '/elsewhere/b.ts', title: 'b.ts' }, 'open', 'user', 'user')
  st().activateSurface('h1', 'tree')
  ok(!sur().tabs.tree.reveal, 'reveal: a file outside the cwd is not revealed')
  st().activateSurface('h1', id)
  st().openSurface('h1', { ...TREE, location: { file: '/tmp/w/src' } }, 'open', 'claude', 'claude')
  ok(!sur().tabs.tree.reveal && sur().tabs.tree.location.file === '/tmp/w/src', 'reveal: a destination sent with the open wins')
  st().activateSurface('h1', id)
  st().openSurface('h1', { ...TREE, location: { file: '/tmp/w/main' } }, 'prepare', 'claude', 'claude')
  st().activateSurface('h1', 'tree')
  ok(!sur().tabs.tree.reveal && sur().tabs.tree.location.file === '/tmp/w/main', 'reveal: a destination Claude placed behind wins')
  st().openSurface('h1', { ...TREE, location: { file: '/tmp/w/lib' } }, 'prepare', 'claude', 'claude')
  st().activateSurface('h1', id)
  st().activateSurface('h1', 'tree')
  ok(!sur().tabs.tree.reveal && sur().tabs.tree.location.file === '/tmp/w/lib', 'reveal: a pending destination wins')
  st().activateSurface('h1', id)
  st().togglePane()
  st().activateSurface('h1', 'tree')
  ok(!cur().paneOpen && sur().tabs.tree.reveal === FILE.key, 'reveal: a hidden pane still reveals the last file tab')

  // Reconciliation: seeded tab 1, Claude's tab behind and unseen, optimistic close, neighbour, last tab.
  fresh({ browser: browserOf([1]), surfaces: { ...empty, order: ['browser:1'], active: 'browser:1' }, paneOpen: true })
  st().applyBrowserEvent('h1', { type: 'tab-opened', tab: tab(2), by: 'agent', viewed: 1 })
  ok(sur().order.join() === 'browser:1,browser:2' && sur().active === 'browser:1' && sur().browserUnseen['browser:2'], 'placement: a Claude tab is placed behind, unseen')
  st().applyBrowserEvent('h1', { type: 'tab-opened', tab: tab(3), by: 'user', viewed: 3 })
  ok(sur().active === 'browser:3', "placement: the user's own new tab is active")
  st().activateSurface('h1', 'browser:2')
  ok(sur().active === 'browser:2' && !sur().browserUnseen['browser:2'] && cur().browser.viewed === 2 && calls.some((c) => c.name === 'browserViewTab' && c.args[1] === 2), 'placement: activating views the tab in main and clears unseen')
  openDiff()
  st().applyBrowserEvent('h1', { type: 'tool-tab', toolUseId: 'u1', tab: 2 })
  ok(sur().browserUnseen['browser:2'], "placement: Claude's work in an inactive tab marks it unseen")
  st().activateSurface('h1', 'browser:2')
  st().closeSurface('h1', 'browser:2')
  ok(sur().order.join() === 'browser:1,browser:3,diff' && sur().active === 'browser:3' && cur().browser.viewed === 3 && calls.some((c) => c.name === 'browserCloseTab'), 'placement: an optimistic close hands the active placement to its right neighbour')
  st().applyBrowserEvent('h1', { type: 'tab-closed', tab: 2, by: 'user', viewed: 3 })
  ok(sur().active === 'browser:3', 'placement: main confirming the close changes nothing')
  st().applyBrowserEvent('h1', { type: 'tab-closed', tab: 3, by: 'agent', viewed: 1 })
  ok(sur().active === 'diff' && sur().order.join() === 'browser:1,diff', 'placement: an active placement Claude closed hands over to its neighbour in the strip')
  st().activateSurface('h1', 'diff')
  st().applyBrowserEvent('h1', { type: 'tab-closed', tab: 1, by: 'agent', viewed: 1 })
  ok(sur().active === 'diff' && cur().paneOpen, 'placement: closing a browser tab behind another surface leaves it active')
  st().closeSurface('h1', 'diff')
  ok(!cur().paneOpen && sur().order.length === 0 && sur().active === null && cur().statusAnnounce.startsWith('Closed the last tab. Pane hidden.') && !cur().paneAutoOpenSuppressed, 'placement: closing the last tab hides the pane, says so, and leaves auto-open on')

  // Claude's closes are said from where the strip lands, including the picker when the pane empties.
  fresh({ browser: browserOf([1, 2]), surfaces: { ...empty, order: ['browser:1', 'browser:2'], active: 'browser:2' }, paneOpen: true })
  openDiff()
  st().activateSurface('h1', 'browser:2')
  st().applyBrowserEvent('h1', { type: 'tab-closed', tab: 2, by: 'agent', viewed: 1 })
  ok(cur().browser.announce.startsWith('Claude closed tab 2. Showing Claude changes'), 'announce: a close that lands on another kind names it')
  st().closeSurface('h1', 'diff')
  st().applyBrowserEvent('h1', { type: 'tab-closed', tab: 1, by: 'agent', viewed: 1 })
  ok(!cur().paneOpen && sur().active === null && cur().statusAnnounce.startsWith('Claude closed the last tab. Pane hidden.') && !cur().paneAutoOpenSuppressed, 'announce: Claude closing the last tab hides the pane and says so in the status region')

  // The toggle opens on the tab Claude drives; ⇧⌘B stays on the browser.
  fresh({ browser: { ...browserOf([1, 2]), tabs: [tab(1), tab(2, { drive: 'driving' })] }, surfaces: { ...empty, order: ['browser:1', 'browser:2', 'diff'], active: 'diff', tabs: { diff: { id: 'diff', kind: 'diff', key: '', title: 'Claude changes', openedBy: 'user', openedAt: 0, lastViewedAt: 0 } } } })
  ok(paneTarget(cur()) === 'browser:2', 'toggle: a driven tab is the target while the pane is hidden')
  st().togglePane()
  ok(cur().paneOpen && sur().active === 'browser:2', 'toggle: opening activates the target')
  st().activateSurface('h1', 'diff')
  st().toggleBrowser()
  ok(cur().paneOpen && sur().active === 'browser:2', 'browser toggle: from another kind it shows the browser')
  st().toggleBrowser()
  ok(!cur().paneOpen && cur().paneAutoOpenSuppressed, 'browser toggle: on the browser it hides and suppresses')
  await st().sendMessage('next')
  ok(!cur().paneAutoOpenSuppressed, 'suppression: cleared on the next prompt')

  // setSurfaceView refuses a viewState of another kind.
  st().setSurfaceView('h1', 'diff', { viewState: { kind: 'file', topLine: 1, offsetPx: 0, scrollLeft: 0, previewScrollTop: 0 } })
  ok(!sur().tabs.diff.viewState, 'view state: a mismatched kind is refused')
  st().setSurfaceView('h1', 'diff', { viewState: { kind: 'diff', offsetPx: 12 } })
  ok(sur().tabs.diff.viewState?.offsetPx === 12, 'view state: a matching kind is kept')

  // The picker: an empty pane opens with a cwd, and the toggle opens it without a browser.
  fresh({ cwd: '' })
  st().setPane('half')
  ok(!cur().paneOpen, 'picker: no cwd, no pane')
  fresh()
  calls.length = 0
  st().togglePane()
  ok(cur().paneOpen && sur().active === null && !calls.some((c) => c.name === 'browserNewTab'), 'picker: the toggle opens an empty pane on the picker without a browser')
  st().togglePane()
  ok(!cur().paneOpen, 'picker: the toggle hides it again')
  fresh({ browser: browserOf([]) })
  calls.length = 0
  st().togglePane()
  ok(cur().paneOpen && sur().active === null && !calls.some((c) => c.name === 'browserNewTab'), 'picker: with a browser and no tab, the toggle shows the picker too')
  fresh({ paneOpen: true })
  useSession.setState({ viewingSubagent: 't1', subagentTrail: ['t1'] })
  st().togglePane()
  ok(cur().paneOpen && st().viewingSubagent === null, 'picker: over the subagent view the toggle shows the pane instead of hiding it')
}

const res = (over: Record<string, unknown> = {}): any => ({ type: 'result', sessionId: 's', isError: false, result: null, ...over })
const q = (id: string, text: string): any => ({ id, text, refs: [] })

// A user's message folded into a background-woken turn ends the user's turn at that turn's result.
{
  reset({ queuedMessages: [q('q1', 'next')] })
  st().applyEvent('h1', res({ fromTaskNotification: true }))
  ok(cur().busy && cur().queuedMessages.length === 1, 'store: a woken turn that took nothing of the user\'s keeps busy and the queue')
  st().applyEvent('h1', res({ fromTaskNotification: true, answersUser: true }))
  ok(!cur().busy || calls.some((c) => c.name === 'sendMessage'), 'store: a woken turn that answered the user ends the user\'s turn')
  ok(cur().queuedMessages.length === 0, 'store: and releases the next queued message')
}

// Send now cuts the turn and the message runs as its own: the cut turn's result isn't the end.
{
  reset({ queuedMessages: [q('q1', 'later')], turnStartMs: 5, messages: [{ id: 'a', role: 'assistant', text: 'x', thinking: '', tools: [], blocks: [] }, { id: 'u', role: 'user', text: 'now', thinking: '', tools: [], blocks: [] }] })
  st().applyEvent('h1', res({ sendNowPending: true, durationMs: 3000, usage: { costUSD: 0.01, inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, thinkingTokens: 0, models: [] } }))
  ok(cur().busy && cur().queuedMessages.length === 1, 'store: a cut turn keeps busy and holds the queue')
  ok(cur().messages[0].usage?.costUSD === 0.01, 'store: the cut turn\'s result records the reply above the sent message')
  st().applyEvent('h1', res({ durationMs: 2000 }))
  ok(cur().queuedMessages.length === 0, 'store: the sent message\'s own result is the boundary')
}

// Send now leaves the queue at once and goes over its own channel.
{
  reset({ queuedMessages: [q('q1', 'a'), q('q2', 'b')] })
  st().sendQueuedNow('q1')
  ok(cur().queuedMessages.map((m: any) => m.id).join() === 'q2', 'store: Send now removes the row synchronously')
  ok(cur().messages.at(-1)?.text === 'a', 'store: Send now appends the user bubble')
  await new Promise((r) => setTimeout(r, 0))
  ok(calls.some((c) => c.name === 'sendMessage' && (c.args[1] as any).text === 'a' && (c.args[1] as any).now === true), 'store: Send now goes through sendMessage with now')
  reset({ interrupting: true, busy: false, queuedMessages: [q('q1', 'a')] })
  st().sendQueuedNow('q1')
  ok(cur().queuedMessages.length === 1, 'store: Send now does nothing while stopping')
  reset({ messages: [{ id: 'a', role: 'assistant', text: 'x', thinking: '', tools: [{ id: 't', name: 'Bash', input: {} }], blocks: [] }] })
  st().applyEvent('h1', res({ endReason: { kind: 'cut' } }))
  ok(cur().messages[0].tools[0].stopped && cur().messages[0].tools[0].result === '', 'store: a call left without a result at the turn end reads stopped')
  ok(cur().statusAnnounce?.replace(/\u200b/g, '') === 'Claude stopped its current step to answer.', 'store: a cut turn announces the cut')
  reset({ messages: [{ id: 'a', role: 'assistant', text: 'x', thinking: '', tools: [{ id: 't', name: 'Bash', input: {} }], blocks: [] }] })
  st().applyEvent('h1', res({ endReason: { kind: 'failed' } }))
  ok(!cur().messages[0].tools[0].stopped && cur().messages[0].tools[0].isError, 'store: a call left without a result by a failed turn reads failed')
}

// A turn a background task's end started opens its own message, captioned with that task.
{
  const ended = { id: 'a', role: 'assistant', text: 'launched', thinking: '', tools: [], blocks: [], turnEnd: {} }
  reset({ busy: false, messages: [ended], backgroundTasks: { t1: { taskId: 't1', description: 'sleep', taskType: 'local_agent', toolUseId: 'tu', status: 'running', startMs: 0 } } })
  st().applyEvent('h1', { type: 'bg-task-notification', taskId: 't1', status: 'completed' })
  st().applyEvent('h1', { type: 'text-delta', text: 'Both done' })
  const msgs = cur().messages
  ok(msgs.length === 2 && msgs[0].text === 'launched' && msgs[1].text === 'Both done', 'store: woken text starts a new message')
  ok(msgs[1].wokenBy?.[0]?.kind === 'agent' && msgs[1].wokenBy[0].description === 'sleep', 'store: the woken message names its task')
  ok(cur().endedTasks.length === 0, 'store: the caption consumes the ended tasks')
}

// Monitors: a turn that starts on its own is billed to the monitors watching, and a peer turn isn't.
{
  const call = (id: string, description: string): any => ({ id, name: 'Monitor', input: { command: 'tail -f /tmp/x.log', description, timeout_ms: 600000 }, result: 'Monitor started' })
  const usage = { costUSD: 0.004, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, thinkingTokens: 0, models: [] }
  const host = { id: 'a', role: 'assistant', text: '', thinking: '', tools: [call('m1', 'build log'), call('m2', 'test log')], blocks: [], turnEnd: {} }
  const wake = (over: Record<string, unknown>): void => {
    st().applyEvent('h1', { type: 'text-delta', text: 'saw it' })
    st().applyEvent('h1', res({ usage, ...over }))
  }
  reset({ busy: false, messages: [host] })
  st().applyEvent('h1', { type: 'bg-task-started', taskId: 't1', toolUseId: 'm1', description: 'tail', taskType: 'local_bash' })
  equal(cur().monitors.m1?.description, 'build log', 'monitor: the record takes the call\'s description')
  ok(cur().backgroundTasks.t1, 'monitor: the tray still gets the task')
  wake({ fromTaskNotification: true })
  equal(wokenLine(cur().messages.at(-1).wokenBy).text, 'Woken by monitor: build log', 'monitor: one running monitor captions the wake')
  equal(monitorMeta(cur().monitors.m1, true), '1 wake · $0.0040', 'monitor: the wake and its cost are counted')
  st().applyEvent('h1', { type: 'bg-task-started', taskId: 't2', toolUseId: 'm2', description: 'tail', taskType: 'local_bash' })
  wake({ fromTaskNotification: true })
  equal(wokenLine(cur().messages.at(-1).wokenBy).text, 'Woken by one of 2 monitors', 'monitor: two running monitors share the caption')
  equal(monitorMeta(cur().monitors.m1, true), '2 wakes, 1 shared · $0.0080', 'monitor: a shared wake counts on the first')
  equal(monitorMeta(cur().monitors.m2, true), '1 wake, 1 shared · $0.0040', 'monitor: and on the second')
  wake({ fromPeer: true })
  ok(!cur().messages.at(-1).wokenBy, 'monitor: a turn from elsewhere drops the guess')
  equal(cur().monitors.m1.wakes, 2, 'monitor: and counts nothing')
  st().applyEvent('h1', { type: 'bg-task-notification', taskId: 't1', status: 'completed' })
  equal(useSession.getState().notice?.message, 'Monitor ended: build log', 'monitor: its end toasts as a monitor')
  equal(cur().monitors.m1.status, 'completed', 'monitor: the record outlives its task')
  wake({ fromTaskNotification: true })
  equal(wokenLine(cur().messages.at(-1).wokenBy).text, 'Monitor ended: build log', 'monitor: the stream-end wake names the ended monitor')
  equal(cur().monitors.m1.wakes, 3, 'monitor: and is billed to it')
  equal(cur().monitors.m2.wakes, 1, 'monitor: not to the one still watching')
  st().applyEvent('h1', { type: 'bg-tasks-changed', taskIds: [] })
  equal(cur().monitors.m2.status, 'completed', 'monitor: one dropped from the running snapshot has ended')
  reset({ monitors: { m: { taskId: 't', description: 'd', status: 'running', startMs: 0, wakes: 0, sharedWakes: 0, costUsd: 0, estimated: false } } })
  st().applyEvent('h1', { type: 'process-exit', code: 0 })
  equal(cur().monitors.m.status, 'completed', 'monitor: an exited session stops watching')
}
equal(wakeCandidates(undefined, [], { m: { taskId: 't', description: 'd', status: 'running', startMs: 0, wakes: 0, sharedWakes: 0, costUsd: 0, estimated: false } }).join(), 'm', 'monitor: a wake with no streamed reply goes to the running monitors')
equal(wakeCandidates(undefined, [{ kind: 'agent', description: 'a', status: 'completed' }], {}).length, 0, 'monitor: a subagent\'s wake is no monitor\'s')
ok(countWake({ m: { taskId: 't', description: 'd', status: 'running', startMs: 0, wakes: 0, sharedWakes: 0, costUsd: 0, estimated: false } }, ['m'], { costUSD: 1, inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, thinkingTokens: 0, models: [{ model: 'x' }] }).m.estimated, 'monitor: an unpriced wake is an estimate')

// A turn that launched background work counts it in its footer until it ends.
{
  reset({ messages: [{ id: 'a', role: 'assistant', text: 'go', thinking: '', tools: [], blocks: [] }] })
  st().applyEvent('h1', { type: 'bg-task-started', taskId: 't1', toolUseId: 'x', description: 'd', taskType: 'local_agent' })
  st().applyEvent('h1', res({ durationMs: 61000 }))
  ok(cur().messages[0].turnEnd?.bgTaskIds?.[0] === 't1', 'store: the turn keeps the tasks it launched')
  ok(/^Waiting for 1 background task/.test(cur().statusAnnounce), 'store: a turn with running tasks announces the wait')
}

// Auto mode's check shows from checking to done, the tool's result, or a permission request.
{
  reset()
  st().applyEvent('h1', { type: 'permission-check', toolUseId: 't', checking: true })
  ok(cur().checkingTools.t, 'store: checking marks the tool')
  st().applyEvent('h1', { type: 'permission-request', requestId: 'r', toolName: 'Bash', input: {}, toolUseId: 't' })
  ok(!cur().checkingTools.t, 'store: a permission request ends the check')
  st().applyEvent('h1', { type: 'permission-check', toolUseId: 't', checking: true })
  st().applyEvent('h1', { type: 'permission-check', toolUseId: 't', checking: false })
  ok(!cur().checkingTools.t, 'store: done ends the check')
}

// Usage-limit copy.
{
  const now = new Date(2026, 9, 12, 9, 0)
  const at = (h: number, m: number, d = 12): number => new Date(2026, 9, d, h, m).getTime() / 1000
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(at(15, 40) * 1000))
  ok(rateLimitCopy({ status: 'allowed_warning', utilization: 0.82, window: 'five_hour', resetsAt: at(15, 40), extraUsage: false }, now) === `You've used 82% of your 5-hour limit. It resets at ${time}.`, 'rate limit: warning names window and reset')
  ok(rateLimitCopy({ status: 'allowed_warning', utilization: 0.5, window: 'seven_day_opus', extraUsage: false }, now) === "You've used 50% of your usage limit.", 'rate limit: an unnamed window drops the phrase, no reset drops the clause')
  ok(rateLimitCopy({ status: 'rejected', resetsAt: at(15, 40), extraUsage: false }, now) === `Usage limit reached. Claude can't respond until ${time}.`, 'rate limit: same-day reset after until has no preposition')
  ok(rateLimitCopy({ status: 'rejected', extraUsage: false }, now) === "Usage limit reached. Claude can't respond until it resets.", 'rate limit: blocked with no reset')
  ok(/^Usage limit reached\. Extra usage is on, .* until \w+day at /.test(rateLimitCopy({ status: 'rejected', resetsAt: at(15, 40, 14), extraUsage: true }, now)), 'rate limit: extra usage, a later weekday')
  const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(at(9, 0, 25) * 1000))
  ok(rateLimitCopy({ status: 'allowed_warning', resetsAt: at(9, 0, 25), extraUsage: false }, now) === `You're close to your usage limit. It resets on ${date}.`, 'rate limit: a week out reads as a date')
}

// Turn-end lines.
{
  ok(turnEndLine(undefined, 63000, 0)?.text === 'Worked for 1m 03s', 'turn end: completed')
  ok(turnEndLine(undefined, 63000, 2)?.text === 'Waiting for 2 background tasks', 'turn end: a completed turn with running tasks shows only the wait')
  ok(turnEndLine(undefined, undefined, 0) === null, 'turn end: nothing to say')
  ok(turnEndLine({ kind: 'stopped' }, 47000, 1)?.text === 'Stopped by you after 47s · Waiting for 1 background task', 'turn end: a stop keeps its lead and appends the wait')
  ok(turnEndLine({ kind: 'max-turns', limit: 3 }, 5000, 0)?.text === 'Stopped at the 3-turn limit after 5s · Send a message to continue', 'turn end: turn limit')
  ok(turnEndLine({ kind: 'max-turns', limit: 3 }, 95000, 2)?.text === 'Stopped at the 3-turn limit after 1m 35s · Waiting for 2 background tasks · Send a message to continue', 'turn end: the wait sits before the call to continue')
  ok(turnEndLine({ kind: 'early', reason: 'hook_stopped' }, undefined, 0)?.title.includes('hook_stopped'), 'turn end: an early stop names its reason on hover')
  ok(turnEndLine({ kind: 'failed' }, 2000, 0)?.glyph === 'warn', 'turn end: a failure carries the warning glyph')
  ok(turnEndLine({ kind: 'cut' }, 63000, 2)?.text === 'Stopped for your message after 1m 03s · Waiting for 2 background tasks', 'turn end: a Send now cut keeps the wait')
  ok(turnEndLine({ kind: 'cut' }, undefined, 0)?.text === 'Stopped for your message', 'turn end: a cut with no duration')
  ok(wokenLine([{ kind: 'command', description: 'npm test', status: 'failed' }]).text === 'Background command failed: npm test', 'woken: one command')
  ok(wokenLine([{ kind: 'agent', description: 'a', status: 'completed' }, { kind: 'agent', description: 'b', status: 'failed' }]).text === '2 background tasks ended, 1 failed', 'woken: several, one failed')
}

// The live announcement reads the line as a sentence.
{
  reset({ turnStartMs: 1, messages: [{ id: 'a', role: 'assistant', text: 'x', thinking: '', tools: [], blocks: [] }] })
  st().applyEvent('h1', { type: 'result', sessionId: 's', isError: true, result: null, endReason: { kind: 'max-turns', limit: 2 }, durationMs: 4000 } as any)
  ok(cur().statusAnnounce.startsWith('Stopped at the 2-turn limit after 4s, send a message to continue'), 'store: the announcement lowercases after its commas')
  reset({ turnStartMs: 1, messages: [{ id: 'a', role: 'assistant', text: 'x', thinking: '', tools: [], blocks: [] }] })
  st().applyEvent('h1', { type: 'result', sessionId: 's', isError: false, result: null, localCommand: true } as any)
  ok(cur().messages[0].turnEnd?.durationMs === undefined, 'store: a local command gets no duration')
}

// The chip never shows System Default: an unknown resolved mode is named as written, nothing reported reads Interactive.
{
  const unknown = effectiveMode({ modelMode: null, modeChoice: 'inherit', permissionMode: 'turbo' } as any)
  ok(chipMode(unknown.mode, 'turbo').raw === 'turbo', 'chip: a mode Clui does not know is named as written')
  ok(chipMode('inherit', null).mode === 'default' && chipMode('inherit', null).raw === null, 'chip: nothing reported reads Interactive')
  ok(chipMode('bypassPermissions', 'bypassPermissions').raw === null, 'chip: a known mode shows its own label')
}

// Changes mirror main's ledger; a session main has let go of keeps its last summaries.
{
  const row = { path: '/w/a.ts', added: 3, removed: 1, created: false, missingOnDisk: false, approximate: false, diffAvailable: true, snapshot: true, segments: 1, editIds: ['t1'] }
  reset({ changes: [] })
  replies.getChanges = () => [row]
  await st().refreshChanges('h1')
  ok(cur().changes.length === 1 && cur().changes[0].added === 3, 'store: refreshChanges mirrors main')
  replies.getChanges = () => null
  await st().refreshChanges('h1')
  ok(cur().changes.length === 1, 'store: a null reply keeps the last summaries')
  delete replies.getChanges
}

// Git decoration mirrors main by path; a reply older than the handle's latest request is dropped.
{
  reset()
  useSession.setState({ gitStatus: {} })
  const release: Array<() => void> = []
  const replyWith = (x: string) => () => new Promise((r) => release.push(() => r({ '/w/a.ts': { state: 'changed', x, y: '.' } })))
  replies.getChangeGitStatus = replyWith('A')
  const older = st().refreshGitStatus('h1')
  replies.getChangeGitStatus = replyWith('M')
  const newer = st().refreshGitStatus('h1')
  release[1]()
  await newer
  release[0]()
  await older
  equal((st().gitStatus['/w/a.ts'] as any)?.x, 'M', 'git: a stale reply cannot overwrite the newer one')
  const before = st().gitStatus
  replies.getChangeGitStatus = () => ({ '/w/a.ts': { state: 'changed', x: 'M', y: '.' } })
  await st().refreshGitStatus('h1')
  ok(st().gitStatus === before, 'git: an unchanged poll leaves state alone')
  replies.getChangeGitStatus = () => ({ '/w/a.ts': { state: 'unlisted' } })
  useSession.setState({ sessions: {} })
  await st().refreshGitStatus('h1')
  equal((st().gitStatus['/w/a.ts'] as any)?.x, 'M', 'git: a reply for a closed session is dropped')
  delete replies.getChangeGitStatus
}

// Restore seeds the slice; the tab cap evicts the least recently viewed eligible tab before an open.
{
  const ftab = (n: number, viewed: number): any => ({ id: `file:/w/${n}.ts`, kind: 'file', key: `/w/${n}.ts`, title: `${n}.ts`, openedBy: 'user', openedAt: 1, lastViewedAt: viewed })
  const singles: any = {
    tree: { id: 'tree', kind: 'tree', key: '', title: 'w', openedBy: 'user', openedAt: 1, lastViewedAt: 0 },
    diff: { id: 'diff', kind: 'diff', key: '', title: 'Claude changes', openedBy: 'user', openedAt: 1, lastViewedAt: 0 }
  }
  const saved = (browserTabs: any): any => ({
    status: 'ok',
    entry: {
      set: { order: ['browser:3', 'tree', 'file:/w/1.ts', 'browser:5'], active: 'browser:5', tabs: { tree: singles.tree, 'file:/w/1.ts': ftab(1, 9) } },
      browserTabs,
      open: true,
      full: true
    }
  })
  const b = { tabs: [{ id: 3, url: 'https://a.test/', lastViewedAt: 7 }, { id: 5, url: 'about:blank', lastViewedAt: 8 }], nextId: 6, viewed: 5 }
  const on = restoredPane(saved(b), true)
  ok(on.surfaces.order.join() === 'browser:3,tree,file:/w/1.ts,browser:5' && on.surfaces.active === 'browser:5' && on.paneOpen && on.surfacePaneFull, 'restore: order, active and pane intent come back')
  ok(on.browser?.tabs.map((t) => `${t.id}:${t.url}`).join() === '3:https://a.test/,5:about:blank' && on.browser.viewed === 5 && on.browser.multi && !on.browser.enter.length, 'restore: browser tabs keep their ids and addresses, and none fades in')
  ok(on.surfaces.browserLastViewedAt['browser:3'] === 7, 'restore: browser last-viewed times come from the records')
  const off = restoredPane(saved(null), false)
  ok(off.browser === null && off.surfaces.order.join() === 'tree,file:/w/1.ts' && off.surfaces.active === 'file:/w/1.ts', 'restore: without browser access placements drop out and the active one hands over')
  const newer = restoredPane({ status: 'newer' }, true)
  ok(newer.restoreNote === 'newer' && !newer.surfaces.order.length && !newer.browser?.tabs.length && !newer.paneOpen, 'restore: a newer sidecar opens like a new session, noted for the picker')
  const fresh0 = restoredPane({ status: 'none' }, true)
  ok(fresh0.browser?.tabs.length === 0 && fresh0.browser.viewed === 1 && !fresh0.surfaces.order.length && fresh0.surfaces.active === null, 'restore: a new browser session starts with no tab')
  const none = restoredPane(saved({ tabs: [], nextId: 1, viewed: 1 }), true)
  ok(none.browser?.tabs.length === 0 && none.surfaces.order.join() === 'tree,file:/w/1.ts' && none.surfaces.active === 'file:/w/1.ts', 'restore: a session saved with no browser tab drops its stale placements')
  const old = saved({ tabs: [{ id: 1, url: 'about:blank', lastViewedAt: 0 }], nextId: 2, viewed: 1 })
  const seeded = restoredPane({ ...old, entry: { ...old.entry, set: { order: ['browser:1'], active: 'browser:1', tabs: {} } } }, true)
  ok(seeded.browser?.tabs.length === 1 && seeded.surfaces.order.join() === 'browser:1' && seeded.surfaces.active === 'browser:1', "restore: an older sidecar's blank seeded tab loads as a real tab")

  // The note goes with the first tab and doesn't come back.
  const empty = { order: [], active: null, tabs: {}, browserLastViewedAt: {}, browserUnseen: {} }
  reset({ browser: null, surfaces: empty, restoreNote: 'corrupt', paneOpen: true, paneAutoOpen: false, paneAutoOpenSuppressed: false, surfacePaneFull: false, statusAnnounce: '', annotate: { tab: null, note: null }, tabsEvicted: false })
  useSession.setState({ stageWide: true, viewingSubagent: null, subagentTrail: [], settingsSection: null, evictedTabs: [] })
  st().openSurface('h1', { kind: 'diff', key: '', title: 'Claude changes' }, 'open', 'user', 'user')
  st().closeSurface('h1', 'diff')
  ok(cur().restoreNote === null, "restore: the picker's note is gone once a tab opens")

  // Eviction picks the least recently viewed inactive file; tree, diff and the active tab stay.
  const full = (): any => {
    const tabs: any = { ...singles }
    for (let n = 0; n < 22; n++) tabs[`file:/w/${n}.ts`] = ftab(n, 100 + n)
    tabs['file:/w/0.ts'].lastViewedAt = 1
    return { ...empty, order: Object.keys(tabs), active: 'file:/w/0.ts', tabs }
  }
  equal(evictionVictim(full(), 'file:/w/new.ts'), 'file:/w/1.ts', 'evict: the active tab is skipped even when it is the oldest')
  equal(evictionVictim({ ...full(), tabs: { ...singles } }, 'x'), null, 'evict: under the cap nothing goes')
  reset({ browser: null, surfaces: full(), paneOpen: true, paneAutoOpen: false, paneAutoOpenSuppressed: false, surfacePaneFull: false, statusAnnounce: '', annotate: { tab: null, note: null }, tabsEvicted: false, restoreNote: null })
  st().setSurfaceView('h1', 'file:/w/1.ts', { viewState: { kind: 'file', topLine: 77, offsetPx: 0, scrollLeft: 0, previewScrollTop: 0 } })
  st().openSurface('h1', { kind: 'file', key: '/w/new.ts', title: 'new.ts' }, 'open', 'user', 'user')
  const sur = (): any => cur().surfaces
  ok(Object.keys(sur().tabs).length === 24 && !sur().tabs['file:/w/1.ts'] && sur().active === 'file:/w/new.ts', 'evict: opening a 25th tab closes the oldest eligible one first')
  const card = st().evictedTabs[0]
  ok(card?.tab.id === 'file:/w/1.ts' && card.index === 3 && st().evictedAnnounce.text.startsWith('Closed 1.ts. Clui keeps up to 24 tabs'), 'evict: the first eviction gets a card and its announcement')
  st().openSurface('h1', { kind: 'file', key: '/w/new2.ts', title: 'new2.ts' }, 'open', 'user', 'user')
  ok(st().evictedTabs.length === 1 && !cur().surfaces.tabs['file:/w/0.ts'] && cur().statusAnnounce.startsWith('Closed 0.ts to stay under 24 tabs.'), 'evict: a later one is only announced, and the once-active tab is eligible again')
  st().reopenEvicted(card.id)
  ok(sur().order[3] === 'file:/w/1.ts' && sur().active === 'file:/w/1.ts' && sur().tabs['file:/w/1.ts'].viewState.topLine === 77, 'evict: Reopen puts the tab back at its index with its view state')
  ok(Object.keys(sur().tabs).length === 24 && !sur().tabs['file:/w/2.ts'] && !st().evictedTabs.length, 'evict: Reopen makes room by evicting the next one quietly')
  useSession.setState({ evictedTabs: [card, { ...card, id: 'evicted-other' }] })
  expireEvicted(card.id)
  ok(st().evictedTabs.map((c) => c.id).join() === 'evicted-other', 'evict: an expired card drops only itself')
}

// References: one staged list per target, mirrored to main's outlines and watches, removed only by staleness or the user.
{
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  const V = `sha256:${'a'.repeat(32)}`
  const V2 = `sha256:${'b'.repeat(32)}`
  const DOC = 'A'.repeat(32)
  const target = { tag: 'button', role: 'button', name: 'Sign in', text: 'Sign in', selector: '#s', bbox: { x: 0, y: 0, width: 1, height: 1 }, styles: {}, html: '', url: 'http://localhost:5173/' }
  const pin = (sel = '#s'): any => ({ kind: 'browser', pin: { source: { kind: 'browser', tabId: 1, docId: DOC }, target: { ...target, selector: sel } } })
  const lines = (start = 1, end = 2, v = V, note?: string): any => ({ kind: 'file', path: '/tmp/w/a.ts', lines: { start, end }, sourceVersion: v, ...(note ? { note } : {}) })
  const orders = (): any[] => calls.filter((c) => c.name === 'syncAnnotationOrder').map((c) => c.args[1])

  reset({ busy: false })
  const a = st().addRef('h1', lines())
  const b = st().addRef('h1', lines())
  ok(a.status === 'added' && b.status === 'duplicate' && (b as any).id === (a as any).id, 'refs: the same refKey returns the existing id')
  ok(st().addRef('h1', { kind: 'file', path: 'rel.ts' } as any).status === 'invalid', 'refs: a relative path is refused')
  for (let i = 3; i <= 21; i++) st().addRef('h1', lines(i, i))
  ok(cur().contextRefs.length === 20 && st().addRef('h1', lines(40, 40)).status === 'cap', 'refs: 20 per target, the 21st refused')

  // Change text per message is capped at attach, so Claude can always read all of it in one window.
  reset({ busy: false })
  const chg = (n: number): any => ({ kind: 'change', changeRef: `chg_${n.toString(16).padStart(32, '0')}`, path: '/tmp/w/a.ts', side: 'diff', new: { start: 1, end: 1 } })
  ok(st().addRef('h1', chg(1)).status === 'invalid', 'refs: a change ref without its mint size is refused')
  ok([1, 2, 3, 4].every((n) => st().addRef('h1', chg(n), { bytes: 32 * 1024 }).status === 'added'), 'refs: 128 KiB of change text attaches')
  ok(st().addRef('h1', chg(5), { bytes: 1 }).status === 'budget' && cur().contextRefs.length === 4, 'refs: one byte more is refused as budget')
  ok(st().addRef('h1', lines()).status === 'added', 'refs: a file ref still attaches past it')
  ok(cur().contextRefs[0].bytes === 32 * 1024 && cur().contextRefs[4].bytes === undefined, 'refs: the size rides only on change refs')

  // Change refs leave as a set: one notice per reason however many files they came from, announced once.
  reset({ busy: false })
  st().addRef('h1', chg(1), { bytes: 10 })
  st().addRef('h1', { ...chg(2), path: '/tmp/w/b.ts', side: 'before', old: { start: 40, end: 45 }, new: undefined }, { bytes: 10 })
  st().addRef('h1', lines())
  useSession.setState((s: any) => ({ sessions: { h1: { ...s.sessions.h1, queuedMessages: [{ id: 'q1', text: 'later', refs: [{ ref: { ...chg(3), id: 'r90' }, bytes: 5 }] }] } } }))
  ok(st().invalidateSource('h1', `change:${chg(1).changeRef}`, { reason: 'denied' }) === 0, 'change: one ref is never invalidated alone')
  equal(st().invalidateSource('h1', CHANGE_REFS, { reason: 'changed' }), 0, 'change: a file change never touches them')
  equal(st().invalidateSource('h1', CHANGE_REFS, { reason: 'denied' }), 3, 'change: losing change_read removes every change ref, draft and queue')
  ok(cur().contextRefs.length === 1 && cur().contextRefs[0].ref.kind === 'file', 'change: other refs stay')
  equal(Object.keys(cur().referenceNotices).join(), 'change:denied', 'change: one notice, keyed by reason')
  equal(cur().referenceNotices['change:denied'].removed.map((r: any) => r.label).join('|'), 'a.ts · diff L1, added|b.ts · before L40–45', 'change: it lists both files')
  ok(cur().refAnnounce.startsWith("Claude can't read changes in this session. 2 changes were removed from the message."), 'change: announced once for the draft')
  ok(cur().queuedMessages[0].refs.length === 0 && cur().queuedMessages[0].needsReview?.[0].resourceId === 'change:denied', 'change: the queued message pauses under the same key')

  // A draft carried to another session leaves its change refs behind: their grants stayed with the old one.
  reset({ busy: false })
  const asked: unknown[] = []
  replies.validateRefs = (_h: unknown, refs: unknown) => (asked.push(refs), [])
  await st().carryRefs('h1', [{ ref: { ...chg(4), id: 'r91' }, bytes: 5 }, { ref: { ...lines(), id: 'r92' } }])
  ok(cur().contextRefs.length === 1 && cur().contextRefs[0].ref.kind === 'file', 'carry: the file ref moves, the change ref does not')
  ok(!JSON.stringify(asked).includes('chg_'), 'carry: a change ref is never asked of the new session')
  equal(cur().referenceNotices['change:session']?.removed[0].label, 'a.ts · diff L1, added', 'carry: it becomes a session notice')
  delete replies.validateRefs
  // The carried file's watch would otherwise count as already synced below.
  st().removeRef('h1', cur().contextRefs[0].ref.id)
  await tick()

  reset({ busy: false })
  st().addRef('h1', pin('#a'), { pinId: 7 })
  st().addRef('h1', lines())
  st().addRef('h1', pin('#b'), { pinId: 8 })
  await tick()
  ok(orders().length === 1 && JSON.stringify(orders()[0].shown) === '[[7,1],[8,3]]' && orders()[0].room === 17, 'refs: outline numbers are chip positions across kinds, synced once per tick')
  ok(calls.some((c) => c.name === 'syncRefWatches' && (c.args[1] as any[]).length === 1 && (c.args[1] as any[])[0].version === V), 'refs: the selection is watched')
  st().moveRef('h1', cur().contextRefs[2].ref.id, -1)
  await tick()
  ok(JSON.stringify(orders().at(-1).shown) === '[[7,1],[8,2]]', 'refs: moveRef renumbers the outlines')
  st().removeRef('h1', cur().contextRefs[0].ref.id)
  await tick()
  ok(JSON.stringify(orders().at(-1).keep) === '[8]' && JSON.stringify(orders().at(-1).shown) === '[[8,1]]', 'refs: removeRef drops the pin')

  // A note is the user's text on one reference: stored as typed, capped, deleted when empty, order untouched.
  reset({ busy: false })
  st().addRef('h1', lines(1, 1))
  st().addRef('h1', lines(2, 2))
  const [n1, n2] = cur().contextRefs.map((d: any) => d.ref.id)
  st().setRefNote('h1', n2, ' retry twice ', null)
  equal(cur().contextRefs[1].ref.note, ' retry twice ', 'note: stored as typed')
  ok(cur().contextRefs[0].ref.note === undefined && cur().contextRefs[0].ref.id === n1, 'note: other refs and order untouched')
  st().setRefNote('h1', n2, 'x'.repeat(2100), null)
  equal(cur().contextRefs[1].ref.note.length, 2000, 'note: capped at REF_NOTE_MAX')
  st().setRefNote('h1', n2, '', null)
  ok(!('note' in cur().contextRefs[1].ref), 'note: an empty note is deleted, never ""')
  useSession.setState((s: any) => ({ sessions: { h1: { ...s.sessions.h1, queuedMessages: [{ id: 'q1', text: 'later', refs: [{ ref: { ...lines(3, 3), id: 'r95' } }] }] } } }))
  st().setRefNote('h1', 'r95', 'queued', 'q1')
  ok(cur().queuedMessages[0].refs[0].ref.note === 'queued' && cur().contextRefs.every((d: any) => d.ref.note === undefined), 'note: lands on its target only')

  // Submit consumes the draft by id and the queued item keeps the pins: no sync drops them in between.
  reset({ busy: true })
  st().addRef('h1', pin('#a'), { pinId: 7 })
  await tick()
  calls.length = 0
  const refs = cur().contextRefs
  st().clearRefs('h1', refs.map((d: any) => d.ref.id))
  await st().sendMessage('later', undefined, { refs })
  await tick()
  ok(cur().queuedMessages[0]?.text === 'later' && cur().queuedMessages[0].refs.length === 1 && !cur().contextRefs.length, 'queue: typed text and structured refs, nothing serialized')
  ok(!orders().some((o) => !o.keep.includes(7)), 'queue: the pin survives the move from draft to queue')

  // A pick the store refuses has its outline taken down.
  reset({ busy: false })
  for (let i = 1; i <= 20; i++) st().addRef('h1', lines(i, i))
  await tick()
  calls.length = 0
  st().applyAnnotateEvent('h1', { type: 'pinned', pinId: 9, pin: pin().pin, crop: null })
  await tick()
  ok(cur().contextRefs.length === 20 && orders().length === 1 && !orders()[0].keep.includes(9), 'pinned at cap: not added, and the forced sync drops the outline')
  ok(cur().annotate.note === '20 references max. Remove one to add another.', 'pinned at cap: the strip says why')

  // A document gone: draft and queued pins on that tab leave, with a notice and a paused row.
  reset({ busy: true, queuedMessages: [{ id: 'q1', text: 'later', refs: [{ ref: { ...pin('#q'), id: 'r900' }, pinId: 3 }] }] })
  st().addRef('h1', pin('#a'), { pinId: 4 })
  st().addRef('h1', { kind: 'file', path: '/tmp/w/b.ts' })
  st().applyAnnotateEvent('h1', { type: 'gone', tab: 1, reason: 'navigated' })
  const key = `browser:1:${DOC}`
  ok(cur().contextRefs.length === 1 && cur().contextRefs[0].ref.kind === 'file', 'gone: page refs leave the draft, the file stays')
  ok(cur().referenceNotices[key]?.label === 'localhost:5173' && cur().referenceNotices[key].removed[0].label === 'button "Sign in"', 'gone: the notice names the host and the element')
  ok(!cur().queuedMessages[0].refs.length && cur().queuedMessages[0].needsReview?.[0].reason === 'navigated', 'gone: the queued copy pauses')
  st().sendQueuedNow('q1')
  ok(cur().queuedMessages.length === 1, 'queue: Send now refuses a paused item')
  calls.length = 0
  st().applyEvent('h1', res())
  ok(cur().queuedMessages.length === 1 && !calls.some((c) => c.name === 'sendMessage'), 'queue: a paused head is not released at a result')
  st().addRef('h1', { ...pin('#a'), pin: { ...pin('#a').pin, source: { kind: 'browser', tabId: 1, docId: 'B'.repeat(32) } } })
  ok(!cur().referenceNotices[key], 'gone: a pick in the same tab clears the notice')
  replies.validateRefs = () => []
  ok(await st().acceptReview('h1', 'q1'), 'review: no failures passes')
  ok(cur().queuedMessages.length === 0 && calls.some((c) => c.name === 'sendMessage' && (c.args[1] as any).text === 'later'), 'review: an idle head sends at once')
  delete replies.validateRefs

  // A file changed: a same-size replacement is a new version, so the selection goes and the whole file stays.
  const tab = { id: 'file:/tmp/w/a.ts', kind: 'file', key: '/tmp/w/a.ts', title: 'a.ts', openedBy: 'user', openedAt: 0, lastViewedAt: 0, selection: { lines: { start: 1, end: 2 } } }
  const sent = { id: 'u0', role: 'user', text: 'sent before', thinking: '', tools: [], blocks: [] }
  reset({ busy: false, messages: [sent], surfaces: { order: [tab.id], active: tab.id, tabs: { [tab.id]: tab }, browserLastViewedAt: {}, browserUnseen: {} } })
  st().addRef('h1', lines(1, 2, V, 'check the retry'))
  st().addRef('h1', { kind: 'file', path: '/tmp/w/a.ts' })
  ok(st().invalidateSource('h1', 'file:/tmp/w/a.ts', { reason: 'changed', version: V }) === 0, 'stale: the same version removes nothing')
  ok(st().invalidateSource('h1', 'file:/tmp/w/a.ts', { reason: 'changed', version: V2 }) === 1, 'stale: a new version removes the selection')
  ok(cur().contextRefs.length === 1 && !cur().contextRefs[0].ref.lines, 'stale: the whole-file ref stays')
  ok(cur().surfaces.tabs[tab.id].selection === undefined, "stale: the File tab's selection clears")
  ok(cur().messages[0] === sent, 'stale: sent bubbles are untouched')
  const n = cur().referenceNotices['file:/tmp/w/a.ts']
  ok(n?.label === 'a.ts' && n.removed[0].label === 'L1–2' && n.removed[0].note === 'check the retry', 'stale: the notice keeps the range and the note')
  ok(cur().refAnnounce.startsWith('a.ts changed. Lines 1 to 2 were removed from the message.'), 'stale: announced once')
  st().addRef('h1', lines(3, 4, V2))
  ok(!cur().referenceNotices['file:/tmp/w/a.ts'] && cur().contextRefs.at(-1).ref.note === 'check the retry', 'stale: reselection clears the notice and brings the note back')

  // Dispatch: a stale reply sends nothing, and the message waits at the queue head.
  reset({ busy: false })
  st().addRef('h1', lines())
  const out = cur().contextRefs
  let answer!: (v: unknown) => void
  replies.sendMessage = () => new Promise((r) => (answer = r))
  st().clearRefs('h1', out.map((d: any) => d.ref.id))
  const p = st().sendMessage('explain', undefined, { refs: out })
  ok(cur().busy && cur().messages.at(-1).text.startsWith('<clui-context version="1">\n'), 'dispatch: the optimistic bubble carries the block without a packetId')
  st().addRef('h1', lines(5, 6))
  answer({ ok: false, reason: 'stale', invalid: [{ id: out[0].ref.id, reason: 'changed' }] })
  await p
  ok(!cur().busy && !cur().messages.length, 'dispatch: stale removes the bubble and rolls back busy')
  ok(cur().queuedMessages[0]?.text === 'explain' && cur().queuedMessages[0].needsReview?.[0].reason === 'changed' && !cur().queuedMessages[0].refs.length, 'dispatch: the message waits at the head, paused')
  ok(cur().contextRefs.length === 1 && cur().contextRefs[0].ref.lines.start === 5, 'dispatch: a ref added during the await stays in the draft')
  replies.sendMessage = () => ({ ok: true, packetId: 'x', text: 'ACCEPTED', joined: false })
  reset({ busy: false })
  await st().sendMessage('hi')
  ok(cur().messages.at(-1)?.text === 'ACCEPTED', "dispatch: the bubble takes main's accepted text")
  delete replies.sendMessage
}
