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
