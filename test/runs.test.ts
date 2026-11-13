import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWorkflowRun } from '../src/main/sessions/runs.ts'
import { ok } from './support/harness.mjs'

// A workflow's record is found through its launch result, falls back to the session's own records, and refuses
// anything that would read outside the projects tree.
{
  const home = mkdtempSync(join(tmpdir(), 'clui-runs-'))
  const project = join(home, 'projects', 'p')
  const sess = (id: string): string => join(project, id)
  const launch = (session: string, taskId: string, runId: string, transcriptDir: string): string =>
    JSON.stringify({ type: 'user', sessionId: session, uuid: `u-${taskId}`, toolUseResult: { status: 'async_launched', taskId, runId, transcriptDir }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu', content: `Workflow launched in background. Task ID: ${taskId}` }] } })
  const record = (taskId: string, runId: string, over: object = {}): string =>
    JSON.stringify({
      taskId,
      runId,
      workflowName: 'review',
      status: 'running',
      totalTokens: 9,
      durationMs: 1200,
      startTime: 7,
      summary: 'Review the specs',
      result: { verdict: 'ship' },
      workflowProgress: [
        { type: 'workflow_phase', index: 1, title: 'Map' },
        { type: 'workflow_agent', index: 1, phaseIndex: 1, label: 'Map reads', agentId: 'a1', state: 'done', tokens: 9, durationMs: 800, startedAt: 7, model: 'm' }
      ],
      ...over
    })
  mkdirSync(join(sess('s1'), 'workflows'), { recursive: true })
  mkdirSync(join(sess('s2'), 'workflows'), { recursive: true })
  // s1 is a fork: its first workflow's record lives under s2, the session it forked from.
  writeFileSync(join(project, 's1.jsonl'), [launch('s1', 'w1', 'wf_1', join(sess('s2'), 'subagents', 'workflows', 'wf_1')), launch('s1', 'w9', 'wf_9', '/etc/subagents/workflows/wf_9')].join('\n') + '\n')
  writeFileSync(join(project, 's2.jsonl'), '')
  writeFileSync(join(sess('s2'), 'workflows', 'wf_1.json'), record('w1', 'wf_1'))
  writeFileSync(join(sess('s1'), 'workflows', 'wf_2.json'), record('w2', 'wf_2', { status: 'killed', result: 'Stopped early.' }))
  writeFileSync(join(sess('s1'), 'workflows', 'wf_bad.json'), '{ not json')
  const prev = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = home
  try {
    const run = await readWorkflowRun('s1', 'w1')
    ok(run?.status === 'running' && run.name === 'review' && run.phases[0]?.title === 'Map' && run.agents[0]?.tokens === 9 && run.agents[0].durationMs === 800, 'runs: a forked launch reads its record under the source session', JSON.stringify(run))
    ok(!!run?.result?.startsWith('```json') && run.result.includes('"verdict": "ship"'), 'runs: a structured result reads as a JSON block')
    const own = await readWorkflowRun('s1', 'w2')
    ok(own?.status === 'killed' && own.result === 'Stopped early.', "runs: with no launch result, the session's own records are matched by task id")
    ok((await readWorkflowRun('s1', 'w9')) === null, 'runs: a launch pointing outside the projects tree reads nothing')
    ok((await readWorkflowRun('s1', '../w1')) === null && (await readWorkflowRun('../s1', 'w1')) === null, 'runs: a bad task or session id reads nothing')
    ok((await readWorkflowRun('s1', 'w404')) === null, 'runs: no record anywhere is null')
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prev
  }
}
