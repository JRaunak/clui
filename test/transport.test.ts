// Boundary: the CLI transport (`ClaudeSession`) driven against a fake child.
// Covers reconnect, generation, and settlement.
import { ClaudeSession } from '../src/main/cli/session.ts'
import { readFileSync, statSync } from 'node:fs'
import { CHANGE_READ_TOOL } from '../src/shared/context.ts'
import { equal, ok } from './support/harness.mjs'

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
