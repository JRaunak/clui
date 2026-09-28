// Boundary: the sidebar status vocabulary. One pure mapping drives every row mark and line 2, so its
// priority order and its handling of backgrounded tools are pinned here.
import { sessionStatusOf, statusKey, statusText } from '../src/renderer/src/lib/sessionStatus.ts'
import { equal } from './support/harness.mjs'

const slice = (p: Record<string, unknown>): never =>
  ({ pendingPermissions: [], lastError: null, busy: false, compacting: false, thinkingTokens: null, messages: [], ...p }) as never
const tool = (id: string, extra: Record<string, unknown> = {}): unknown => ({ id, name: 'Bash', input: { command: 'npm test\nnpm run lint' }, ...extra })
const asst = (tools: unknown[]): unknown => ({ id: 'a', role: 'assistant', text: '', thinking: '', tools, blocks: [] })

equal(sessionStatusOf(slice({})).kind, 'idle', 'status: nothing happening is idle')
equal(sessionStatusOf(slice({ busy: true })).lead, 'Responding', 'status: streaming text with no tool')
equal(sessionStatusOf(slice({ busy: true, thinkingTokens: 1200 })).lead, 'Thinking', 'status: thinking')
equal(sessionStatusOf(slice({ compacting: true })).lead, 'Compacting', 'status: compacting')
{
  const st = sessionStatusOf(slice({ busy: true, messages: [asst([tool('t1', { result: 'ok' }), tool('t2')])] }))
  equal(`${st.kind} ${st.lead} ${st.rest}`, 'working Bash npm test', 'status: the running tool and the first line of its command')
}
equal(
  sessionStatusOf(slice({ busy: true, messages: [asst([tool('bg', { input: { command: 'x', run_in_background: true } })])] })).lead,
  'Responding',
  'status: a backgrounded tool is not the work'
)
equal(
  sessionStatusOf(slice({ busy: true, messages: [asst([{ id: 'ag', name: 'Task', input: { description: 'Explore auth' } }])] })).rest,
  'Explore auth',
  'status: an agent shows its description'
)
{
  const st = sessionStatusOf(slice({ busy: true, lastError: 'boom', pendingPermissions: [{ requestId: 'r', toolName: 'Write', input: {} }, { requestId: 's', toolName: 'Bash', input: {} }] }))
  equal(`${st.kind} ${st.rest} ${st.count}`, 'needs Allow Write 2', 'status: needs you outranks failed and working')
}
equal(sessionStatusOf(slice({ busy: true, lastError: 'boom' })).kind, 'failed', 'status: failed outranks working')
equal(statusText(sessionStatusOf(slice({ pendingPermissions: [{ requestId: 'r', toolName: 'Write', displayName: 'Write', input: {} }] }))), 'Needs you: Allow Write', 'status: sentence form')
equal(statusKey(slice({})), 'idle|Idle||0', 'status: key is a stable primitive')
