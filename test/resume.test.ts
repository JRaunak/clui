// A failed resume through the real beginSession.
import { useSession } from '../src/renderer/src/store.ts'
import { equal, ok } from './support/harness.mjs'

const replies: Record<string, () => unknown> = {
  getSettings: () => ({ values: { permissionMode: 'default', model: 'claude-haiku-4-5', effort: 'high', quickPermissionMode: 'default' } }),
  listModels: () => ({ ids: [] }),
  startSession: () => {
    throw new Error("Error invoking remote method 'clui:startSession': Error: spawn claude ENOENT ")
  }
}
;(globalThis as any).window = {
  addEventListener: () => {},
  clui: new Proxy({}, { get: (_t, name: string) => async () => (replies[name] ? replies[name]() : true) })
}

const stopped = { handleId: 'h1', cwd: '/tmp/w', sessionId: 'sess-1', exited: true, draftText: 'keep me', draftAttachments: [], contextRefs: [] }
useSession.setState({ sessions: { h1: stopped as any }, activeHandleId: 'h1', notice: null, sessionGroups: [] })
const st = useSession.getState

equal(await st().resumeSession('/tmp/w', 'sess-1'), null, 'resume failure: no handle')
const h1 = st().sessions.h1
ok(!!h1?.exited && h1.draftText === 'keep me' && Object.keys(st().sessions).length === 1, 'resume failure: the stopped slice and its draft stay')
const n = st().notice
ok(n?.message === "Couldn't resume this session. spawn claude ENOENT" && n.tone === 'error' && !n.action, 'resume failure: an error notice with the reason')
