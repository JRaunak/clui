import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listRuns, readWorkflowRun } from '../src/main/sessions/runs.ts'
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

// The list tabs' scan: main's launches and how each ended, nested launches from a parent's transcript once a sidecar
// names an agent main didn't launch, and the session's workflow records.
{
  const home = mkdtempSync(join(tmpdir(), 'clui-runs-list-'))
  const project = join(home, 'projects', 'p')
  const dir = join(project, 's3')
  mkdirSync(join(dir, 'subagents'), { recursive: true })
  mkdirSync(join(dir, 'workflows'), { recursive: true })
  const launch = (id: string, input: object, at = '2026-11-13T10:00:00.000Z'): string =>
    JSON.stringify({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Agent', input }] } })
  const result = (id: string, r: unknown, content: unknown = 'ok', isError = false): string =>
    JSON.stringify({ type: 'user', toolUseResult: r, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } })
  const note = (id: string, status: string, usage = ''): string =>
    JSON.stringify({ type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content: `<task-notification>\n<task-id>x</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n${usage}</task-notification>` } })
  writeFileSync(
    join(project, 's3.jsonl'),
    [
      launch('tu_fg', { description: 'Map the IPC', subagent_type: 'Explore' }),
      result('tu_fg', { status: 'completed', agentId: 'afg', totalDurationMs: 4100, totalTokens: 12000 }),
      launch('tu_bg', { description: 'Audit contrast', run_in_background: true }, '2026-11-13T10:01:00.000Z'),
      result('tu_bg', { isAsync: true, status: 'async_launched', agentId: 'abg' }, 'Async agent launched'),
      launch('tu_open', { description: 'Trace stop', run_in_background: true }, '2026-11-13T10:02:00.000Z'),
      result('tu_open', { isAsync: true, status: 'async_launched', agentId: 'aopen' }),
      // A Read of a file that quotes a notice is still a tool result.
      result('tu_read', null, [{ type: 'text', text: '<task-notification><tool-use-id>tu_open</tool-use-id><status>completed</status></task-notification>' }]),
      note('tu_bg', 'failed', '<usage><subagent_tokens>61000</subagent_tokens><tool_uses>3</tool_uses><duration_ms>160000</duration_ms></usage>'),
      launch('tu_rej', { description: 'Rejected one' }),
      result('tu_rej', 'User rejected tool use', 'User rejected tool use', true),
      JSON.stringify({ type: 'user', toolUseResult: { status: 'async_launched', taskId: 'w7', taskType: 'local_workflow', runId: 'wf_7', transcriptDir: join(dir, 'subagents', 'workflows', 'wf_7') }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_wf', content: 'Task ID: w7' }] } }),
      '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu_cut","name":"Agent"'
    ].join('\n')
  )
  const meta = (agentId: string, m: object): void => writeFileSync(join(dir, 'subagents', `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'Explore', spawnDepth: 1, requestShape: 'foreground', ...m }))
  meta('afg', { toolUseId: 'tu_fg', description: 'Map the IPC', finished: true })
  meta('abg', { toolUseId: 'tu_bg', description: 'Audit contrast', requestShape: 'background' })
  meta('aopen', { toolUseId: 'tu_open', description: 'Trace stop', requestShape: 'background' })
  meta('akid', { toolUseId: 'tu_kid', description: 'Read session.ts', spawnDepth: 2, finished: true })
  meta('alone', { toolUseId: 'tu_alone', description: 'Parent gone', spawnDepth: 2 })
  writeFileSync(join(dir, 'subagents', 'agent-bad.meta.json'), JSON.stringify({ toolUseId: '../x' }))
  writeFileSync(join(dir, 'subagents', 'agent-afg.jsonl'), [launch('tu_kid', { description: 'Read session.ts' }), result('tu_kid', { status: 'completed', agentId: 'akid', totalDurationMs: 41000, totalTokens: 12000 })].join('\n') + '\n')
  // A workflow agent's sidecar never lists.
  mkdirSync(join(dir, 'subagents', 'workflows', 'wf_7'), { recursive: true })
  writeFileSync(join(dir, 'subagents', 'workflows', 'wf_7', 'agent-awf.meta.json'), JSON.stringify({ toolUseId: 'tu_wfagent', description: 'wf agent' }))
  const rec = (taskId: string, runId: string, startTime: number, status: string): string =>
    JSON.stringify({ taskId, runId, workflowName: `wf ${taskId}`, status, startTime, result: 'big', summary: `Dynamic workflow "${taskId}" completed`, workflowProgress: [{ type: 'workflow_agent', index: 1, phaseIndex: 1, label: 'a', agentId: 'awf', state: 'done', tokens: 5 }] })
  writeFileSync(join(dir, 'workflows', 'wf_7.json'), rec('w7', 'wf_7', 20, 'completed'))
  writeFileSync(join(dir, 'workflows', 'wf_6.json'), rec('w6', 'wf_6', 10, 'running'))
  writeFileSync(join(dir, 'workflows', 'wf_x.json'), '{ not json')
  const prev = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = home
  try {
    const { agents, workflows } = await listRuns('s3')
    const by = new Map(agents.map((a) => [a.toolUseId, a]))
    const fg = by.get('tu_fg')
    ok(fg?.outcome === 'done' && fg.tokens === 12000 && fg.durationMs === 4100 && fg.subagentType === 'Explore' && fg.agentId === 'afg' && fg.startedAt === Date.parse('2026-11-13T10:00:00.000Z') && !fg.background, 'runs list: a foreground launch carries its result totals', JSON.stringify(fg))
    const bg = by.get('tu_bg')
    ok(bg?.outcome === 'failed' && bg.background && bg.tokens === 61000 && bg.durationMs === 160000, "runs list: a background launch ends with its notice's status and usage", JSON.stringify(bg))
    ok(by.get('tu_open')?.outcome === 'open', 'runs list: a background launch with no notice and an unfinished sidecar is open, and a quoted notice is not one')
    ok(by.get('tu_rej')?.outcome === 'stopped', 'runs list: a rejected launch reads stopped')
    const kid = by.get('tu_kid')
    ok(kid?.parent === 'tu_fg' && kid.outcome === 'done' && kid.tokens === 12000, "runs list: a nested launch comes from its parent's transcript", JSON.stringify(kid))
    const alone = by.get('tu_alone')
    ok(alone?.parent === undefined && alone.outcome === 'open' && alone.description === 'Parent gone' && agents[0] === alone, 'runs list: a sidecar no transcript launched lists first, at the top level')
    ok(!by.has('tu_cut') && !by.has('tu_wfagent') && !by.has('../x'), 'runs list: a cut-off record, a workflow agent and a bad sidecar are skipped')
    ok(agents.map((a) => a.toolUseId).join() === 'tu_alone,tu_fg,tu_bg,tu_open,tu_rej,tu_kid', 'runs list: launch order', agents.map((a) => a.toolUseId).join())
    ok(workflows.map((w) => w.taskId).join() === 'w6,w7' && workflows[1].agents[0]?.tokens === 5 && workflows.every((w) => w.result === undefined), 'runs list: workflow records oldest first, read without their results', JSON.stringify(workflows))
    ok(JSON.stringify(await listRuns('../s3')) === '{"agents":[],"workflows":[]}' && JSON.stringify(await listRuns('nope')) === '{"agents":[],"workflows":[]}', 'runs list: a bad or unknown session lists nothing')
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prev
  }
}
