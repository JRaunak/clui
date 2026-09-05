// Boundary: settings persistence + model reconciliation.
// Uses a fresh module instance per case (?v=) to reset the module-level cache.
import { writeFileSync, readFileSync } from 'node:fs'
import { app } from './support/electron-stub.mjs'
import { join } from 'node:path'
import { sameModel } from '../src/shared/settings.ts'
import { ok } from './support/harness.mjs'

const SP = join(app.getPath('userData'), 'settings.json')
let v = 0
const fresh = (): Promise<typeof import('../src/main/settings/store.ts')> =>
  import('../src/main/settings/store.ts?v=' + ++v)
const onDisk = (): any => JSON.parse(readFileSync(SP, 'utf8'))

ok(sameModel('provider-a', 'provider-b') === false, 'model: distinct unknown ids are not equal')
ok(sameModel('claude-opus-4-8', 'us.anthropic.claude-opus-4-8') === true, 'model: recognized prefixed/bare equivalent')
ok(sameModel('claude-opus-4-8[1m]', 'claude-opus-4-8') === false, 'model: 1m vs non-1m differ')

// off-enum values dropped
{
  writeFileSync(SP, JSON.stringify({ theme: 'garbage', permissionMode: 'garbage' }))
  const r = await (await fresh()).getResolvedSettings()
  ok(r.values.theme !== 'garbage', 'settings: invalid theme dropped')
  ok(r.values.permissionMode !== 'garbage', 'settings: invalid permissionMode dropped')
}

// a reset is not undone by the full-object patch
{
  writeFileSync(SP, JSON.stringify({ theme: 'light', schemaVersion: 1 }))
  const m = await fresh()
  await m.getResolvedSettings()
  await m.updateSettings({ theme: 'light', editorCommand: 'code' }, ['theme'])
  ok(!('theme' in onDisk()), 'settings: cleared theme absent on disk (reset not undone)')
}

// one-time legacy migration keeps newer fields + explicit picks
{
  writeFileSync(
    SP,
    JSON.stringify({
      cliPath: '', editorCommand: 'code', permissionMode: 'inherit', model: 'claude-opus-4-8[1m]',
      effort: 'high', defaultWorkspace: '', theme: 'dark', onboarded: true, sidebarCollapsed: true
    })
  )
  await (await fresh()).getResolvedSettings()
  const d = onDisk()
  ok(d.schemaVersion === 1, 'settings: migrated file stamped')
  ok(d.sidebarCollapsed === true, 'settings: newer field survives migration')
  ok(!('theme' in d), 'settings: legacy-default key dropped')
}
{
  writeFileSync(SP, JSON.stringify({ model: 'claude-opus-4-8[1m]' }))
  const r = await (await fresh()).getResolvedSettings()
  ok(r.values.model === 'claude-opus-4-8[1m]', 'settings: explicit pick in overrides-only file preserved')
}
