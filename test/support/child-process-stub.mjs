// Controllable `node:child_process` stand-in for transport tests: `spawn` returns a fake
// child whose stdin captures writes and whose stdout/stderr/close can be driven by the test.
// Created children are pushed to `globalThis.__spawns__` for the test to reach.
import { EventEmitter } from 'node:events'

class FakeStdin extends EventEmitter {
  writable = true
  destroyed = false
  writes = []
  write(s) {
    if (!this.writable) {
      const e = new Error('write after end')
      e.code = 'ERR_STREAM_WRITE_AFTER_END'
      queueMicrotask(() => this.emit('error', e))
      return false
    }
    this.writes.push(s)
    return true
  }
  end() {
    this.writable = false
  }
}

class FakeChild extends EventEmitter {
  constructor(args) {
    super()
    this.spawnargs = args
    this.stdin = new FakeStdin()
    this.stdout = Object.assign(new EventEmitter(), { setEncoding() {} })
    this.stderr = Object.assign(new EventEmitter(), { setEncoding() {} })
    this.exitCode = null
    this.signalCode = null
  }
  kill() {
    return true
  }
}

export function spawn(_cmd, args) {
  const c = new FakeChild(args)
  ;(globalThis.__spawns__ = globalThis.__spawns__ || []).push(c)
  return c
}

// Not exercised by the transport tests, but shell-env imports it. A callback-style stub
// that reports failure keeps `promisify(execFile)` happy without spawning anything.
export function execFile(_file, _args, _opts, cb) {
  const done = typeof cb === 'function' ? cb : typeof _opts === 'function' ? _opts : () => {}
  queueMicrotask(() => done(new Error('execFile stubbed in tests'), '', ''))
}

export default { spawn, execFile }
