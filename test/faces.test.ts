// Agent tabs' pure logic: face assignment, the one status function, the disk-to-stream shape and the dense strip.
import { assignFaces, FACE_COUNT } from '../src/renderer/src/lib/faces.ts'
import { agentRunState, denseNext, entriesOf, faceOf, runStateOf, stopTargetOf, trailOf } from '../src/renderer/src/lib/agents.ts'
import { phaseState, workflowSummary } from '../src/renderer/src/lib/workflow.ts'
import { equal, ok } from './support/harness.mjs'

const json = (v: unknown): string => JSON.stringify(v)
const faces = (m: Map<string, number>, keys: string[]): number[] => keys.map((k) => m.get(k)!)

// Launch order hands out faces, skipping held ones; deterministic, so a relaunch gets the same faces back.
{
  const four = [0, 1, 2, 3].map((i) => ({ key: `a${i}`, at: i, end: null }))
  equal(new Set(assignFaces(four).values()).size, 4, 'faces: 4 overlapping launches get 4 distinct faces')
  const fifth = [...four.map((l, i) => (i === 1 ? { ...l, end: 3.5 } : l)), { key: 'a4', at: 4, end: null }]
  const m = assignFaces(fifth)
  ok(m.get('a4') === 4 && m.get('a4') !== m.get('a1'), "faces: a 5th launched after #2 ended takes the next free face, not #2's")
  const siblings = assignFaces([{ key: 'x', at: 0, end: 0.5 }, { key: 'y', at: 0, end: 0.5 }])
  ok(siblings.get('x') !== siblings.get('y'), 'faces: two foreground siblings in one message differ')
  const bg = assignFaces([{ key: 'b', at: 0, end: 2.5 }, { key: 'c', at: 1, end: null }, { key: 'd', at: 3, end: null }])
  ok(bg.get('b') !== bg.get('c') && bg.get('d') === 2, 'faces: a background agent holds its face while it runs')
  const held = Array.from({ length: FACE_COUNT + 1 }, (_, i) => ({ key: `h${i}`, at: i, end: null }))
  equal(assignFaces(held).get(`h${FACE_COUNT}`), 0, 'faces: with all twelve held the next launch takes the next in turn')
  const nested = assignFaces([{ key: 'n0', at: 0, end: null }, { key: 'n1', at: 1, end: null }], 6, new Set([5]))
  ok(![...nested.values()].includes(5) && nested.get('n0') === 6, "faces: the nested scope never returns the parent's face")
  equal(json(faces(assignFaces(fifth), ['a0', 'a1', 'a2', 'a3', 'a4'])), json(faces(m, ['a0', 'a1', 'a2', 'a3', 'a4'])), 'faces: the same launches twice give the same faces')
}

// The workflow agent's state word.
{
  equal(runStateOf('start', null), 'running', 'runStateOf: start is running')
  equal(runStateOf('error', 'killed'), 'stopped', 'runStateOf: error in a stopped workflow is stopped')
  equal(runStateOf('error', 'completed'), 'failed', 'runStateOf: error in a completed workflow is failed')
  equal(runStateOf('done', 'killed'), 'done', 'runStateOf: done stays done')
  equal(runStateOf('queued', 'stopped'), 'stopped', 'runStateOf: a never-started agent in a stopped workflow is stopped')
  equal(runStateOf('weird', null), 'queued', 'runStateOf: an unknown word is queued')
}

const sliceOf = (over: Record<string, unknown> = {}): any => ({
  messages: [],
  subagentMessages: {},
  subagentChildren: {},
  nestedLaunches: {},
  agentMetas: {},
  backgroundTasks: {},
  workflows: {},
  workflowReads: {},
  pendingPermissions: [],
  busy: false,
  interrupting: false,
  surfaces: { order: [], active: null, tabs: {}, browserLastViewedAt: {}, browserUnseen: {} },
  ...over
})
const tool = (over: Record<string, unknown> = {}): any => ({ id: 't1', name: 'Agent', input: { description: 'Probe' }, ...over })
const msg = (tools: any[]): any => ({ id: 'm', role: 'assistant', text: '', thinking: '', tools })
const T = { by: 'tool' as const, id: 't1' }
const run = (s: any, meta?: any): string => {
  const r = agentRunState(s, T, meta)
  return r.reason ? `${r.state}:${r.reason}` : r.state
}

// One status: background task, then a live launch, then a rebuilt one, then the sidecar, then nothing.
{
  const bg = (status: string, extra: Record<string, unknown> = {}): any => ({ x: { taskId: 'x', description: '', taskType: 'local_agent', toolUseId: 't1', status, startMs: 1, ...extra } })
  equal(run(sliceOf({ backgroundTasks: bg('running') })), 'background', 'status: a running bg task is in background')
  equal(run(sliceOf({ backgroundTasks: bg('running'), pendingPermissions: [{ requestId: 'r', toolName: 'Bash', input: {}, agentToolUseId: 't1' }] })), 'needs', 'status: a pending ask overrides background')
  equal(run(sliceOf({ backgroundTasks: bg('completed'), pendingPermissions: [{ requestId: 'r', toolName: 'Bash', input: {}, agentToolUseId: 't1' }] })), 'done', 'status: a pending ask never overrides done')
  equal(run(sliceOf({ backgroundTasks: bg('killed') })), 'stopped', 'status: a killed bg task is stopped')
  equal(run(sliceOf({ backgroundTasks: bg('running', { stopping: true }) })), 'stopping', 'status: a bg stop in flight is stopping')
  equal(agentRunState(sliceOf({ backgroundTasks: bg('completed', { endMs: 41_001 }) }), T).durationMs, 41_000, 'status: a bg duration runs from start to its end')
  equal(run(sliceOf({ messages: [msg([tool({ startMs: 1 })])] })), 'running', 'status: a live launch without a result runs')
  equal(run(sliceOf({ messages: [msg([tool({ startMs: 1, result: 'x', isError: true, stopped: true })])] })), 'stopped', 'status: a live stop with isError is stopped, not failed')
  equal(run(sliceOf({ messages: [msg([tool({ startMs: 1, result: 'x', isError: true })])] })), 'failed', 'status: a live error is failed')
  equal(run(sliceOf({ messages: [msg([tool({ result: 'User rejected tool use', isError: true })])] })), 'stopped', 'status: a rebuilt rejected call is stopped')
  equal(run(sliceOf({ messages: [msg([tool()])] })), 'interrupted:quit', 'status: a rebuilt foreground call without a result was interrupted by the quit')
  equal(run(sliceOf({ messages: [msg([tool({ result: 'ok', durationMs: 9 })])] })), 'done', 'status: a rebuilt result is done')
  equal(run(sliceOf({ messages: [msg([tool({ result: 'launched', background: true })])] }), { shape: 'background' }), 'interrupted:quit', 'status: a bg sidecar without finished was interrupted by the quit')
  equal(run(sliceOf({ messages: [msg([tool({ result: 'launched', background: true })])] }), { shape: 'background', finished: true, stoppedByUser: true }), 'stopped', 'status: a bg sidecar stopped by the user is stopped')
  equal(run(sliceOf(), { shape: 'background' }), 'interrupted:quit', 'status: a sidecar alone without finished is interrupted by the quit')
  equal(run(sliceOf({ agentMetas: { t1: { shape: 'background', finished: true } } })), 'done', 'status: the stored sidecar stands in when none is passed')
  equal(run(sliceOf()), 'interrupted:no-result', 'status: nothing found while idle ended without a result')
  equal(run(sliceOf({ busy: true })), 'running', 'status: nothing found while the turn runs is running')
  equal(agentRunState(sliceOf(), { by: 'agent', id: 'a1' }).state + agentRunState(sliceOf(), { by: 'agent', id: 'a1' }).reason, 'interruptedquit', 'status: a workflow agent with no workflow record was interrupted by the quit')
  const wf = { w: { taskId: 'w', name: 'wf', description: '', phases: [], agents: [{ index: 0, label: 'a', phaseIndex: 0, state: 'error', agentId: 'a1' }], endedStatus: 'killed' } }
  equal(agentRunState(sliceOf({ workflows: wf }), { by: 'agent', id: 'a1' }).state, 'stopped', 'status: a workflow agent cut off by a stop is stopped')
}

// Faces through the slice: main scope by message order, nested scope from the parent's launches, workflow by index.
{
  const s = sliceOf({ messages: [msg([tool({ id: 'p', startMs: 1 })]), msg([tool({ id: 'q', startMs: 1 })])] })
  ok(faceOf(s, { key: 'tool:p' }) === 0 && faceOf(s, { key: 'tool:q' }) === 1, 'faceOf: main launches take faces in order')
  equal(faceOf(s, { key: 'tool:c2', trail: ['agent:tool:p'] }), null, "faceOf: a restored nested tab is generic before its parent's launches load")
  const loaded = { ...s, nestedLaunches: { p: [tool({ id: 'c1' }), tool({ id: 'c2' })] } }
  const f = faceOf(loaded, { key: 'tool:c2', trail: ['agent:tool:p'] })
  ok(f === 2, "faceOf: once loaded, a nested child takes its sibling-order face past its parent's", `${f}`)
  equal(faceOf({ ...loaded }, { key: 'tool:c2', trail: ['agent:tool:p'] }), f, 'faceOf: the same face from the same transcripts, as after a relaunch')
  const wf = { w: { taskId: 'w', name: 'wf', description: '', phases: [], agents: [{ index: 1, label: 'b', phaseIndex: 0, state: 'done', agentId: 'b' }, { index: 0, label: 'a', phaseIndex: 0, state: 'done', agentId: 'a' }], endedStatus: null } }
  ok(faceOf(sliceOf({ workflows: wf }), { key: 'agent:a' }) === 0 && faceOf(sliceOf({ workflows: wf }), { key: 'agent:b' }) === 1, 'faceOf: workflow agents take faces by index')
  equal(json(trailOf({ ...loaded, subagentChildren: {}, subagentMessages: { c2: [{ kind: 'tool', tool: tool({ id: 'g' }) }] } }, 'g')), json(['agent:tool:p', 'agent:tool:c2']), 'trailOf: ancestors root first')
}

// Disk history in the stream's shape: thinking, text, tools; a peer message dropped.
{
  const h = [
    { id: '1', role: 'user', text: 'Do it', thinking: '', tools: [] },
    { id: '2', role: 'assistant', text: 'On it', thinking: 'hmm', tools: [{ id: 'x', name: 'Read', input: {} }] },
    { id: '3', role: 'user', text: 'hi', thinking: '', tools: [], peer: { from: 'p' } }
  ] as any
  equal(json(entriesOf(h).map((e) => (e.kind === 'tool' ? `tool:${e.tool.id}` : `${e.kind}:${e.role}`))), json(['text:user', 'thinking:assistant', 'text:assistant', 'tool:x']), 'entriesOf: thinking, text, then tools per message; peers dropped')
}

// Dense strip: enters past the width, holds inside the 24px band, leaves once it fits with room.
{
  ok(!denseNext(3, 368, false) && denseNext(3, 367, false), 'dense: enters when 120n + 4(n-1) passes the width')
  ok(denseNext(3, 390, true), 'dense: holds inside the 24px band')
  ok(!denseNext(3, 392, true), 'dense: leaves once it fits with 24px to spare')
}

// Find: a transcript tab takes it; a list tab never does.
{
  const { hasFind } = await import('../src/renderer/src/lib/presentation.ts')
  ok(hasFind(null, { kind: 'agent', key: 'tool:x' }) && hasFind(null, { kind: 'workflow', key: 'w' }), 'find: agent and workflow tabs take Find')
  ok(!hasFind(null, { kind: 'agents', key: '' }) && !hasFind(null, { kind: 'workflows', key: '' }), 'find: list tabs never do')
}

// Which Stop a tab offers: a bg agent's task, main's turn for a foreground one, the whole workflow for a workflow
// agent, and none for anything that isn't running.
{
  const target = (s: any, tab: any): string => json(stopTargetOf(s, tab))
  const agentTab = (id: string, trail?: string[]): any => ({ kind: 'agent', key: `tool:${id}`, ...(trail ? { trail } : {}) })
  const bgRow = (id: string, toolUseId: string, status = 'running', extra: Record<string, unknown> = {}): any => ({ [id]: { taskId: id, description: '', taskType: 'local_agent', toolUseId, status, startMs: 1, ...extra } })
  const fg = msg([tool({ startMs: 1 })])
  equal(target(sliceOf({ backgroundTasks: bgRow('b1', 't1') }), agentTab('t1')), json({ kind: 'task', taskId: 'b1', stopping: false }), 'stop: a bg agent stops its own task')
  equal(target(sliceOf({ backgroundTasks: bgRow('b1', 't1', 'running', { stopping: true }) }), agentTab('t1')), json({ kind: 'task', taskId: 'b1', stopping: true }), 'stop: a bg stop in flight is stopping')
  equal(target(sliceOf({ backgroundTasks: bgRow('b1', 't1', 'killed', { stopping: true }) }), agentTab('t1')), 'null', 'stop: a killed bg agent offers none')
  equal(run(sliceOf({ backgroundTasks: bgRow('b1', 't1', 'killed', { stopping: true }) })), 'stopped', 'status: a killed bg agent whose stopping flag lingers reads stopped')
  equal(target(sliceOf({ busy: true, messages: [fg] }), agentTab('t1')), json({ kind: 'turn', stopping: false }), 'stop: a foreground agent while main is busy interrupts the turn')
  equal(target(sliceOf({ interrupting: true, messages: [fg] }), agentTab('t1')), json({ kind: 'turn', stopping: true }), 'stop: an interrupt in flight is stopping')
  equal(target(sliceOf({ messages: [fg] }), agentTab('t1')), 'null', 'stop: a foreground agent while main is idle offers none')
  equal(target(sliceOf({ busy: true, messages: [msg([tool({ startMs: 1, result: 'ok' })])] }), agentTab('t1')), 'null', 'stop: an ended agent offers none')
  const nested = sliceOf({ busy: true, backgroundTasks: bgRow('b1', 'p'), subagentChildren: { p: [{ childToolUseId: 'c', name: 'Agent' }] } })
  equal(target(nested, agentTab('c', ['agent:tool:p'])), json({ kind: 'task', taskId: 'b1', ancestor: 'agent:tool:p', stopping: false }), 'stop: a child under a bg parent stops the parent')
  equal(target(nested, agentTab('c')), json({ kind: 'task', taskId: 'b1', ancestor: 'agent:tool:p', stopping: false }), 'stop: a tab without a trail finds the bg parent from the live state')
  const twoDeep = sliceOf({ busy: true, backgroundTasks: bgRow('b1', 'p'), subagentChildren: { p: [{ childToolUseId: 'm', name: 'Agent' }], m: [{ childToolUseId: 'c', name: 'Agent' }] } })
  equal(target(twoDeep, agentTab('c', ['agent:tool:p', 'agent:tool:m'])), json({ kind: 'task', taskId: 'b1', ancestor: 'agent:tool:p', stopping: false }), 'stop: a fg middle agent is skipped for the bg one above it')
  equal(target(sliceOf({ busy: true, backgroundTasks: bgRow('b1', 'p', 'killed'), subagentChildren: { p: [{ childToolUseId: 'c', name: 'Agent' }] } }), agentTab('c', ['agent:tool:p'])), 'null', 'stop: a child of an ended bg agent offers none, never the turn')
  equal(target(sliceOf({ busy: true, subagentChildren: { p: [{ childToolUseId: 'c', name: 'Agent' }] } }), agentTab('c', ['agent:tool:p'])), json({ kind: 'turn', stopping: false }), 'stop: a child under fg agents only interrupts the turn')
  const wfOf = (endedStatus: string | null, state = 'start', extra: Record<string, unknown> = {}): any => ({ w: { taskId: 'w', name: 'wf', description: '', phases: [], agents: [{ index: 0, label: 'a', phaseIndex: 0, state, agentId: 'a1' }], endedStatus, ...extra } })
  const A = { kind: 'agent', key: 'agent:a1', trail: ['workflow:w'] }
  const W = { kind: 'workflow', key: 'w' }
  equal(target(sliceOf({ workflows: wfOf(null) }), W), json({ kind: 'workflow', taskId: 'w', stopping: false }), 'stop: a running workflow stops itself')
  equal(target(sliceOf({ workflows: wfOf(null) }), A), json({ kind: 'workflow', taskId: 'w', stopping: false }), "stop: a workflow agent stops its workflow, never its own agentId")
  equal(target(sliceOf({ workflows: wfOf(null, 'done') }), A), json({ kind: 'workflow', taskId: 'w', stopping: false }), 'stop: a done agent in a running workflow can still stop the run')
  equal(target(sliceOf({ workflows: wfOf('completed') }), A) + target(sliceOf({ workflows: wfOf('killed') }), W), 'nullnull', 'stop: an ended workflow offers none on either tab')
  equal(target(sliceOf(), A), 'null', 'stop: a workflow agent with no live workflow offers none')
  const stopping = wfOf(null, 'start', { stopping: true })
  equal(target(sliceOf({ workflows: stopping }), W), json({ kind: 'workflow', taskId: 'w', stopping: true }), 'stop: a workflow stop in flight is stopping')
  equal(workflowSummary(stopping.w, []).state.state, 'stopping', 'workflow: a stop in flight reads stopping')
  equal(phaseState(['done', 'queued'], 'stopping'), 'running', 'workflow: a stopping run leaves an unfinished phase running')
  equal(target(sliceOf({ busy: true }), { kind: 'agents', key: '' }), 'null', 'stop: a list tab offers none')
}
