// Boundary: the CLI transport (`ClaudeSession`) driven against a fake child.
// Covers reconnect, generation, and settlement.
import { ClaudeSession } from '../src/main/cli/session.ts'
import { ok } from './support/harness.mjs'

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
const mk = (opts: Record<string, unknown> = {}): ClaudeSession =>
  new ClaudeSession({ cliPath: 'claude', cwd: '/tmp', gated: true, model: 'orig', ...opts } as any)

// init flush + queue-before-ack
reset()
{
  const s = mk()
  s.start()
  const c = spawns()[0]
  s.send('hi')
  ok(!W(c).some((o: any) => o.type === 'user'), 'transport: user msg queued before init ACK')
  ackInit(c)
  ok(W(c).some((o: any) => o.type === 'user'), 'transport: queued msg flushed on ACK')
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
  s.send('during-reconnect')
  ok(!W(c1).some((o: any) => o.type === 'user'), 'transport: send during reconnect not written to ended stdin')
  c1.emit('close', 0)
  await tick()
  const c2 = spawns()[1]
  ok(!c2.spawnargs.includes('--fork-session'), 'transport: reconnect does not re-fork')
  ok(c2.spawnargs[c2.spawnargs.indexOf('--resume') + 1] === 'FORKED', 'transport: reconnect resumes the live id')
  ackInit(c2)
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
  ok((await p) === true, 'transport: setModel → true on success ACK')
  const p2 = s.setModel('bad')
  respond(c, 'set_model', 'error')
  ok((await p2) === false, 'transport: setModel → false on error ACK')
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

// the test MCP config rides alongside the browser's in one variadic --mcp-config
reset()
{
  const s = mk({ browserMcp: '{"mcpServers":{}}', mcpConfigPath: '/tmp/stub.json' })
  s.start()
  const a: string[] = spawns()[0].spawnargs
  const i = a.indexOf('--mcp-config')
  ok(i >= 0 && a[i + 2] === '/tmp/stub.json' && a.indexOf('--mcp-config', i + 1) === -1, 'transport: both MCP configs in one --mcp-config')
  s.stop()
}
