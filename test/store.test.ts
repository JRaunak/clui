// Boundary: the per-turn usage delta. The CLI reports modelUsage cumulatively, so the trailer
// must subtract the prior envelope to show one turn's own cost/tokens (not the running total).
import { useSession, apiRetryCopy, effectiveMode, rateLimitCopy, chipMode, notePaneInput, paneTarget, PANE_RECENT_MS } from '../src/renderer/src/store.ts'
import { turnEndLine, wokenLine } from '../src/renderer/src/lib/turnEnd.ts'
import { perTurnUsage } from '../src/shared/events.ts'
import { equal, ok } from './support/harness.mjs'

const cum = (costUSD: number, out: number, cacheRead: number, cacheCreate: number) => ({
  costUSD,
  inputTokens: 3,
  outputTokens: out,
  cacheReadInputTokens: cacheRead,
  cacheCreationInputTokens: cacheCreate,
  thinkingTokens: 0,
  models: [{ model: 'claude-sonnet-4-6', provider: 'bedrock', costUSD }]
})

// Turn 1 off a zero baseline equals its own cumulative.
{
  const zero = cum(0, 0, 0, 0)
  const t1 = perTurnUsage(cum(0.0074, 4, 24310, 0), zero)
  equal(t1.costUSD, 0.0074, 'perTurn: turn 1 cost equals cumulative off zero baseline')
  equal(t1.outputTokens, 4, 'perTurn: turn 1 output equals cumulative')
  equal(t1.cacheReadInputTokens, 24310, 'perTurn: turn 1 cache read equals cumulative')
}

// Turn 2 is the marginal: cumulative doubled cache read must NOT show doubled.
{
  const prev = cum(0.0074, 4, 24310, 0)
  const t2 = perTurnUsage(cum(0.0155, 51, 48620, 12), prev)
  ok(Math.abs((t2.costUSD ?? 0) - 0.0081) < 1e-9, 'perTurn: turn 2 cost is the marginal, not cumulative')
  equal(t2.outputTokens, 47, 'perTurn: turn 2 output is the delta (51-4), not 51')
  equal(t2.cacheReadInputTokens, 24310, 'perTurn: turn 2 cache read is the delta, not the doubled 48620')
  equal(t2.cacheCreationInputTokens, 12, 'perTurn: turn 2 cache creation is the delta')
  equal(t2.models[0].costUSD, t2.costUSD, 'perTurn: per-model cost shares the headline scope')
}

// A transient lower report (effort respawn / pre-seed) floors at zero, never negative.
{
  const prev = cum(0.02, 100, 1000, 0)
  const t = perTurnUsage(cum(0.01, 50, 500, 0), prev)
  equal(t.costUSD, 0, 'perTurn: a lower cumulative floors at 0')
  equal(t.outputTokens, 0, 'perTurn: a lower token count floors at 0')
}

// The store's IPC is stubbed: each call is recorded and resolves true unless `replies` overrides it.
const calls: { name: string; args: unknown[] }[] = []
const replies: Record<string, (...args: any[]) => unknown> = {}
;(globalThis as any).window = {
  clui: new Proxy({}, { get: (_t, name: string) => async (...args: unknown[]) => (calls.push({ name, args }), replies[name] ? replies[name](...args) : true) })
}
const slice = (over: Record<string, unknown> = {}): any => ({
  handleId: 'h1',
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
  turnStartMs: null,
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
    annotate: { tab: null, pins: [], note: null },
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
    reset({ browser: null, surfaces: empty, paneOpen: false, paneAutoOpen: false, paneAutoOpenSuppressed: false, surfacePaneFull: false, statusAnnounce: '', annotate: { tab: null, pins: [], note: null }, ...over })
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
  useSession.setState({ sessions: { ...st().sessions, h2: slice({ handleId: 'h2', browser: null, surfaces: empty, paneOpen: false, annotate: { tab: null, pins: [], note: null } }) } })
  st().openSurface('h2', FILE, 'focus', 'claude', 'claude')
  ok(st().sessions.h2.surfaces.active === id && !st().sessions.h2.paneOpen && st().sessions.h2.paneAutoOpen, 'intent: a background session opens on its next visit')

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
  ok(!cur().paneOpen && sur().order.length === 0 && sur().active === null, 'placement: closing the last tab hides the pane')

  // Claude's closes are said from where the strip lands; emptying the pane goes through the status line.
  fresh({ browser: browserOf([1, 2]), surfaces: { ...empty, order: ['browser:1', 'browser:2'], active: 'browser:2' }, paneOpen: true })
  openDiff()
  st().activateSurface('h1', 'browser:2')
  st().applyBrowserEvent('h1', { type: 'tab-closed', tab: 2, by: 'agent', viewed: 1 })
  ok(cur().browser.announce.startsWith('Claude closed tab 2. Showing Claude changes'), 'announce: a close that lands on another kind names it')
  st().closeSurface('h1', 'diff')
  st().applyBrowserEvent('h1', { type: 'tab-closed', tab: 1, by: 'agent', viewed: 1 })
  ok(!cur().paneOpen && cur().statusAnnounce.startsWith('Claude closed tab 1. Browser hidden.'), 'announce: closing the last tab is said by the status line')

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
}

const res = (over: Record<string, unknown> = {}): any => ({ type: 'result', sessionId: 's', isError: false, result: null, ...over })
const q = (id: string, text: string): any => ({ id, text })

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
  ok(calls.some((c) => c.name === 'sendNowMessage' && c.args[1] === 'a'), 'store: Send now goes to sendNowMessage')
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
  const row = { path: '/w/a.ts', added: 3, removed: 1, created: false, missingOnDisk: false, approximate: false, diffAvailable: true, segments: 1, editIds: ['t1'] }
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
