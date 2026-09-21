// Boundary: the per-turn usage delta. The CLI reports modelUsage cumulatively, so the trailer
// must subtract the prior envelope to show one turn's own cost/tokens (not the running total).
import { perTurnUsage } from '../src/renderer/src/store.ts'
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
