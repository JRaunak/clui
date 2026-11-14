import { phaseState, workflowSummary, workflowTaskOf } from '../src/renderer/src/lib/workflow.ts'
import { agentRunState } from '../src/renderer/src/lib/agents.ts'
import { equal, ok } from './support/harness.mjs'

const agent = (index: number, state: string, over: Record<string, unknown> = {}): any => ({ index, label: `agent ${index}`, phaseIndex: 1, state, agentId: `a${index}`, ...over })
const wf = (agents: any[], endedStatus: string | null, over: Record<string, unknown> = {}): any => ({ taskId: 'w1', name: 'review', description: '', phases: [{ index: 1, title: 'Map' }], agents, endedStatus, ...over })
const ask = (agentId?: string): any => ({ requestId: 'r', toolName: 'Bash', input: {}, ...(agentId ? { agentId } : {}) })

// A phase reads its agents in order: needs, running, failed, stopped, all done, any started, queued.
equal(phaseState(['done', 'needs', 'running'], 'running'), 'needs', 'phase: needs beats running')
equal(phaseState(['done', 'running', 'failed'], 'running'), 'running', 'phase: running beats failed')
equal(phaseState(['done', 'failed', 'stopped'], 'failed'), 'failed', 'phase: failed beats stopped')
equal(phaseState(['done', 'stopped'], 'stopped'), 'stopped', 'phase: stopped beats done')
equal(phaseState(['done', 'done'], 'done'), 'done', 'phase: all done is done')
equal(phaseState(['done', 'queued'], 'running'), 'running', 'phase: some started in a live run is running')
equal(phaseState(['done', 'queued'], 'done'), 'done', 'phase: a finished run never reads running')
equal(phaseState(['queued'], 'running'), 'queued', 'phase: nothing started is queued')
equal(phaseState([], 'running'), 'queued', 'phase: an empty phase is queued')
equal(phaseState(['done', 'interrupted'], 'interrupted'), 'interrupted', 'phase: an interrupted run leaves an unfinished phase interrupted')
equal(phaseState(['done'], 'interrupted'), 'done', 'phase: an interrupted run keeps a finished phase done')
equal(phaseState([], 'stopped'), 'stopped', 'phase: an empty phase in a stopped run is stopped')
equal(phaseState(['queued', 'queued'], 'stopped'), 'stopped', 'phase: a stopped run never leaves a phase queued')

// The summary: counts and the run's own state, never tokens.
{
  const live = workflowSummary(wf([agent(1, 'done', { tokens: 1000 }), agent(2, 'done', { tokens: 500 }), agent(3, 'done'), agent(4, 'start'), agent(5, 'error'), agent(6, 'queued'), agent(7, 'queued')], null, { startMs: 3, totalTokens: 99 }), [])
  ok(live.done === 3 && live.total === 7 && live.failed === 1 && live.stopped === 0, 'summary: 3 of 7 done, 1 failed', JSON.stringify(live))
  ok(!('tokens' in live), 'summary: no tokens, whatever the agents carry')
  ok(live.state.state === 'running' && live.state.startMs === 3, 'summary: a live run is running from its start')

  for (const e of ['stopped', 'killed']) {
    const s = workflowSummary(wf([agent(1, 'error'), agent(2, 'done'), agent(3, 'start'), agent(4, 'queued', { agentId: undefined })], e, { durationMs: 900 }), [])
    ok(s.state.state === 'stopped' && s.state.durationMs === 900 && s.stopped === 3 && s.failed === 0 && s.done === 1, `summary: under ${e}, an error and a never-started agent count as stopped, not failed or queued`, JSON.stringify(s))
  }
  const quit = workflowSummary(wf([agent(1, 'done'), agent(2, 'start'), agent(3, 'queued')], 'interrupted'), [])
  ok(quit.state.state === 'interrupted' && quit.state.reason === 'quit' && quit.states.join() === 'done,interrupted,interrupted', 'summary: a run Clui quit during is interrupted, its unfinished agents too', JSON.stringify(quit))
  equal(workflowSummary(wf([agent(1, 'error')], 'failed'), []).state.state, 'failed', 'summary: a failed run is failed')
  const failed = workflowSummary(wf([agent(1, 'done'), agent(2, 'start'), agent(3, 'queued', { agentId: undefined })], 'failed'), [])
  ok(failed.states.join() === 'done,interrupted,unrun' && failed.done === 1 && failed.total === 3, 'summary: a failed run interrupts its running agent and never ran the rest', JSON.stringify(failed))
  const cut = agentRunState({ workflows: { w1: wf([agent(2, 'start')], 'failed') }, pendingPermissions: [] } as any, { by: 'agent', id: 'a2' })
  ok(cut.state === 'interrupted' && cut.reason === 'workflow-failed', "summary: its tab names the workflow's failure", JSON.stringify(cut))
  equal(phaseState(['unrun', 'unrun'], 'failed'), 'unrun', 'phase: a phase a failed run never reached never ran')
  equal(phaseState(['done', 'interrupted'], 'failed'), 'interrupted', 'phase: an interrupted agent beats done')
  equal(phaseState(['done', 'unrun'], 'failed'), 'interrupted', 'phase: a failed run that reached part of a phase left it interrupted')
  equal(phaseState(['done', 'unrun'], 'done'), 'done', 'phase: a completed run that skipped agents still finished the phase')
  const late = agentRunState({ workflows: { w1: wf([agent(2, 'start')], 'completed') }, pendingPermissions: [] } as any, { by: 'agent', id: 'a2' })
  ok(late.state === 'interrupted' && late.reason === 'no-result', 'summary: an agent still running when its run completed is interrupted without a result', JSON.stringify(late))
  equal(workflowSummary(wf([agent(1, 'done')], 'completed'), []).state.state, 'done', 'summary: a completed run is done')
}

// Needs: a gate naming a running agent's id marks that agent, its phase and the run; a gate with no agent id marks none.
{
  const w = wf([agent(1, 'start'), agent(2, 'start')], null)
  const s = workflowSummary(w, [ask('a2')])
  ok(s.states.join() === 'running,needs' && s.state.state === 'needs' && phaseState(s.states, s.state.state) === 'needs', 'needs: the asking agent, its phase and the run need you', JSON.stringify(s.states))
  const own = workflowSummary(w, [ask()])
  ok(own.states.join() === 'running,running' && own.state.state === 'running', "needs: the Workflow tool's own gate marks no row")
  equal(workflowSummary(wf([agent(1, 'done')], null), [ask('a1')]).states[0], 'done', 'needs: a finished agent never needs you')

  const slice: any = { workflows: { w1: w }, pendingPermissions: [ask('a2')] }
  equal(agentRunState(slice, { by: 'agent', id: 'a2' }).state, 'needs', "agent tab: a workflow agent's tab reads needs from its gate")
  const st = agentRunState({ ...slice, workflows: { w1: wf([agent(1, 'done', { durationMs: 800, startedAt: 2 })], 'completed') } }, { by: 'agent', id: 'a1' })
  ok(st.state === 'done' && st.durationMs === 800, "agent tab: a done workflow agent's tab carries its duration")
  const gone = agentRunState({ ...slice, workflows: { w1: wf([agent(2, 'start')], 'interrupted') } }, { by: 'agent', id: 'a2' })
  ok(gone.state === 'interrupted' && gone.reason === 'quit', "agent tab: a workflow agent Clui quit during reads interrupted")
}

// A Workflow card opens its run: by the live record that names the call, else by the task id its result names.
{
  const slice: any = { workflows: { w1: wf([], null, { toolUseId: 'tu-1' }) } }
  equal(workflowTaskOf(slice, { id: 'tu-1', result: undefined }), 'w1', 'card: a live run is found by its launch call')
  equal(workflowTaskOf({ workflows: {} }, { id: 'tu-2', result: 'Workflow launched in background. Task ID: wwcff6p0q\nSummary: x' }), 'wwcff6p0q', 'card: a rebuilt card reads the task id from its result')
  equal(workflowTaskOf({ workflows: {} }, { id: 'tu-3', result: 'Error: no script' }), null, 'card: a card with neither opens nothing')
}
