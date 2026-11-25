// Boundary: the row-state grammar, tiers, a run's fold plan and sentence, "needs you" matching, and the
// current-turn derivation that the top-band header renders.
import { monitorRowState, rowState, needsYouToolIdOf, turnNumberOf, currentTurnAt, browserLabel, summarizeInput } from '../src/renderer/src/lib/instrument.ts'
import { formatCost } from '../src/renderer/src/lib/formatCost.ts'
import { equal } from './support/harness.mjs'

const tool = (o: Record<string, unknown>) => ({ id: 't', name: 'Bash', input: {}, ...o }) as never
const msg = (id: string, role: 'user' | 'assistant' | 'peer', text = '', extra: Record<string, unknown> = {}) =>
  ({ id, role, text, thinking: '', tools: [], blocks: [], ...extra }) as never

equal(rowState(tool({}), false), 'running', 'row: unresolved foreground tool is running')
equal(rowState(tool({}), true), 'needs-you', 'row: a pending permission wins over running')
equal(rowState(tool({ input: { run_in_background: true } }), false), 'launching', 'row: unresolved backgrounded tool is launching')
equal(rowState(tool({ name: 'Workflow', result: 'ok' }), false), 'launched', 'row: a finished Workflow reads launched')
equal(rowState(tool({ name: 'Agent', input: { run_in_background: true }, result: 'Launched' }), true), 'needs-you', 'row: a launched background agent at a gate needs you')
equal(rowState(tool({ name: 'Agent', input: { run_in_background: true }, result: 'Launched' }), false), 'launched', 'row: a launched background agent with no gate reads launched')
equal(rowState(tool({ name: 'Agent', result: 'ok' }), true), 'done', 'row: a finished foreground agent never reads needs you')

// One precision per displayed column: four decimals for all of it once any nonzero figure in it is under a cent.
equal(formatCost(0.0042), '$0.0042', 'cost: a lone sub-cent figure keeps four decimals')
equal(formatCost(0), '$0.00', 'cost: zero is two decimals')
equal(formatCost(0.05, [0.05, 0.0042]), '$0.0500', 'cost: a figure beside a sub-cent one takes four decimals')
equal(formatCost(1.27, [1.27, 0.5]), '$1.27', 'cost: a column with nothing under a cent stays at two')
equal(formatCost(1.27, [1.27, 0]), '$1.27', 'cost: a zero in the column is not under a cent')
equal(rowState(tool({ sentToBackground: true, result: 'ok' }), false), 'launched', 'row: sent-to-background reads launched')
equal(rowState(tool({ result: 'boom', isError: true }), false), 'failed', 'row: an error result is failed')
equal(rowState(tool({ result: 'ok' }), false), 'done', 'row: a plain result is done')


const slice = (messages: unknown[], pending: unknown[]) => ({ messages, pendingPermissions: pending }) as never
const asst = msg('a', 'assistant', '', { tools: [{ id: 'w1', name: 'Write', input: {}, result: 'ok' }, { id: 'w2', name: 'Write', input: {} }] })
equal(needsYouToolIdOf(slice([asst], [{ requestId: 'r', toolName: 'Write', input: {} }])), 'w2', 'needs-you: last unresolved same-name tool')
equal(needsYouToolIdOf(slice([asst], [])), null, 'needs-you: nothing pending')
equal(needsYouToolIdOf(slice([asst], [{ requestId: 'r', toolName: 'Bash', input: {} }])), null, 'needs-you: no name match')
equal(needsYouToolIdOf(null), null, 'needs-you: no slice')

const log = [msg('u1', 'user', 'first'), msg('a1', 'assistant'), msg('p1', 'peer', 'hi'), msg('u2', 'user', 'second\nline two'), msg('a2', 'assistant')]
equal(turnNumberOf(log, 4), 2, 'turn: two prompts up to index 4')
equal(turnNumberOf(log, 0), 1, 'turn: the first prompt is turn 1')
equal(currentTurnAt(log, 4)?.messageId, 'u2', 'current: reply row → its prompt')
equal(currentTurnAt(log, 4)?.turn, 2, 'current: carries the turn number')
equal(currentTurnAt(log, 4)?.text, 'second\nline two', 'current: preview keeps lines (the header shows line one)')
equal(currentTurnAt(log, 3), null, 'current: hidden while the prompt row itself is first visible')
equal(currentTurnAt([msg('a0', 'assistant')], 0), null, 'current: no prompt above')
equal(currentTurnAt([msg('u', 'user', '@"reviewer (agent)" check it'), msg('a', 'assistant')], 1)?.text, '@reviewer check it', 'current: agent mention tokens read as @name')
equal(currentTurnAt([msg('u', 'user', ''), msg('a', 'assistant')], 1)?.text, 'Attachments only', 'current: an attachment-only prompt still has a label')

const b = (tool: string) => `mcp__clui-browser__${tool}`
equal(browserLabel(b('press'), { keys: 'Enter' }), 'press Enter', 'browser label: one key by name')
equal(browserLabel(b('press'), { keys: [' '] }), 'press Space', 'browser label: space reads Space')
equal(browserLabel(b('press'), { keys: ['a', 'b', 'c', 'd', 'Enter'] }), 'press 5 keys', 'browser label: several keys by count')
equal(browserLabel(b('hover'), { ref: 12 }), 'hover 12', 'browser label: hover by an older numeric ref')
equal(browserLabel(b('click'), { ref: 't1:d0f3a9c2e:e12' }), 'click 12', 'browser label: click by its element number')
equal(browserLabel(b('click'), { ref: 't1:d0f3a9c2e:e12', button: 'right' }), 'right-click 12', 'browser label: a right-click says so')
equal(browserLabel(b('hover'), { x: 320, y: 180 }), 'hover 320, 180', 'browser label: hover by point')
equal(browserLabel(b('navigate'), { url: 'https://github.com' }, 2), 'navigate github.com · tab 2', 'browser label: names its tab')
equal(browserLabel(b('navigate'), { url: 'https://github.com' }, 0), 'navigate github.com', 'browser label: no tab, no suffix')

// Debug-tool rows: the label comes from the input, the count from the result's first line.
import { browserResultCopy } from '../src/renderer/src/lib/instrument.ts'
equal(browserLabel('mcp__clui-browser__console', { level: 'error' }), 'console errors', 'debug row: console errors label')
equal(browserLabel('mcp__clui-browser__network', { failedOnly: true }), 'network failed', 'debug row: network failed label')
equal(browserLabel('mcp__clui-browser__network_body', { id: 7 }), 'response 7', 'debug row: response label')
equal(JSON.stringify(browserResultCopy('summary!: 3 errors\nPage content…')), JSON.stringify({ copy: '3 errors', flagged: true }), 'debug row: flagged count parsed')
equal(JSON.stringify(browserResultCopy('summary: no requests')), JSON.stringify({ copy: 'no requests', flagged: false }), 'debug row: plain count parsed')
equal(browserResultCopy('Page content from x\nsummary!: 9 errors'), null, 'debug row: only the first line counts')
equal(browserLabel('mcp__clui-browser__storage', { area: 'indexeddb' }), 'IndexedDB', 'debug row: IndexedDB label')
equal(browserLabel('mcp__clui-browser__storage', {}), 'storage', 'debug row: storage label')
equal(browserLabel('mcp__clui-browser__cookies', {}), 'cookies', 'debug row: cookies label')

// URLs in tool output: what becomes a link, and where it ends.
import { urlSpans } from '../src/renderer/src/lib/urlSpans.ts'
const urls = (t: string, cut = false): string => urlSpans(t, cut).map((s) => s.url).join(' ')
equal(urls('Created https://github.com/o/r/pull/14686.'), 'https://github.com/o/r/pull/14686', 'links: trailing period dropped')
equal(urls('(see https://example.com/a_(b))'), 'https://example.com/a_(b)', 'links: a balanced paren stays, the outer one goes')
equal(urls('one http://localhost:5173/x, two https://a.io'), 'http://localhost:5173/x https://a.io', 'links: several in one line')
equal(urls('ftp://x.io and mailto:me@x.io'), '', 'links: only http(s)')
equal(urls('tail https://example.com/very/lo', true), '', 'links: a URL cut by truncation stays text')

// A Skill row names the skill it ran.
equal(summarizeInput({ skill: 'create-cso-pr', args: '--help' }), 'create-cso-pr', 'summarizeInput: Skill shows the skill name')

// change_read: named as a history read, never a bare Read, and summarized by the change its user message sent.
{
  const { toolLabel, changeReadOf } = await import('../src/renderer/src/lib/instrument.ts')
  const { sessionStatusOf } = await import('../src/renderer/src/lib/sessionStatus.ts')
  const { serializeContext } = await import('../src/shared/context.ts')
  const REF = `chg_${'3'.repeat(32)}`
  const sent = serializeContext([{ version: 1, ref: { id: 'r1', kind: 'change', changeRef: REF, path: 'src/mcp.ts', side: 'before', old: { start: 3, end: 3 } } }], 'why?', { packetId: null })
  const messages = [msg('u1', 'user', sent), msg('a1', 'assistant', '', { tools: [{ id: 't1', name: 'mcp__clui-surface__change_read', input: { ref: REF } }] })]
  equal(toolLabel('mcp__clui-surface__change_read'), 'Read change', 'change_read: its row name')
  equal(toolLabel('mcp__clui-surface__surface_open') + toolLabel('mcp__clui-surface__surface_state'), 'PanePane', 'toolLabel: the pane tools say Pane')
  equal(toolLabel('Agent') + toolLabel('mcp__clui-browser__click') + toolLabel('Read'), 'AgentBrowserRead', 'toolLabel: the other names are unchanged')
  equal(JSON.stringify(changeReadOf(messages as never, { ref: REF })), JSON.stringify({ label: 'mcp.ts · before L3', spoken: 'mcp.ts change, before side, line 3' }), 'change_read: summary from the sent ref')
  equal(changeReadOf(messages as never, { ref: `chg_${'4'.repeat(32)}` }), null, 'change_read: a ref never sent has no summary')
  const st = sessionStatusOf({ pendingPermissions: [], lastError: null, busy: true, compacting: false, thinkingTokens: null, messages } as never)
  equal(`${st.lead} ${st.rest}`, 'Read change mcp.ts · before L3', 'change_read: status line')
}

// A Monitor's row follows the monitor, not its start result.
{
  const mon = (result?: string, isError?: boolean): any => ({ id: 'm', name: 'Monitor', input: {}, result, isError })
  const rec = (status: string): any => ({ taskId: 't', description: 'd', status, startMs: 0, wakes: 0, sharedWakes: 0, costUsd: 0, estimated: false })
  equal(monitorRowState(mon(), false, false, undefined), 'running', 'monitor row: no result yet keeps the existing state')
  equal(monitorRowState(mon('bad', true), false, false, rec('running')), 'failed', 'monitor row: an error result failed')
  equal(monitorRowState(mon('ok'), false, false, rec('running')), 'watching', 'monitor row: running reads watching')
  equal(monitorRowState(mon('ok'), false, false, rec('completed')), 'ended', 'monitor row: completed reads ended')
  equal(monitorRowState(mon('ok'), false, false, rec('killed')), 'stopped', 'monitor row: killed reads stopped')
  equal(monitorRowState(mon('ok'), false, false, undefined), 'ended', 'monitor row: no record reads ended')
}

// SendMessage: the result is JSON with `success`, and a failed send is not an error result. The two success strings
// are from test/fixtures/sendmessage; the failure is a live 2.1.331 send to an id nobody holds.
{
  const { toolLabel } = await import('../src/renderer/src/lib/instrument.ts')
  const { sendResultOf, sendInputOf } = await import('../src/renderer/src/lib/agents.ts')
  const queued = '{"success":true,"message":"Message queued for delivery to a346a162ba7618e7e at its next tool round. If it finishes first, it is resumed with the message and notifies again, so wait for that notification before resending.","pin":{"id":"a346a162ba7618e7e","name":"a346a162ba7618e7e","ref":"d0cf36"}}'
  const resumed = '{"success":true,"message":"Resuming agent a346a16","resumedAgentId":"a346a162ba7618e7e","pin":{"id":"a346a162ba7618e7e","name":"a346a162ba7618e7e","ref":"d0cf36"}}'
  const failed = '{"success":false,"message":"No agent named \'a0000000000000bogus\' is reachable.\\nUse ListAgents to see everyone you can message."}'
  equal(JSON.stringify(sendResultOf(queued)), JSON.stringify({ ok: true, note: JSON.parse(queued).message, pinId: 'a346a162ba7618e7e' }), 'send: a queued result is ok, with its note and pinned id')
  equal(JSON.stringify(sendResultOf(resumed)), JSON.stringify({ ok: true, note: 'Resuming agent a346a16', pinId: 'a346a162ba7618e7e' }), 'send: a resume result is ok')
  equal(JSON.stringify(sendResultOf(failed)), JSON.stringify({ ok: false, note: "No agent named 'a0000000000000bogus' is reachable.\nUse ListAgents to see everyone you can message.", pinId: null }), 'send: a failed send is not ok and pins nothing')
  equal(sendResultOf('Message sent'), null, 'send: a non-JSON result is no send result')
  equal(sendResultOf('{"success":"yes","message":"x"}'), null, 'send: a non-boolean success is no send result')
  equal(sendResultOf('null'), null, 'send: JSON null is no send result')

  const send = (result: string, o: Record<string, unknown> = {}) => tool({ name: 'SendMessage', input: { to: 'a1', message: 'hi' }, result, ...o })
  equal(rowState(send(resumed), false), 'sent', 'row: an ok send reads sent')
  equal(rowState(send(failed), false), 'failed', 'row: a send that did not go through is failed')
  equal(rowState(send('boom', { isError: true }), false), 'failed', 'row: an error result is failed')
  equal(rowState(send('Message sent'), false), 'done', 'row: an unparsed send result reads done')
  equal(toolLabel('SendMessage'), 'Message', 'toolLabel: SendMessage says Message')

  const input = { to: 'a346a162ba7618e7e', message: 'Now reply with the word CHERRY.', type: 'message', recipient: 'a346a162ba7618e7e', recipient_kind: 'agent', content: 'Now reply with the word CHERRY.' }
  equal(JSON.stringify(sendInputOf(input)), JSON.stringify({ to: 'a346a162ba7618e7e', text: 'Now reply with the word CHERRY.', kind: 'agent' }), 'send input: the CLI-normalized input')
  equal(JSON.stringify(sendInputOf({ recipient: 'peer-1', content: 'yo' })), JSON.stringify({ to: 'peer-1', text: 'yo', kind: null }), 'send input: recipient and content alone, no kind')
  equal(JSON.stringify(sendInputOf({ to: 'team', message: { type: 'shutdown_request' }, content: 'stop' })), JSON.stringify({ to: 'team', text: 'stop', kind: null }), 'send input: an object message falls back to content')
  equal(sendInputOf({ to: 'team', message: { type: 'shutdown_request' } }), null, 'send input: no string text is no send input')
}

// Tiers, the fold plan, and the sentence a run's routine calls fold into.
{
  const { tierOf, foldable, foldPlan, sentenceOf } = await import('../src/renderer/src/lib/instrument.ts')
  const tier = (o: Record<string, unknown>, needsYou = false) => {
    const t = tool(o)
    return tierOf(t, rowState(t, needsYou))
  }
  equal(tier({}, true), 'loud', 'tier: a Bash waiting on you is loud')
  equal(tier({ name: 'Read' }), 'routine', 'tier: a running Read is routine')
  equal(foldable(tool({ name: 'Read' })), false, 'fold: a running Read never folds')
  equal(tier({}), 'legible', 'tier: a running Bash is legible')
  equal(tier({ result: 'ok' }), 'routine', 'tier: a passed Bash is routine')
  equal(tier({ input: { run_in_background: true }, result: 'Started' }), 'calm', 'tier: a backgrounded Bash is calm')
  equal(tier({ name: 'mcp__clui-browser__console', result: 'summary!: 3 errors' }), 'legible', 'tier: a flagged browser call is legible')
  equal(tier({ name: 'mcp__clui-browser__console', result: 'summary: no errors' }), 'routine', 'tier: an unflagged browser call is routine')
  equal(tierOf(tool({ name: 'Monitor', result: 'ok' }), 'ended'), 'legible', 'tier: an ended Monitor is legible')
  equal(foldable(tool({ name: 'Monitor', result: 'ok' })), false, 'fold: a Monitor never folds')
  equal(tier({ name: 'Read', result: 'x', stopped: true }), 'legible', 'tier: a stopped Read is legible')
  equal(tier({ name: 'mcp__linear__get_issue', result: 'ok' }), 'routine', 'tier: an unknown MCP tool is routine')
  equal(tier({ name: 'Agent', result: 'ok' }), 'calm', 'tier: a done Agent is calm')
  equal(tier({ name: 'Agent', result: 'boom', isError: true }), 'loud', 'tier: a failed Agent is loud')
  equal(tier({ name: 'Edit', result: 'ok' }), 'legible', 'tier: a done Edit is legible')

  const read = (id: string, o: Record<string, unknown> = {}) => tool({ id, name: 'Read', input: { file_path: `src/${id}.ts` }, result: 'ok', ...o })
  const edit = (id: string, path: string, o: Record<string, unknown> = {}) => tool({ id, name: 'Edit', input: { file_path: path }, result: 'ok', ...o })
  const none = new Set<string>()
  const plan = (tools: unknown[], o: Record<string, unknown> = {}) => foldPlan(tools as never, { settled: false, keptIds: none, focusId: null, sentenceOpen: false, ...o })
  const ids = (s: Iterable<string>) => [...s].join(' ')
  const six = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6'].map((id) => read(id))
  const live = [...six, tool({ id: 'b', input: { command: 'npm test' } })]
  equal(ids(plan(live).folded), 'r1 r2 r3', 'live: the oldest done reads fold, the newest 3 stay')
  equal(plan(live).lastVisible, 'b', 'live: the running call is the last visible row')
  equal(ids(plan(live, { focusId: 'r1' }).folded), 'r2 r3', 'live: the focused row never folds')
  equal(ids(plan([...six, read('r7', { result: undefined })]).folded), 'r1 r2 r3', 'live: a running routine row never folds')

  equal(ids(plan([read('a'), read('b')], { settled: true }).folded), 'a b', 'settled: two done routine rows fold')
  equal(plan([read('a'), edit('e', 'x.ts')], { settled: true }).folded.size, 0, 'settled: a lone routine row keeps its row')
  equal(ids(plan([read('a'), read('b'), read('c')], { settled: true, keptIds: new Set(['b']) }).folded), 'a c', 'settled: a kept row is exempt')
  equal(plan([read('a'), read('b')], { settled: true, keptIds: new Set(['b']) }).folded.size, 0, 'settled: a row closed after opening stays kept, so its lone neighbour keeps its row too')
  const mixed = [read('a'), read('b'), tool({ id: 'f', result: 'x', isError: true }), tool({ id: 'ag', name: 'Agent', result: 'ok' }), edit('e', 'x.ts'), tool({ id: 'r', input: { command: 'ls' } })]
  equal(ids(plan(mixed, { settled: true }).folded), 'a b', 'settled: loud, calm and legible rows never fold')
  equal(plan([read('a'), read('b')], { settled: true }).lastVisible, null, 'settled: all folded leaves the sentence last')
  equal(plan([read('a'), read('b')], { settled: true, sentenceOpen: true }).lastVisible, 'b', 'settled: an open sentence shows its last row')

  const three = [edit('e1', 'a.ts'), edit('e2', 'a.ts'), edit('e3', 'a.ts')]
  const m = plan(three, { settled: true })
  equal(ids(m.mergedInto.keys()) + ' > ' + m.mergedInto.get('e1'), 'e1 e2 > e3', 'merge: same-path edits merge into the last')
  equal(m.merged.get('e3')?.length, 3, 'merge: the kept row holds every edit')
  equal(plan([edit('e1', 'a.ts'), edit('e2', 'b.ts')], { settled: true }).mergedInto.size, 0, 'merge: two paths are two rows')
  const broken = plan([edit('e1', 'a.ts'), edit('e2', 'a.ts', { isError: true }), edit('e3', 'a.ts')], { settled: true })
  equal(ids(broken.mergedInto.keys()) + ' | ' + broken.merged.get('e3')?.map((t: { id: string }) => t.id).join(' '), 'e1 | e1 e3', 'merge: a failed edit stays its own row')
  equal(plan(three).mergedInto.size, 0, 'merge: nothing merges while live')
  const nb = (id: string) => tool({ id, name: 'NotebookEdit', input: { notebook_path: 'n.ipynb' }, result: 'ok' })
  equal(plan([nb('n1'), nb('n2')], { settled: true }).mergedInto.get('n1'), 'n2', 'merge: NotebookEdit merges by notebook_path')

  const resumed = [read('a'), read('b'), edit('e1', 'x.ts'), read('c'), edit('e2', 'x.ts')]
  const rp = plan(resumed, { settled: true })
  equal(`${ids(rp.folded)} | ${ids(rp.mergedInto.keys())} | ${rp.lastVisible}`, 'a b c | e1 | e2', 'resumed: one plan, reads folded and edits merged')

  const say = (tools: unknown[], bashNamed = Infinity, label: (t: unknown) => string | null = () => null) => sentenceOf(tools as never, { changeLabel: label as never, bashNamed }).plain
  equal(say([read('a'), read('b')]), 'Read a.ts and b.ts', 'sentence: two reads are named')
  equal(say([read('a'), read('b'), read('c')]), 'Read 3 files', 'sentence: three reads are counted')
  equal(say([read('a'), read('a', { id: 'a2' }), read('a', { id: 'a3' })]), 'Read a.ts', 'sentence: rereads of one file name it once')
  const grep = (id: string, pattern: string) => tool({ id, name: 'Grep', input: { pattern }, result: 'ok' })
  equal(say([grep('g1', 'useStore'), read('a'), grep('g2', 'x'), grep('g3', 'y')]), 'Searched 3 times, read a.ts', 'sentence: verbs in order of first appearance, capitalized, no period')
  const sh = (id: string, command: string) => tool({ id, input: { command }, result: 'ok' })
  const cmds = [sh('s1', 'git status'), read('a'), sh('s2', 'npm test\n--watch'), sh('s3', 'ls'), sh('s4', 'pwd')]
  equal(say(cmds), 'Read a.ts, ran git status, npm test, ls and pwd', 'sentence: Bash goes last, every command named')
  equal(say(cmds, 2), 'Read a.ts, ran git status, npm test and 2 more commands', 'sentence: Bash names 2, counts the rest')
  equal(say(cmds, 0), 'Read a.ts, ran 4 commands', 'sentence: Bash names none')
  equal(say([sh('s1', 'ls'), sh('s2', 'pwd')], 1), 'Ran ls and 1 more command', 'sentence: one more command is singular')
  equal(say([sh('s1', 'x'.repeat(50))]), `Ran ${'x'.repeat(39)}…`, 'sentence: a command is cut at 40 characters')
  equal(say([tool({ id: 'k', name: 'CronList', result: 'ok' })]), 'Used CronList', 'sentence: the fallback verb')
  equal(say([tool({ id: 'k', name: 'CronList', result: 'ok' }), tool({ id: 'k2', name: 'CronList', result: 'ok' })]), 'Used CronList 2 times', 'sentence: the fallback verb counts from 2')
  equal(say([tool({ id: 'l', name: 'mcp__linear__get_issue', result: 'ok' })]), 'Used linear get_issue', 'sentence: the MCP form')
  const cr = (id: string) => tool({ id, name: 'mcp__clui-surface__change_read', input: { ref: id }, result: 'ok' })
  equal(say([cr('c1')], Infinity, (t) => `${(t as { id: string }).id} · before L3`), 'Read change c1 · before L3', 'sentence: change_read takes the injected label')
  equal(say([cr('c1')]), 'Read 1 change', 'sentence: a change with no label is counted')
  const parts = sentenceOf([read('a'), sh('s1', 'ls')] as never, { changeLabel: () => null, bashNamed: Infinity }).parts
  equal(parts.filter((p) => p.mono).map((p) => p.text).join(' '), 'a.ts ls', 'sentence: only objects are mono')
}
