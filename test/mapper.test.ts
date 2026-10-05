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

// system/api_retry → a foreground api-retry; a subagent's or bg turn's retry maps to nothing
{
  const retry = { type: 'system', subtype: 'api_retry', attempt: 3, max_retries: 10, retry_delay_ms: 11200, error_status: 403 }
  const evs = new EventMapper().map(retry) as any[]
  ok(
    evs.length === 1 &&
      JSON.stringify(evs[0]) === JSON.stringify({ type: 'api-retry', attempt: 3, maxRetries: 10, delayMs: 11200, status: 403 }),
    'mapper: api_retry → api-retry'
  )
  ok((new EventMapper().map({ ...retry, error_status: null }) as any[])[0]?.status === null, 'mapper: api_retry without HTTP status → null')
  ok(new EventMapper().map({ ...retry, parent_tool_use_id: 't1' }).length === 0, 'mapper: subagent api_retry → none')
  ok(new EventMapper().map({ ...retry, origin: { kind: 'task-notification' } }).length === 0, 'mapper: bg-turn api_retry → none')
}

// The live Sonnet 5.5 403 (CLI 2.1.284 tags it remedy:refresh_command) reads as model access
{
  const { readFileSync } = await import('node:fs')
  const envs = readFileSync(new URL('./fixtures/sonnet55-403.jsonl', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  const m = new EventMapper()
  m.map({ type: 'system', subtype: 'init', model: 'global.anthropic.claude-sonnet-5-5', session_id: 's' })
  const evs = feed(m, envs)
  const errors = evs.filter((e) => e.type === 'error')
  ok(evs.filter((e) => e.type === 'api-retry').length === 10, 'mapper: fixture yields ten api-retry events')
  ok(!evs.some((e) => e.type === 'text-delta'), 'mapper: a classified API error never renders its raw text')
  ok(
    errors.length === 1 && errors[0].message.startsWith("Sonnet 5.5 isn't enabled on your AWS account"),
    'mapper: the Sonnet 5.5 403 is a model-access error'
  )
  ok(!errors.some((e) => /authentication failed|claude_aws_auth_local|credentials/i.test(e.message)), 'mapper: model-access copy never names the refresh path')
  const unnamed = new EventMapper()
  const e2 = feed(unnamed, envs).find((e) => e.type === 'error')
  ok(e2?.message.startsWith("This model isn't enabled"), 'mapper: model-access copy without a known model')
}

// A switched model is the one named; the next turn starts clean
{
  const m = new EventMapper()
  m.map({ type: 'system', subtype: 'init', model: 'claude-opus-5-5[1m]', session_id: 's' })
  m.setModel('global.anthropic.claude-sonnet-5-5')
  const evs = feed(m, [
    {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'AWS authentication failed · run `x` and retry · API Error: 403 Your AWS Marketplace subscription failed.' }] },
      is_api_error_message: true,
      api_error_status: 403,
      api_error: 'provider_credentials',
      api_error_params: { provider: 'bedrock', remedy: 'refresh_command' }
    },
    { type: 'result', is_error: true, api_error_status: 403, result: 'x', session_id: 's' },
    { type: 'result', is_error: true, result: 'API Error 500', session_id: 's' }
  ])
  const errors = evs.filter((e) => e.type === 'error')
  ok(errors[0]?.message.startsWith('Sonnet 5.5 '), 'mapper: setModel names the switched model')
  ok(errors[1]?.message === 'API Error 500', 'mapper: the API error does not leak into the next turn')
}

// An IAM explicit deny on one model (shape captured live on 2.1.289, identifiers replaced) is model access, not an expired sign-in.
{
  const text =
    'AWS authentication failed · run `claude_aws_auth_local` and retry · if credentials are current, check AWS permissions and model access · API Error: 403 {"Message":"User: arn:aws:sts::123456789012:assumed-role/example-role/user@example.com is not authorized to perform: bedrock:InvokeModelWithResponseStream on resource: arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-fable-5-1 with an explicit deny in an identity-based policy"}'
  const m = new EventMapper()
  m.map({ type: 'system', subtype: 'init', model: 'us.anthropic.claude-fable-5-1', session_id: 's' })
  const errors = feed(m, [
    { type: 'assistant', message: { content: [{ type: 'text', text }] }, is_api_error_message: true, api_error_status: 403, api_error: 'provider_credentials', api_error_params: { provider: 'bedrock', remedy: 'refresh_command' } },
    { type: 'result', is_error: true, api_error_status: 403, result: text, session_id: 's' }
  ]).filter((e) => e.type === 'error')
  ok(errors.length === 1 && errors[0].message.startsWith("Fable 5.1 isn't enabled on your AWS account"), 'mapper: an IAM explicit deny is a model-access error')
}

// remedy:refresh_command without model-access text → the sign-in copy with the CLI's command.
// The CLI's own template says "check AWS permissions and model access", which must not count.
{
  const text =
    'AWS authentication failed · run `claude_aws_auth_local` and retry · if credentials are current, check AWS permissions and model access · API Error: 403 The security token included in the request is expired'
  for (const status of [401, 403]) {
    const evs = feed(new EventMapper(), [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text }] },
        is_api_error_message: true,
        api_error_status: status,
        api_error: 'provider_credentials',
        api_error_params: { provider: 'bedrock', remedy: 'refresh_command' }
      },
      { type: 'result', is_error: true, api_error_status: status, result: text, session_id: 's' }
    ])
    const errors = evs.filter((e) => e.type === 'error')
    ok(
      errors.length === 1 &&
        errors[0].message === 'Your AWS sign-in has expired. Run claude_aws_auth_local in a terminal, then send your message again.',
      `mapper: ${status} refresh_command → sign-in copy`
    )
  }
  const noCmd = feed(new EventMapper(), [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'expired' }] }, is_api_error_message: true, api_error_params: { remedy: 'refresh_command' } },
    { type: 'result', is_error: true, result: 'expired', session_id: 's' }
  ]).find((e) => e.type === 'error')
  ok(noCmd?.message.includes('Run your AWS sign-in command in a terminal'), 'mapper: sign-in copy without a known command')
}

// remedy:model_access classifies on its own
{
  const err = feed(new EventMapper(), [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'denied' }] }, is_api_error_message: true, api_error_status: 400, api_error_params: { remedy: 'model_access' } },
    { type: 'result', is_error: true, result: 'denied', session_id: 's' }
  ]).find((e) => e.type === 'error')
  ok(err?.message.startsWith("This model isn't enabled"), 'mapper: remedy model_access → model-access copy')
}

// An unclassified API error maps exactly as the same envelopes without the api-error fields
{
  const assistant = { type: 'assistant', message: { content: [{ type: 'text', text: 'API Error: PDF too large' }] } }
  const result = { type: 'result', is_error: true, api_error_status: 400, result: 'API Error: PDF too large', session_id: 's' }
  const tagged = feed(new EventMapper(), [
    { ...assistant, is_api_error_message: true, api_error_status: 400, api_error: 'pdf_too_large', api_error_params: {} },
    result
  ])
  const plain = feed(new EventMapper(), [assistant, result])
  ok(JSON.stringify(tagged) === JSON.stringify(plain), 'mapper: unclassified API error output is unchanged')
}

// Copy carries no dash, en dash or ellipsis
{
  const copies = [
    "Sonnet 5.5 isn't enabled on your AWS account in this region. Switch to another model, or ask your AWS admin to enable it in Amazon Bedrock.",
    'Your AWS sign-in has expired. Run your AWS sign-in command in a terminal, then send your message again.'
  ]
  const m = new EventMapper()
  m.map({ type: 'system', subtype: 'init', model: 'global.anthropic.claude-sonnet-5-5', session_id: 's' })
  const got = feed(m, [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Marketplace' }] }, is_api_error_message: true, api_error_status: 403 },
    { type: 'result', is_error: true, result: 'x', session_id: 's' }
  ]).find((e) => e.type === 'error')
  ok(got?.message === copies[0], 'mapper: model-access copy is exact')
  ok(!copies.some((c) => /[–—…]/.test(c)), 'mapper: error copy has no dashes or ellipsis')
}
