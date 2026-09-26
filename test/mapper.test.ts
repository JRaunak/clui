// Boundary: the wire→DomainEvent mapper.
import { EventMapper } from '../src/main/cli/event-mapper.ts'
import { ok } from './support/harness.mjs'

const feed = (m: EventMapper, envs: unknown[]): any[] => envs.flatMap((e) => m.map(e))

// failure after progress text surfaces; already-shown error de-dups
{
  const m = new EventMapper()
  const evs = feed(m, [
    { type: 'stream_event', event: { type: 'message_start' } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'working…' } } },
    { type: 'result', is_error: true, result: 'API Error 500', session_id: 's' }
  ])
  ok(evs.some((e) => e.type === 'error'), 'mapper: failure after progress surfaces an error')
  const m2 = new EventMapper()
  const evs2 = feed(m2, [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'API Error: no response' }] } },
    { type: 'result', is_error: true, result: 'API Error: no response', session_id: 's' }
  ])
  ok(!evs2.some((e) => e.type === 'error'), 'mapper: error already shown as text is not duplicated')
}

// a background result does not consume the foreground interrupt
{
  const m = new EventMapper()
  m.markInterrupted()
  const bg = feed(m, [{ type: 'result', is_error: true, result: 'bg', origin: { kind: 'task-notification' }, session_id: 's' }])
  ok(!bg.some((e) => e.type === 'error'), 'mapper: bg result does not red-banner')
  const fg = feed(m, [{ type: 'result', is_error: true, result: 'x', session_id: 's' }])
  ok(!fg.some((e) => e.type === 'error'), 'mapper: interrupt still suppresses the foreground result')
}

// malformed shapes never throw
{
  const m = new EventMapper()
  ok(m.map(null).length === 0, 'mapper: null → []')
  ok(m.map({ type: 'assistant', message: { content: 'text' } }).length === 0, 'mapper: string content → no throw')
  ok(
    m.map({ type: 'system', subtype: 'background_tasks_changed', tasks: {} }).some((e) => e.type === 'bg-tasks-changed'),
    'mapper: non-array tasks → no throw'
  )
}

// usage dedup on the full tuple, not rounded percent
{
  const m = new EventMapper()
  const a = feed(m, [{ type: 'assistant', message: { content: [], usage: { input_tokens: 20000 } } }])
  const b = feed(m, [{ type: 'assistant', message: { content: [], usage: { input_tokens: 20001 } } }])
  ok(a.some((e) => e.type === 'context-usage'), 'mapper: first usage emitted')
  ok(b.some((e) => e.type === 'context-usage' && e.usedTokens === 20001), 'mapper: different tokens at same % not deduped')
  const c = feed(m, [{ type: 'assistant', message: { content: [], usage: { input_tokens: 20001 } } }])
  ok(!c.some((e) => e.type === 'context-usage'), 'mapper: identical tuple deduped')
}

// 'stopped' is terminal
{
  const m = new EventMapper()
  feed(m, [{ type: 'system', subtype: 'task_started', task_id: 't1', task_type: 'local_bash', description: 'x' }])
  feed(m, [{ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'stopped' }])
  const changed = m.map({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1', task_type: 'local_bash' }] })
  const ids = (changed.find((e) => e.type === 'bg-tasks-changed') as any)?.taskIds ?? []
  ok(!ids.includes('t1'), "mapper: 'stopped' task removed from tracked set")
}

// can_use_tool decision reason fields are forwarded
{
  const m = new EventMapper()
  const [e] = m.map({
    type: 'control_request',
    request_id: 'r1',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command: 'rm -rf "$(echo x)"' },
      decision_reason: 'Dangerous rm operation',
      decision_reason_type: 'safetyCheck',
      blocked_path: '/tmp/x'
    }
  }) as any[]
  ok(
    e?.decisionReason === 'Dangerous rm operation' && e.decisionReasonType === 'safetyCheck' && e.blockedPath === '/tmp/x',
    'mapper: permission decision reason forwarded'
  )
}

// thinking_tokens heartbeats are throttled to one per 500ms
{
  const m = new EventMapper()
  const beat = (n: number): unknown => ({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: n, estimated_tokens_delta: 5 })
  const evs = feed(m, [beat(10), beat(20), beat(30)])
  const t = evs.filter((e) => e.type === 'thinking-tokens')
  ok(t.length === 1 && t[0].estimated === 10, 'mapper: thinking_tokens throttled')
}

// compaction: status → running/done, boundary → marker + context drop
{
  const m = new EventMapper()
  const running = m.map({ type: 'system', subtype: 'status', status: 'compacting' }) as any[]
  const done = m.map({ type: 'system', subtype: 'status', status: null, compact_result: 'success' }) as any[]
  const boundary = m.map({
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'manual', pre_tokens: 24266, post_tokens: 5087 }
  }) as any[]
  ok(running[0]?.type === 'compact-status' && running[0].state === 'running', 'mapper: compacting status')
  ok(done[0]?.state === 'done', 'mapper: compact_result success → done')
  ok(
    boundary.some((e) => e.type === 'compact-boundary' && e.preTokens === 24266 && e.postTokens === 5087) &&
      boundary.some((e) => e.type === 'context-usage' && e.usedTokens === 5087),
    'mapper: compact_boundary → marker + context drop'
  )
}
