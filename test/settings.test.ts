// Boundary: settings persistence + model reconciliation.
// Uses a fresh module instance per case (?v=) to reset the module-level cache.
import { writeFileSync, readFileSync } from 'node:fs'
import { app } from './support/electron-stub.mjs'
import { join } from 'node:path'
import {
  sameModel,
  clampEffort,
  cappedEffort,
  supportsUltracodeToggle,
  supports1m,
  contextSizeLabel,
  reconcileModelChoice,
  effortLabel
} from '../src/shared/settings.ts'
import { ok } from './support/harness.mjs'

const SP = join(app.getPath('userData'), 'settings.json')
let v = 0
const fresh = (): Promise<typeof import('../src/main/settings/store.ts')> =>
  import('../src/main/settings/store.ts?v=' + ++v)
const onDisk = (): any => JSON.parse(readFileSync(SP, 'utf8'))

ok(sameModel('provider-a', 'provider-b') === false, 'model: distinct unknown ids are not equal')
ok(sameModel('claude-opus-4-8', 'us.anthropic.claude-opus-4-8') === true, 'model: recognized prefixed/bare equivalent')
ok(sameModel('claude-opus-4-8[1m]', 'claude-opus-4-8') === false, 'model: 1m vs non-1m differ')

// supports1m: the verified 1M set (Fable 5+, Opus 4.6+, Sonnet 4.6+); everything else 200K
ok(supports1m('opus', 4.6) === true, 'supports1m: opus 4.6 is 1M')
ok(supports1m('opus', 4.5) === false, 'supports1m: opus 4.5 is 200K')
ok(supports1m('sonnet', 4.6) === true, 'supports1m: sonnet 4.6 is 1M')
ok(supports1m('sonnet', 4.5) === false, 'supports1m: sonnet 4.5 is 200K')
ok(supports1m('fable', 5) === true, 'supports1m: fable 5 is 1M')
ok(supports1m('fable', 4) === false, 'supports1m: fable 4 is 200K')
ok(supports1m('haiku', 4.5) === false, 'supports1m: no haiku is 1M')

// contextSizeLabel: derived from the window, never hardcoded
ok(contextSizeLabel('claude-opus-4-8[1m]') === '1M', 'contextSizeLabel: [1m] → 1M')
ok(contextSizeLabel('claude-opus-4-8') === '200K', 'contextSizeLabel: base → 200K')
ok(contextSizeLabel('claude-haiku-4-5') === '200K', 'contextSizeLabel: haiku → 200K')
ok(contextSizeLabel('us.anthropic.claude-haiku-5-5') === '1M', 'contextSizeLabel: Haiku 5.5 is natively 1M')
ok(supports1m('haiku', 5.5) === false, 'supports1m: Haiku 5.5 takes no [1m] suffix')
ok(supportsUltracodeToggle('us.anthropic.claude-haiku-5-5'), 'supportsUltracodeToggle: Haiku 5.5 has an xhigh tier')
ok(clampEffort('us.anthropic.claude-haiku-5-5', 'max') === 'max', 'clampEffort: Haiku 5.5 keeps max')
ok(clampEffort('claude-haiku-4-5', 'max') === 'high', 'clampEffort: Haiku 4.5 still tops out at high')

// reconcile: a stored/kept BASE id of a supports1m model resolves to the [1m] picker entry
{
  const listed = ['us.anthropic.claude-opus-4-8[1m]', 'us.anthropic.claude-haiku-4-5']
  ok(
    reconcileModelChoice('us.anthropic.claude-opus-4-8', 'claude-opus-4-8', listed) ===
      'us.anthropic.claude-opus-4-8[1m]',
    'reconcile: kept base 1M model adopts the list [1m] entry'
  )
  ok(
    reconcileModelChoice('us.anthropic.claude-sonnet-5', 'claude-opus-4-8', listed) ===
      'us.anthropic.claude-opus-4-8[1m]',
    'reconcile: reported base 1M model (no direct list match) adopts the [1m] entry'
  )
  ok(
    reconcileModelChoice('claude-opus-4-8', 'claude-opus-4-8', []) === 'claude-opus-4-8[1m]',
    'reconcile: empty list synthesizes the [1m] suffix so the size still reads 1M'
  )
  ok(
    reconcileModelChoice('us.anthropic.claude-haiku-4-5', 'claude-haiku-4-5', listed) ===
      'us.anthropic.claude-haiku-4-5',
    'reconcile: a 200K model is left untouched'
  )
  ok(
    reconcileModelChoice('claude-opus-4-8[1m]', 'claude-opus-4-8[1m]', listed) ===
      'claude-opus-4-8[1m]',
    'reconcile: an already-[1m] choice is unchanged'
  )
}

// cappedEffort: no cap → byte-identical to clampEffort (the no-regression guarantee)
for (const ef of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
  ok(
    cappedEffort('claude-opus-4-8[1m]', ef) === clampEffort('claude-opus-4-8[1m]', ef),
    `cappedEffort: no cap matches clampEffort (${ef})`
  )
}
// cap floors the request below the ask; a cap above the ask is a no-op
ok(cappedEffort('claude-opus-4-8[1m]', 'max', 'low') === 'low', 'cappedEffort: max asked, low cap → low')
ok(cappedEffort('claude-opus-4-8[1m]', 'medium', 'xhigh') === 'medium', 'cappedEffort: cap above ask is a no-op')
// cap still clamps to what the model supports (haiku tops out at high)
ok(cappedEffort('claude-haiku-4-5', 'max', 'xhigh') === 'high', 'cappedEffort: model support still clamps under a cap')

// The model is the only ultra gate; a cap never is.
ok(supportsUltracodeToggle('claude-opus-5-5[1m]'), 'supportsUltracodeToggle: opus 5.5 can run ultra')
ok(!supportsUltracodeToggle('claude-haiku-4-5'), 'supportsUltracodeToggle: haiku cannot run ultra')

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
// The browser switch is read at every spawn: off by default, a non-boolean never turns it on,
// and switching it back off leaves no key behind.
{
  writeFileSync(SP, JSON.stringify({ schemaVersion: 1, onboarded: true, browserEnabled: 'yes' }))
  const m = await fresh()
  ok((await m.getResolvedSettings()).values.browserEnabled === false, 'settings: invalid browserEnabled falls back to off')
  await m.updateSettings({ browserEnabled: true })
  ok(onDisk().browserEnabled === true, 'settings: browserEnabled on is persisted')
  ok((await (await fresh()).getResolvedSettings()).values.browserEnabled === true, 'settings: browserEnabled survives a reload')
  await m.updateSettings({ browserEnabled: false })
  ok(!('browserEnabled' in onDisk()), 'settings: browserEnabled off is pruned to the default')
}
// Agent effort reads in the composer's words; a level a CLI bump adds shows raw rather than vanishing.
ok(effortLabel('xhigh') === 'X-High', 'settings: effortLabel maps a known level')
ok(effortLabel('turbo') === 'turbo', 'settings: effortLabel passes an unknown level through')
