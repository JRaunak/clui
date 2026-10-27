// Boundary: settings persistence + model reconciliation.
// Uses a fresh module instance per case (?v=) to reset the module-level cache.
import { writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { app } from './support/electron-stub.mjs'
import { join } from 'node:path'
import {
  sameModel,
  clampEffort,
  cappedEffort,
  supportsUltracodeToggle,
  takes1mSuffix,
  effortsFromCatalog,
  setLiveEfforts,
  contextSizeLabel,
  reconcileModelChoice,
  effortLabel,
  deriveModelInfo,
  modelCheckReason,
  DEFAULT_SETTINGS,
  type CluiSettings,
  type ResolvedSettings,
  type SettingsKey
} from '../src/shared/settings.ts'
import {
  rebaseDraft,
  editDraft,
  resetDraft,
  draftPatch,
  draftValues,
  isDirty,
  isOverridden
} from '../src/renderer/src/components/settings/draft.ts'
import { equal, ok } from './support/harness.mjs'

const SP = join(app.getPath('userData'), 'settings.json')
let v = 0
const fresh = (): Promise<typeof import('../src/main/settings/store.ts')> =>
  import('../src/main/settings/store.ts?v=' + ++v)
const onDisk = (): any => JSON.parse(readFileSync(SP, 'utf8'))

ok(sameModel('provider-a', 'provider-b') === false, 'model: distinct unknown ids are not equal')
ok(sameModel('claude-opus-4-8', 'us.anthropic.claude-opus-4-8') === true, 'model: recognized prefixed/bare equivalent')
ok(sameModel('claude-sonnet-4-6[1m]', 'claude-sonnet-4-6') === false, 'model: a suffix model at 1M and 200K differ')
ok(sameModel('claude-opus-5-5[1m]', 'us.anthropic.claude-opus-5-5') === true, 'model: a native-1M model is the same with or without [1m]')

// takes1mSuffix: only Opus 4.6 and Sonnet 4.6 reach 1M through the suffix
ok(takes1mSuffix('opus', 4.6) && takes1mSuffix('sonnet', 4.6), 'takes1mSuffix: the 4.6 models')
ok(!takes1mSuffix('opus', 4.7) && !takes1mSuffix('sonnet', 5) && !takes1mSuffix('fable', 5) && !takes1mSuffix('haiku', 5.5), 'takes1mSuffix: native-1M models take none')
ok(!takes1mSuffix('opus', 4.5) && !takes1mSuffix('haiku', 4.5), 'takes1mSuffix: 200K models take none')

// contextSizeLabel: derived from the window, never hardcoded
ok(contextSizeLabel('claude-sonnet-4-6[1m]') === '1M', 'contextSizeLabel: [1m] → 1M')
ok(contextSizeLabel('claude-sonnet-4-6') === '200K', 'contextSizeLabel: a suffix model at its base → 200K')
ok(contextSizeLabel('claude-opus-4-6') === '200K', 'contextSizeLabel: Opus 4.6 base → 200K')
ok(contextSizeLabel('us.anthropic.claude-opus-4-7') === '1M', 'contextSizeLabel: Opus 4.7 is natively 1M')
ok(contextSizeLabel('us.anthropic.claude-sonnet-5') === '1M', 'contextSizeLabel: Sonnet 5 is natively 1M')
ok(contextSizeLabel('claude-fable-5-1') === '1M', 'contextSizeLabel: Fable is natively 1M')
ok(contextSizeLabel('claude-haiku-4-5') === '200K', 'contextSizeLabel: haiku → 200K')
ok(contextSizeLabel('us.anthropic.claude-haiku-5-5') === '1M', 'contextSizeLabel: Haiku 5.5 is natively 1M')
ok(supportsUltracodeToggle('us.anthropic.claude-haiku-5-5'), 'supportsUltracodeToggle: Haiku 5.5 has an xhigh tier')
ok(clampEffort('us.anthropic.claude-haiku-5-5', 'max') === 'max', 'clampEffort: Haiku 5.5 keeps max')
ok(clampEffort('claude-haiku-4-5-20251001', 'max') === 'max', 'clampEffort: Haiku 4.5 takes no effort, so the stored one is kept')
ok(clampEffort('claude-sonnet-4-6', 'max') === 'max', 'clampEffort: Sonnet 4.6 keeps max')
ok(clampEffort('claude-sonnet-4-6', 'xhigh') === 'high', 'clampEffort: Sonnet 4.6 clamps xhigh to high')
ok(deriveModelInfo('haiku').efforts.length === 0, 'effortsFor: the bare haiku alias takes no effort')
ok(deriveModelInfo('claude-haiku-4-5-20251001').efforts.length === 0, 'effortsFor: Haiku 4.5 takes no effort')
ok(deriveModelInfo('us.anthropic.claude-haiku-5-5').efforts.length === 5, 'effortsFor: Haiku 5.5 takes low..max')

// modelCheckReason: only the readable part of a check_rejected reply reaches the user
equal(modelCheckReason('API error: 400 The provided model identifier is invalid · model not changed'), 'The provided model identifier is invalid.', 'modelCheckReason: strips the API prefix and the suffix')
equal(modelCheckReason('model is not enabled for this account'), 'Model is not enabled for this account.', 'modelCheckReason: a bare reason only gains a capital and a period')
equal(modelCheckReason('Already done!'), 'Already done!', 'modelCheckReason: keeps existing end punctuation')
equal(modelCheckReason(''), null, 'modelCheckReason: empty → null')
equal(modelCheckReason(undefined), null, 'modelCheckReason: undefined → null')
equal(modelCheckReason('{"type":"error"}'), null, 'modelCheckReason: a raw JSON body → null')
equal(modelCheckReason('API error: 500 <html>oops</html>'), null, 'modelCheckReason: a raw HTML body → null')
equal(modelCheckReason('x'.repeat(200)), null, 'modelCheckReason: an over-long reason → null')

// reconcile: a stored/kept BASE id of a suffix model resolves to the [1m] picker entry
{
  const listed = ['us.anthropic.claude-sonnet-4-6[1m]', 'us.anthropic.claude-opus-5-5', 'us.anthropic.claude-haiku-4-5']
  ok(
    reconcileModelChoice('us.anthropic.claude-sonnet-4-6', 'claude-sonnet-4-6', listed) ===
      'us.anthropic.claude-sonnet-4-6[1m]',
    'reconcile: kept base suffix model adopts the list [1m] entry'
  )
  ok(
    reconcileModelChoice('us.anthropic.claude-sonnet-5', 'claude-sonnet-4-6', listed) ===
      'us.anthropic.claude-sonnet-4-6[1m]',
    'reconcile: reported base suffix model (no direct list match) adopts the [1m] entry'
  )
  ok(
    reconcileModelChoice('claude-sonnet-4-6', 'claude-sonnet-4-6', []) === 'claude-sonnet-4-6[1m]',
    'reconcile: empty list synthesizes the [1m] suffix so the size still reads 1M'
  )
  ok(
    reconcileModelChoice('us.anthropic.claude-haiku-4-5', 'claude-haiku-4-5', listed) ===
      'us.anthropic.claude-haiku-4-5',
    'reconcile: a 200K model is left untouched'
  )
  ok(
    reconcileModelChoice('claude-sonnet-4-6[1m]', 'claude-sonnet-4-6[1m]', listed) ===
      'claude-sonnet-4-6[1m]',
    'reconcile: an already-[1m] choice is unchanged'
  )
  equal(reconcileModelChoice('us.anthropic.claude-opus-5-5[1m]', 'claude-opus-5-5', listed), 'us.anthropic.claude-opus-5-5', 'reconcile: an old [1m] pick of a native-1M model lands on its base row')
  equal(reconcileModelChoice('claude-opus-5-5', 'claude-opus-5-5', []), 'claude-opus-5-5', 'reconcile: a native-1M model never gains the suffix')
}

// The live catalog (2.1.311 initialize models[], trimmed) outranks the version rules.
{
  const efforts = effortsFromCatalog([
    { value: 'default', resolvedModel: 'us.anthropic.claude-opus-5-5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { value: 'us.anthropic.claude-sonnet-4-6[1m]', resolvedModel: 'us.anthropic.claude-sonnet-4-6[1m]', supportsEffort: true, supportedEffortLevels: ['low', 'high', 'turbo'] },
    { value: 'haiku', resolvedModel: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', supportsThinkingOff: true },
    { value: 'opus', resolvedModel: 'us.anthropic.claude-opus-5-5', supportsEffort: true },
    'junk'
  ])
  equal(Object.keys(efforts).sort().join(' '), 'claude-haiku-4-5-20251001 claude-opus-5-5 claude-sonnet-4-6 default haiku', 'catalog: keyed by bare id, aliases and resolved models both, a row with no levels skipped')
  equal(efforts['claude-sonnet-4-6'].join(' '), 'low high', 'catalog: unknown levels are dropped, order is canonical')
  equal(efforts.haiku.length, 0, 'catalog: a model without supportsEffort takes none')
  setLiveEfforts(efforts)
  equal(deriveModelInfo('us.anthropic.claude-sonnet-4-6').efforts.join(' '), 'low high', 'catalog: the live levels beat the version rule')
  equal(deriveModelInfo('claude-opus-4-8').efforts.length, 5, 'catalog: an unlisted model keeps the version rule')
  setLiveEfforts({})
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
ok(cappedEffort('claude-sonnet-4-6', 'max', 'xhigh') === 'high', 'cappedEffort: model support still clamps under a cap')

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
  writeFileSync(SP, JSON.stringify({ model: 'claude-sonnet-4-6[1m]' }))
  const r = await (await fresh()).getResolvedSettings()
  ok(r.values.model === 'claude-sonnet-4-6[1m]', 'settings: explicit pick in overrides-only file preserved')
}
{
  writeFileSync(SP, JSON.stringify({ model: 'us.anthropic.claude-opus-5-5[1m]' }))
  const r = await (await fresh()).getResolvedSettings()
  equal(r.values.model, 'us.anthropic.claude-opus-5-5', 'settings: an old [1m] pick of a native-1M model resolves to its base id')
  equal(onDisk().model, 'us.anthropic.claude-opus-5-5[1m]', 'settings: and the file keeps what the user picked')
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

// Quick keys are enum-checked like their siblings: Plan Mode is withheld from Quick sessions.
{
  writeFileSync(SP, JSON.stringify({ schemaVersion: 1, quickModelFamily: 'fable', quickPermissionMode: 'plan' }))
  const r = await (await fresh()).getResolvedSettings()
  ok(r.values.quickModelFamily === 'haiku', 'settings: off-enum quickModelFamily dropped')
  ok(r.values.quickPermissionMode === 'default', 'settings: non-quick quickPermissionMode dropped')
}

// Two independent updates in flight at once both land, on disk and in the cache.
{
  writeFileSync(SP, JSON.stringify({ schemaVersion: 1 }))
  const m = await fresh()
  await m.getResolvedSettings()
  const [, second] = await Promise.all([m.updateSettings({ theme: 'light' }), m.updateSettings({ editorCommand: 'vim' })])
  const d = onDisk()
  ok(d.theme === 'light' && d.editorCommand === 'vim', 'settings: simultaneous updates both persist')
  ok(second.values.theme === 'light', 'settings: a later update builds on the earlier one')
  const c = m.getSettingsSync()
  ok(c.theme === 'light' && c.editorCommand === 'vim', 'settings: cache holds both simultaneous updates')
}

// A reset racing an unrelated update stays a reset.
{
  writeFileSync(SP, JSON.stringify({ schemaVersion: 1, theme: 'light' }))
  const m = await fresh()
  await m.getResolvedSettings()
  await Promise.all([m.updateSettings({}, ['theme']), m.updateSettings({ editorCommand: 'vim' })])
  const d = onDisk()
  ok(!('theme' in d) && d.editorCommand === 'vim', 'settings: reset survives a concurrent unrelated update')
}

// A failed write changes neither disk nor the cache, and the next update doesn't carry it.
{
  writeFileSync(SP, JSON.stringify({ schemaVersion: 1, editorCommand: 'vim' }))
  const before = readFileSync(SP, 'utf8')
  const m = await fresh()
  await m.getResolvedSettings()
  const dir = app.getPath('userData')
  chmodSync(dir, 0o500)
  let failed = false
  try {
    await m.updateSettings({ theme: 'light' })
  } catch {
    failed = true
  } finally {
    chmodSync(dir, 0o700)
  }
  ok(failed, 'settings: an unwritable file rejects the update')
  ok(readFileSync(SP, 'utf8') === before, 'settings: failed write leaves disk untouched')
  ok(m.getSettingsSync().theme === 'dark', 'settings: failed write leaves the cache untouched')
  await m.updateSettings({ cliPath: '/bin/claude' })
  ok(!('theme' in onDisk()), 'settings: next update does not carry the failed value')
}

// The modal's Save after the Browser pane saved its own switches leaves those switches alone.
{
  writeFileSync(SP, JSON.stringify({ schemaVersion: 1 }))
  const m = await fresh()
  let d = rebaseDraft(null, await m.getResolvedSettings())
  await m.updateSettings({ browserEnabled: true })
  await m.updateSettings({ linkTarget: 'system' })
  await m.updateSettings({ annotateScreenshots: false })
  d = editDraft(d, 'editorCommand', 'vim')
  const { patch, clear } = draftPatch(d)
  ok(JSON.stringify(patch) === '{"editorCommand":"vim"}' && clear.length === 0, 'draft: Save sends only the edited field')
  await m.updateSettings(patch, clear)
  const disk = onDisk()
  ok(
    disk.browserEnabled === true && disk.linkTarget === 'system' && disk.annotateScreenshots === false && disk.editorCommand === 'vim',
    'draft: Save keeps immediate browser, link and screenshot changes'
  )
}

// Draft bookkeeping: clean fields follow newer settings, staged edits and resets survive them.
{
  const saved = (values: Partial<CluiSettings>, overrides: SettingsKey[] = []): ResolvedSettings => ({
    values: { ...DEFAULT_SETTINGS, ...values },
    sources: Object.fromEntries(
      Object.keys(DEFAULT_SETTINGS).map((k) => [k, overrides.includes(k as SettingsKey) ? 'override' : 'default'])
    ) as ResolvedSettings['sources']
  })
  let d = rebaseDraft(null, saved({ theme: 'light', cliPath: '/a' }, ['theme', 'cliPath']))
  ok(!isDirty(d), 'draft: a fresh draft is clean')
  d = editDraft(d, 'editorCommand', 'vim')
  d = resetDraft(d, 'cliPath')
  d = rebaseDraft(d, saved({ theme: 'dark', cliPath: '/a', model: 'm2' }, ['cliPath', 'model']))
  const v = draftValues(d)
  ok(v.theme === 'dark' && v.model === 'm2', 'draft: an external update refreshes clean fields')
  ok(v.editorCommand === 'vim', 'draft: an external update keeps a staged edit')
  ok(JSON.stringify(draftPatch(d)) === '{"patch":{"editorCommand":"vim"},"clear":["cliPath"]}', 'draft: staged edit and reset survive a rebase')
  ok(!isOverridden(d, 'cliPath') && isOverridden(d, 'model'), 'draft: provenance follows the rebase, minus staged resets')
  d = rebaseDraft(d, saved({ editorCommand: 'vim' }, ['editorCommand']))
  ok(!isDirty(d), 'draft: edits matched elsewhere and resets with nothing to clear go clean')
  d = editDraft(resetDraft(editDraft(d, 'theme', 'light'), 'theme'), 'theme', 'dark')
  ok(!isDirty(d), 'draft: re-picking the saved value un-stages the edit and the reset')
}
