// Boundary: the CLI transport (`ClaudeSession`) driven against a fake child.
// Covers reconnect, generation, settlement, and the child's env.
import { ClaudeSession, childEnv } from '../src/main/cli/session.ts'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { CHANGE_READ_TOOL } from '../src/shared/context.ts'
import { HOOKS_TOKEN } from '../src/shared/settings.ts'
import { SessionManager } from '../src/main/sessions/manager.ts'
import { equal, ok } from './support/harness.mjs'

equal(childEnv({ enableTaskTools: true }, { CLAUDE_CODE_ENABLE_TODO_TOOLS: '0' }).CLAUDE_CODE_ENABLE_TODO_TOOLS, '0', 'env: a shell task-tools value wins')
equal('CLAUDE_CODE_SESSION_ID' in childEnv({}, { CLAUDE_CODE_SESSION_ID: 'x' }), false, 'env: runtime markers are stripped')
equal(childEnv({}, { CLAUDE_CODE_AUTO_MODE_SERVER: '0' }).CLAUDE_CODE_AUTO_MODE_SERVER, '0', "env: the shell's own classifier choice passes through")

const spawns = (): any[] => (globalThis as any).__spawns__ || []
const reset = (): void => {
  ;(globalThis as any).__spawns__ = []
}
const W = (c: any): any[] => c.stdin.writes.map((w: string) => JSON.parse(w))
const initId = (c: any): string => W(c).find((o: any) => o.request?.subtype === 'initialize')?.request_id
const ackInit = (c: any, commands: unknown[] = []): void =>
  c.stdout.emit(
    'data',
    JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: initId(c), response: { commands } } }) + '\n'
  )
const respond = (c: any, subtype: string, sub: 'success' | 'error', payload?: object): void => {
  const id = W(c).filter((o: any) => o.request?.subtype === subtype).pop()?.request_id
  c.stdout.emit('data', JSON.stringify({ type: 'control_response', response: { subtype: sub, request_id: id, response: payload } }) + '\n')
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const prep = (text: string) => async (_uuid: string) => ({ ok: true as const, content: text, text })
const mk = (opts: Record<string, unknown> = {}): ClaudeSession =>
  new ClaudeSession({ cliPath: 'claude', cwd: '/tmp', gated: true, model: 'orig', ...opts } as any)

// init flush + queue-before-ack
reset()
{
  const s = mk()
  s.start()
  const c = spawns()[0]
  const sent = s.send(false, prep('hi'))
  await tick()
  ok(!W(c).some((o: any) => o.type === 'user'), 'transport: user msg queued before init ACK')
  ackInit(c)
  const r: any = await sent
  const env = W(c).find((o: any) => o.type === 'user')
  ok(!!env, 'transport: queued msg flushed on ACK')
  ok(r.ok && r.packetId === env?.uuid && r.text === 'hi' && r.joined === false, 'transport: the reply names the envelope uuid')
}

// One --settings carries ultracode and the write fence; a Quick session never gets the fence.
reset()
{
  const flags = (opts: Record<string, unknown>): string[] => {
    reset()
    mk(opts).start()
    const a: string[] = spawns()[0].spawnargs
    return a.flatMap((x, i) => (x === '--settings' ? [a[i + 1]] : []))
  }
  equal(
    JSON.stringify(flags({ ultracode: true, blockOutsideWrites: true })),
    JSON.stringify([JSON.stringify({ ultracode: true, permissions: { blockWritesOutsideWorkingDirectories: true } })]),
    'transport: ultracode and the fence merge into one --settings'
  )
  equal(flags({ blockOutsideWrites: true, ephemeral: true }).length, 0, 'transport: an ephemeral session gets no fence')
  equal(flags({}).length, 0, 'transport: no settings, no flag')
  equal(JSON.stringify(flags({ disabledConfig: ['hooks', 'mcp__a'] })), JSON.stringify([JSON.stringify({ disableAllHooks: true })]), 'transport: hooks off rides --settings')
}

// One --disallowedTools carries Quick's set and the switched-off config; hooks never lands in it.
reset()
{
  const argv = (opts: Record<string, unknown>): string[] => {
    reset()
    mk({ cluiMcp: { config: '{}', allow: ['x'] }, resumeSessionId: 'R', ...opts }).start()
    return spawns()[0].spawnargs
  }
  const a = argv({ ephemeral: true, disabledConfig: ['hooks', 'mcp__srv', 'Agent(rev)'] })
  equal(a.filter((x) => x === '--disallowedTools').length, 1, 'transport: one --disallowedTools')
  const list = a.slice(a.indexOf('--disallowedTools') + 1, a.indexOf('--mcp-config'))
  ok(list.includes('Task') && list.includes('mcp__srv') && list.includes('Agent(rev)') && !list.includes('hooks'), 'transport: it holds Quick tools and config tokens, not hooks')
  ok(list.every((x) => !x.startsWith('--')), 'transport: the next flag closes the list')
  const b = argv({ disabledConfig: ['Agent(rev)'] })
  equal(JSON.stringify(b.slice(b.indexOf('--disallowedTools') + 1, b.indexOf('--mcp-config'))), JSON.stringify(['Agent(rev)']), 'transport: a full session carries only its config tokens')
  ok(!argv({ disabledConfig: ['hooks'] }).includes('--disallowedTools'), 'transport: hooks alone adds no --disallowedTools')
}

// reconnect write-safety + fork one-shot
reset()
{
  const s = mk({ resumeSessionId: 'ORIG', fork: true })
  s.start()
  const c1 = spawns()[0]
  ok(c1.spawnargs.includes('--fork-session'), 'transport: first spawn forks')
  ackInit(c1)
  c1.stdout.emit('data', JSON.stringify({ type: 'system', subtype: 'init', session_id: 'FORKED', cwd: '/tmp', tools: [], model: 'orig' }) + '\n')
  s.setEffort('max')
  await tick()
  respond(c1, 'apply_flag_settings', 'error')
  await tick()
  const during = s.send(false, prep('during-reconnect'))
  await tick()
  ok(!W(c1).some((o: any) => o.type === 'user'), 'transport: send during reconnect not written to ended stdin')
  c1.emit('close', 0)
  await tick()
  const c2 = spawns()[1]
  ok(!c2.spawnargs.includes('--fork-session'), 'transport: reconnect does not re-fork')
  ok(c2.spawnargs[c2.spawnargs.indexOf('--resume') + 1] === 'FORKED', 'transport: reconnect resumes the live id')
  ackInit(c2)
  await during
  ok(W(c2).some((o: any) => o.type === 'user' && o.message.content === 'during-reconnect'), 'transport: queued send flushed to new child')
}

// A fork that respawns before its init reported an id forks the source again instead of resuming it.
reset()
{
  const s = mk({ resumeSessionId: 'ORIG', fork: true })
  s.start()
  const c1 = spawns()[0]
  ackInit(c1)
  s.setEffort('max')
  await tick()
  respond(c1, 'apply_flag_settings', 'error')
  await tick()
  c1.emit('close', 0)
  await tick()
  const c2 = spawns()[1]
  ok(c2.spawnargs[c2.spawnargs.indexOf('--resume') + 1] === 'ORIG' && c2.spawnargs.includes('--fork-session'), 'transport: a pre-init fork respawn re-forks the source')
  s.stop()
}

// background_tasks false payload
reset()
{
  const s = mk()
  s.start()
  const c = spawns()[0]
  ackInit(c)
  const p = s.backgroundTask('t1')
  respond(c, 'background_tasks', 'success', { backgrounded: false })
  ok((await p) === false, 'transport: background_tasks success+backgrounded:false → false')
}

// setModel commits only on success ACK
reset()
{
  const s = mk()
  s.start()
  const c = spawns()[0]
  ackInit(c)
  const p = s.setModel('new')
  respond(c, 'set_model', 'success')
  ok((await p).ok, 'transport: setModel → ok on success ACK')
  const p2 = s.setModel('bad')
  const id = W(c).filter((o: any) => o.request?.subtype === 'set_model').pop()?.request_id
  const error = 'API error: 400 The provided model identifier is invalid · model not changed'
  c.stdout.emit('data', JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: id, error, error_code: 'check_rejected' } }) + '\n')
  const r2 = await p2
  ok(!r2.ok && r2.errorCode === 'check_rejected' && r2.reason === error && !r2.timedOut, 'transport: setModel error ACK carries the code and reason')
}

// Leaving a model that takes no effort re-sends the stored effort, clamped to the new model
reset()
{
  const s = mk({ model: 'claude-haiku-4-5-20251001', effort: 'xhigh' })
  s.start()
  const c = spawns()[0]
  ackInit(c)
  const p = s.setModel('claude-sonnet-4-6')
  respond(c, 'set_model', 'success')
  await tick()
  respond(c, 'apply_flag_settings', 'success')
  ok((await p).ok, 'transport: regained-effort switch succeeds')
  const sent = W(c).filter((o: any) => o.request?.subtype === 'apply_flag_settings')
  ok(sent.length === 1 && sent[0].request.settings.effortLevel === 'high', 'transport: stored effort re-sent, clamped')
  await s.setEffort('high')
  ok(W(c).filter((o: any) => o.request?.subtype === 'apply_flag_settings').length === 1, 'transport: the follow-up setEffort no-ops')
  const p2 = s.setModel('claude-opus-5-5')
  respond(c, 'set_model', 'success')
  await p2
  ok(W(c).filter((o: any) => o.request?.subtype === 'apply_flag_settings').length === 1, 'transport: effort-to-effort switch sends no effort')
}

// init error ACK tears down instead of hanging
reset()
{
  const events: string[] = []
  const s = mk()
  s.on('event', (e) => events.push(e.type))
  s.start()
  const c = spawns()[0]
  c.stdout.emit('data', JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: initId(c) } }) + '\n')
  ok(events.includes('error') && events.includes('process-exit'), 'transport: init error ACK → error + exit')
}

// an open elicitation is answered `cancel` on interrupt and on stop, and its card is withdrawn
reset()
{
  const s = mk()
  const events: any[] = []
  s.on('event', (e) => events.push(e))
  s.start()
  const c = spawns()[0]
  ackInit(c)
  const elicit = (id: string): void =>
    c.stdout.emit('data', JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'elicitation', mcp_server_name: 'stub', message: 'Sign in', mode: 'url', url: 'https://example.com' } }) + '\n')
  const answers = (): any[] => W(c).filter((o: any) => o.type === 'control_response').map((o: any) => [o.response.request_id, o.response.response.action])
  elicit('e1')
  elicit('e2')
  s.respondElicitation('e1', { action: 'accept' })
  s.interrupt()
  ok(JSON.stringify(answers()) === '[["e1","accept"],["e2","cancel"]]', 'transport: interrupt cancels only the unanswered elicitation')
  ok(events.some((e) => e.type === 'permission-cancel' && e.requestId === 'e2'), 'transport: interrupt withdraws the open card')
  const cancelIdx = W(c).findIndex((o: any) => o.type === 'control_response' && o.response.request_id === 'e2')
  const intIdx = W(c).findIndex((o: any) => o.request?.subtype === 'interrupt')
  ok(cancelIdx >= 0 && cancelIdx < intIdx, 'transport: the cancel is written before the interrupt')
  s.interrupt()
  ok(answers().length === 2, 'transport: a second interrupt answers nothing twice')
  elicit('e3')
  s.stop()
  ok(answers().at(-1)?.[0] === 'e3' && answers().at(-1)?.[1] === 'cancel', 'transport: stop cancels an open elicitation')
}

// the test MCP config rides alongside Clui's in one variadic --mcp-config
reset()
{
  const s = mk({ cluiMcp: { config: '{"mcpServers":{}}', allow: [CHANGE_READ_TOOL] }, mcpConfigPath: '/tmp/stub.json' })
  s.start()
  const a: string[] = spawns()[0].spawnargs
  const i = a.indexOf('--mcp-config')
  ok(i >= 0 && a[i + 2] === '/tmp/stub.json' && a.indexOf('--mcp-config', i + 1) === -1, 'transport: both MCP configs in one --mcp-config')
  s.stop()
}

// The allow rules: the surface tool alone without the browser, the browser server after it with it. Each list
// ends at the next flag or at the end of argv.
reset()
{
  const allowed = (allow: string[], resume?: string): string[] => {
    const s = mk({ cluiMcp: { config: '{"mcpServers":{}}', allow }, ...(resume ? { resumeSessionId: resume } : {}) })
    s.start()
    const a: string[] = spawns().at(-1).spawnargs
    s.stop()
    const i = a.indexOf('--allowedTools')
    const end = a.findIndex((x, k) => k > i && x.startsWith('--'))
    return i < 0 ? [] : a.slice(i + 1, end < 0 ? undefined : end)
  }
  equal(allowed([CHANGE_READ_TOOL]).join(' '), 'mcp__clui-surface__change_read', 'transport: the surface allow rule alone, tool-level')
  equal(allowed([CHANGE_READ_TOOL, 'mcp__clui-browser'], 'S').join(' '), 'mcp__clui-surface__change_read mcp__clui-browser', 'transport: the browser rule after it, closed by --resume')
}

// One 0600 config file holds both servers, and an effort respawn writes the same contents again.
reset()
{
  const config = JSON.stringify({ mcpServers: { 'clui-surface': { type: 'http', url: 'u1' }, 'clui-browser': { type: 'http', url: 'u2' } } })
  const s = mk({ cluiMcp: { config, allow: [CHANGE_READ_TOOL] } })
  s.start()
  const c1 = spawns()[0]
  const file = (c: any): string => c.spawnargs[c.spawnargs.indexOf('--mcp-config') + 1]
  ok(c1.spawnargs.filter((x: string) => x === '--mcp-config').length === 1 && readFileSync(file(c1), 'utf8') === config, 'transport: one config file with both servers')
  equal(statSync(file(c1)).mode & 0o777, 0o600, 'transport: the config is 0600')
  ackInit(c1)
  c1.stdout.emit('data', JSON.stringify({ type: 'system', subtype: 'init', session_id: 'S', cwd: '/tmp', tools: [], model: 'orig' }) + '\n')
  s.setEffort('max')
  await tick()
  respond(c1, 'apply_flag_settings', 'error')
  await tick()
  c1.emit('close', 0)
  await tick()
  const c2 = spawns()[1]
  ok(!!c2 && readFileSync(file(c2), 'utf8') === config, 'transport: an effort respawn reuses the same config contents')
  s.stop()
}

// The appended prompt: one 0600 file flag ahead of the first variadic flag, gone once the CLI has read it, written again on a respawn.
reset()
{
  const cluiMcp = { config: '{"mcpServers":{}}', allow: [CHANGE_READ_TOOL] }
  const flag = '--append-system-prompt-file'
  const file = (c: any): string => c.spawnargs[c.spawnargs.indexOf(flag) + 1]
  const s = mk({ cluiMcp, appendSystemPrompt: 'BLOCK' })
  s.start()
  const c1 = spawns()[0]
  const a: string[] = c1.spawnargs
  ok(a.filter((x) => x === flag).length === 1 && a.indexOf(flag) < a.indexOf('--mcp-config'), 'transport: one append flag, before --mcp-config')
  equal(readFileSync(file(c1), 'utf8'), 'BLOCK', 'transport: the append file holds the text')
  equal(statSync(file(c1)).mode & 0o777, 0o600, 'transport: the append file is 0600')
  ackInit(c1)
  c1.stdout.emit('data', JSON.stringify({ type: 'system', subtype: 'init', session_id: 'S', cwd: '/tmp', tools: [], model: 'orig' }) + '\n')
  ok(!existsSync(file(c1)), 'transport: the append file is removed after init')
  s.setEffort('max')
  await tick()
  respond(c1, 'apply_flag_settings', 'error')
  await tick()
  c1.emit('close', 0)
  await tick()
  const c2 = spawns()[1]
  equal(readFileSync(file(c2), 'utf8'), 'BLOCK', 'transport: an effort respawn passes the same text')
  s.stop()
  ok(!existsSync(file(c2)), 'transport: stop removes the append file')

  const args = (opts: Record<string, unknown>): string[] => {
    reset()
    const t = mk({ cluiMcp, ...opts })
    t.start()
    t.stop()
    return spawns()[0].spawnargs
  }
  const q = args({ appendSystemPrompt: 'Q', ephemeral: true })
  ok(q.indexOf(flag) >= 0 && q.indexOf(flag) < q.indexOf('--disallowedTools'), 'transport: Quick puts it before --disallowedTools')
  ok(!args({}).includes(flag), 'transport: no text, no flag')
}

// onWritten: once, right after its envelope is written; never for a send that wasn't.
reset()
{
  const s = mk()
  s.start()
  const c = spawns()[0]
  ackInit(c)
  const seen: string[] = []
  const r: any = await s.send(false, async (uuid) => ({
    ok: true,
    content: 'x',
    text: 'x',
    onWritten: () => seen.push(`${uuid}:${W(c).filter((o: any) => o.type === 'user' && o.uuid === uuid).length}`)
  }))
  equal(seen.join(), `${r.packetId}:1`, 'transport: onWritten runs once, after the envelope is written')
  const stopped = mk()
  stopped.start()
  const c2 = spawns()[1]
  let ran = 0
  const sent = stopped.send(false, async () => ({ ok: true, content: 'y', text: 'y', onWritten: () => ran++ }))
  stopped.interrupt()
  ackInit(c2)
  ok(((await sent) as any).reason === 'cancelled' && ran === 0, 'transport: a cancelled send never runs onWritten')
}

// One outbox: a slow first prepare can't let the second message overtake it.
reset()
{
  const s = mk()
  s.start()
  const c = spawns()[0]
  ackInit(c)
  let release!: () => void
  const slow = s.send(false, async () => {
    await new Promise<void>((r) => (release = r))
    return { ok: true, content: 'first', text: 'first' }
  })
  const fast = s.send(false, prep('second'))
  await tick()
  ok(!W(c).some((o: any) => o.type === 'user'), 'transport: the second message waits for the first prepare')
  release()
  await Promise.all([slow, fast])
  ok(W(c).filter((o: any) => o.type === 'user').map((o: any) => o.message.content).join() === 'first,second', 'transport: messages write in send order')
}

// A Stop before the init ACK cancels what hasn't been written.
reset()
{
  const s = mk()
  s.start()
  const c = spawns()[0]
  const sent = s.send(false, prep('stopped'))
  s.interrupt()
  ackInit(c)
  const r: any = await sent
  ok(r.ok === false && r.reason === 'cancelled' && !W(c).some((o: any) => o.type === 'user'), 'transport: interrupt before init ACK cancels the send')
}

// A reconnect during prepare re-prepares against the new child, and the uuid is the packetId in the text.
reset()
{
  const s = mk({ resumeSessionId: 'ORIG' })
  s.start()
  const c1 = spawns()[0]
  ackInit(c1)
  c1.stdout.emit('data', JSON.stringify({ type: 'system', subtype: 'init', session_id: 'S', cwd: '/tmp', tools: [], model: 'orig' }) + '\n')
  const uuids: string[] = []
  const written: string[] = []
  let first = true
  let release!: () => void
  const sent = s.send(false, async (uuid) => {
    uuids.push(uuid)
    if (first) {
      first = false
      await new Promise<void>((r) => (release = r))
    }
    return { ok: true, content: `id ${uuid}`, text: `id ${uuid}`, onWritten: () => written.push(uuid) }
  })
  await tick()
  s.setEffort('max')
  await tick()
  respond(c1, 'apply_flag_settings', 'error')
  await tick()
  release()
  await tick()
  c1.emit('close', 0)
  await tick()
  const c2 = spawns()[1]
  ackInit(c2)
  const r: any = await sent
  const env = W(c2).find((o: any) => o.type === 'user')
  ok(uuids.length === 2 && !W(c1).some((o: any) => o.type === 'user'), 'transport: a reconnect during prepare prepares again and skips the old child')
  ok(env && env.uuid === r.packetId && env.message.content === `id ${env.uuid}`, 'transport: the envelope uuid is the packetId in its text')
  ok(written.length === 1 && written[0] === env?.uuid && written[0] === uuids[1], "transport: only the second preparation's onWritten runs, with the uuid written")
}

// Send now joins an open turn and arms the cut; with no turn open it starts one.
reset()
{
  const s = mk()
  s.start()
  const c = spawns()[0]
  ackInit(c)
  const r: any = await s.send(true, prep('now'))
  ok(r.ok && r.joined === false, 'transport: send now with no open turn starts one')
}

// A side fork is the parent's launch plus the fork, no-persistence, mode and deny-hook flags, and nothing else.
reset()
{
  const parent = { model: 'claude-haiku-4-5', effort: 'low', ultracode: true, appendSystemPrompt: 'APPEND', disabledConfig: ['Agent(x)'], cluiMcp: { config: '{"mcpServers":{}}', allow: ['mcp__clui-browser'] }, name: 'p' }
  const launch = (opts: Record<string, unknown>): { args: string[]; files: string[] } => {
    reset()
    mk(opts).start()
    const args: string[] = spawns()[0].spawnargs
    const at = (flag: string): string => readFileSync(args[args.indexOf(flag) + 1], 'utf8')
    return { args, files: [at('--append-system-prompt-file'), at('--mcp-config')] }
  }
  const after = (args: string[], flag: string, n = 1): string => JSON.stringify(args.slice(args.indexOf(flag) + 1, args.indexOf(flag) + 1 + n))
  const p = launch(parent)
  const { name: _name, ...base } = parent
  const sideOpts = { ...base, resumeSessionId: 's', fork: true, permissionMode: 'default', side: { hook: '/bin/sh /x' } }
  const sd = launch(sideOpts)
  const a = sd.args
  ok(a.includes('--no-session-persistence') && after(a, '--permission-mode') === '["default"]', 'side argv: no persistence and an explicit mode')
  equal(JSON.stringify(a.slice(-3)), '["--resume","s","--fork-session"]', 'side argv: the fork closes the argv')
  ok(!a.includes('-n') && !a.includes('--tools') && !a.includes('--strict-mcp-config'), 'side argv: no name, no tool list, no strict MCP')
  equal(a.filter((x) => x === '--settings').length, 1, 'side argv: one --settings')
  const settings = JSON.parse(a[a.indexOf('--settings') + 1])
  ok(settings.ultracode === true && !('disableAllHooks' in settings), "side argv: the settings keep the parent's ultracode and never disable hooks")
  equal(JSON.stringify(settings.hooks.PreToolUse[0]), JSON.stringify({ matcher: '*', hooks: [{ type: 'command', command: '/bin/sh /x' }] }), 'side argv: the deny hook runs on every tool')
  for (const flag of ['--model', '--effort', '--disallowedTools', '--allowedTools'])
    equal(after(a, flag), after(p.args, flag), `side argv: ${flag} matches the parent's`)
  ok(!a.includes('Task'), 'side argv: none of Quick’s withheld tools')
  equal(JSON.stringify(sd.files), JSON.stringify(p.files), "side argv: the appended prompt and MCP config hold the parent's text")
  reset()
  let threw = false
  try {
    mk({ ...sideOpts, disabledConfig: ['Agent(x)', HOOKS_TOKEN] }).start()
  } catch {
    threw = true
  }
  ok(threw && !spawns().length, 'side argv: a side launched with hooks off never spawns')
}

// The initialize ACK reports the session ready, with the provider when the CLI names one.
reset()
{
  const ready = (response: object): any[] => {
    reset()
    const s = mk()
    const seen: any[] = []
    s.on('event', (e) => e.type === 'session-ready' && seen.push(e))
    s.start()
    const c = spawns()[0]
    c.stdout.emit('data', JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: initId(c), response } }) + '\n')
    return seen
  }
  equal(JSON.stringify(ready({ account: { apiProvider: 'bedrock' } })), '[{"type":"session-ready","provider":"bedrock"}]', 'ready: the ACK names its provider')
  equal(JSON.stringify(ready({})), '[{"type":"session-ready"}]', 'ready: an ACK without an account still reports ready')
  equal(JSON.stringify(ready({ account: { apiProvider: 'nope' } })), '[{"type":"session-ready"}]', 'ready: an unknown provider is dropped')
}

// A verdict reaches the CLI as behavior plus its input or message, whatever else the renderer sent.
reset()
{
  const m = new SessionManager(() => {}, () => {})
  m.start('h', { cliPath: 'claude', cwd: '/tmp', gated: true })
  const c = spawns()[0]
  const last = (): any => W(c).at(-1).response.response
  m.respondPermission('h', { requestId: 'r1', behavior: 'allow', updatedInput: { a: 1 }, updatedPermissions: [{ type: 'setMode' }] } as any)
  equal(JSON.stringify(last()), '{"behavior":"allow","updatedInput":{"a":1}}', 'verdict: an allow carries only its input')
  m.respondPermission('h', { requestId: 'r2', behavior: 'deny', message: 'no', interrupt: true } as any)
  equal(JSON.stringify(last()), '{"behavior":"deny","message":"no"}', 'verdict: a deny carries only its message')
  m.stopAll()
}
