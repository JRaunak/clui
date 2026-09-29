// Boundary: the per-turn usage delta. The CLI reports modelUsage cumulatively, so the trailer
// must subtract the prior envelope to show one turn's own cost/tokens (not the running total).
import { perTurnUsage, useSession } from '../src/renderer/src/store.ts'
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

// The store's IPC is stubbed: each call is recorded and resolves true.
const calls: { name: string; args: unknown[] }[] = []
;(globalThis as any).window = {
  clui: new Proxy({}, { get: (_t, name: string) => async (...args: unknown[]) => (calls.push({ name, args }), true) })
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
