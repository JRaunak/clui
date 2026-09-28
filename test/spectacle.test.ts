// Boundary: the input-modality split that decides whether a view change animates, and the Lumen's site rules,
// including the idle guard an interrupted turn needs.
import { viaOf } from '../src/renderer/src/lib/motion.ts'
import { lumenKeyOf, lumenSiteOf, runningCountOf } from '../src/renderer/src/lib/lumen.ts'
import type { PerSessionState, ToolCall } from '../src/renderer/src/store.ts'
import { equal } from './support/harness.mjs'

equal(viaOf({ detail: 1 }), 'pointer', 'viaOf: a real click is pointer')
equal(viaOf({ detail: 2 }), 'pointer', 'viaOf: a double click is pointer')
equal(viaOf({ detail: 0 }), 'keyboard', 'viaOf: Enter/Space on a button is keyboard')
equal(viaOf(null), 'keyboard', 'viaOf: no event is treated as keyboard (instant)')

const tool = (id: string, extra: Partial<ToolCall> = {}): ToolCall => ({ id, name: 'Bash', input: { command: 'x' }, ...extra }) as ToolCall
const slice = (p: Partial<PerSessionState>): PerSessionState =>
  ({ busy: false, compacting: false, pendingPermissions: [], messages: [], ...p }) as unknown as PerSessionState
const asst = (tools: ToolCall[]) => ({ id: 'a', role: 'assistant', text: '', thinking: '', tools, blocks: [], attachments: [] })

equal(lumenKeyOf(null), '', 'lumen: no session, no light')
equal(lumenKeyOf(slice({})), '', 'lumen: idle, no light')
equal(lumenKeyOf(slice({ busy: true })), 'tail', 'lumen: streaming with no tool lights the tail')
equal(lumenKeyOf(slice({ compacting: true })), 'tail', 'lumen: compacting lights the tail')
equal(lumenKeyOf(slice({ busy: true, messages: [asst([tool('t1', { result: 'ok' }), tool('t2')])] as never })), 'tool:t2', 'lumen: the running tool holds the light')
equal(lumenKeyOf(slice({ busy: true, messages: [asst([tool('t1'), tool('t2')])] as never })), 'tail', 'lumen: tools running in parallel hand the light to the tail')
equal(runningCountOf(slice({ busy: true, messages: [asst([tool('a', { name: 'Agent' }), tool('b', { name: 'Task' })])] as never })).agents, true, 'runningCountOf: all subagents read as agents')
equal(runningCountOf(slice({ busy: true, messages: [asst([tool('a', { name: 'Agent' }), tool('b'), tool('c', { result: 'ok' })])] as never })).n, 2, 'runningCountOf: counts only unresolved tools')
equal(runningCountOf(slice({ busy: true, messages: [asst([tool('a', { name: 'Agent' }), tool('b')])] as never })).agents, false, 'runningCountOf: a mix reads as tools')
equal(lumenKeyOf(slice({ busy: true, messages: [asst([tool('bg', { input: { command: 'x', run_in_background: true } })])] as never })), 'tail', 'lumen: a backgrounded tool never holds the light')
equal(lumenKeyOf(slice({ busy: true, messages: [asst([tool('w', { name: 'Workflow' })])] as never })), 'tail', 'lumen: a workflow launch never holds the light')
equal(lumenKeyOf(slice({ busy: false, messages: [asst([tool('dangling')])] as never })), '', 'lumen: an interrupted turn with a result-less tool stays dark')
equal(lumenKeyOf(slice({ busy: true, pendingPermissions: [{}] as never })), '', 'lumen: the light goes out while Claude waits on you')
equal(lumenSiteOf(slice({ busy: true }))?.kind, 'tail', 'lumenSiteOf: parses the tail key')
