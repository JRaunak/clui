// Boundary: the side chat's deny hook, run for real through /bin/sh with CLI-shaped hook input.
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SIDE_HOOK_SCRIPT, writeSideHook } from '../src/main/sessions/side-hook.ts'
import { equal, ok } from './support/harness.mjs'

// The loader stubs `node:child_process` for the transport tests; require bypasses it.
const { spawnSync } = createRequire(import.meta.url)('node:child_process') as typeof import('node:child_process')

const input = (tool_name: string, tool_input: unknown = {}): string =>
  JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 't' })
const viaScript = (stdin: string) => spawnSync('/bin/sh', ['-c', SIDE_HOOK_SCRIPT], { input: stdin, encoding: 'utf8' })
const denial = (name: string): string => `Side chat is read-only: ${name} is not available here.\n`

for (const t of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch']) {
  const r = viaScript(input(t, { file_path: '/x' }))
  ok(r.status === 0 && r.stderr === '', `side hook: ${t} runs`)
}
for (const t of ['Bash', 'Write', 'Agent', 'mcp__clui-surface__surface_open']) {
  const r = viaScript(input(t))
  ok(r.status === 2 && r.stderr === denial(t), `side hook: ${t} is denied by name`)
}
{
  const r = viaScript(input('Bash', { command: 'echo "\\"tool_name\\":\\"Read\\""' }))
  ok(r.status === 2 && r.stderr === denial('Bash'), 'side hook: a quoted tool_name inside a command stays Bash')
  const two = viaScript(input('Bash', { tool_name: 'Read' }))
  ok(two.status === 2 && two.stderr === denial('this tool'), 'side hook: an input with its own tool_name key denies')
}
{
  const pretty = (name: string): string => JSON.stringify(JSON.parse(input(name)), null, 2).replace('"tool_name":', '"tool_name" :\n ')
  equal(viaScript(pretty('Read')).status, 0, 'side hook: pretty-printed Read runs')
  const bash = viaScript(pretty('Bash'))
  ok(bash.status === 2 && bash.stderr === denial('Bash'), 'side hook: pretty-printed Bash is denied')
}
for (const [label, stdin] of [['empty input', ''], ['non-JSON', 'not json']]) {
  const r = viaScript(stdin)
  ok(r.status === 2 && r.stderr === denial('this tool'), `side hook: ${label} denies as "this tool"`)
}
{
  const dir = mkdtempSync(join(tmpdir(), "clui side 'hook-"))
  try {
    const cmd = await writeSideHook(dir)
    const run = (stdin: string) => spawnSync('/bin/sh', ['-c', cmd], { input: stdin, encoding: 'utf8' })
    equal(run(input('Read')).status, 0, 'side hook: the written command runs Read from a path with a space and a quote')
    const bash = run(input('Bash'))
    ok(bash.status === 2 && bash.stderr === denial('Bash'), 'side hook: and denies Bash')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
