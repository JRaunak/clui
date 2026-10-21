// Boundary: the local Adaptive classifier's spawn env, its live-list guard, and its picker ids.
import { writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from './support/electron-stub.mjs'
import { classifierEnv, classifierModelIds, classifierRefuses } from '../src/shared/settings.ts'
import { childEnv } from '../src/main/cli/session.ts'
import { equal } from './support/harness.mjs'

const json = (v: unknown): string => JSON.stringify(v)
const PIN = 'us.anthropic.claude-sonnet-5'
const LIVE = ['us.anthropic.claude-sonnet-5[1m]', 'us.anthropic.claude-haiku-5-5']

equal(json(classifierEnv({ localClassifier: false, classifierModel: 'x' }, null)), '{}', 'classifier: off injects nothing')
equal(json(classifierEnv({ localClassifier: true, classifierModel: '' }, null)), '{"CLAUDE_CODE_AUTO_MODE_SERVER":"0"}', 'classifier: CLI default sets no model')
equal(
  json(classifierEnv({ localClassifier: true, classifierModel: PIN }, null)),
  `{"CLAUDE_CODE_AUTO_MODE_SERVER":"0","CLAUDE_CODE_AUTO_MODE_MODEL":"${PIN}"}`,
  'classifier: a pin is passed when the list is unknown'
)
equal(json(classifierEnv({ localClassifier: true, classifierModel: PIN }, LIVE)).includes(PIN), true, 'classifier: a pin on the live list (as its [1m] id) is passed')
equal(
  json(classifierEnv({ localClassifier: true, classifierModel: 'us.anthropic.claude-sonnet-4-1' }, LIVE)),
  '{"CLAUDE_CODE_AUTO_MODE_SERVER":"0"}',
  'classifier: a pin missing from the live list falls back to the CLI default'
)
equal(
  json(classifierEnv({ localClassifier: true, classifierModel: 'us.anthropic.claude-opus-5-5' }, null)),
  '{"CLAUDE_CODE_AUTO_MODE_SERVER":"0"}',
  'classifier: a refused pin is dropped'
)
equal(classifierRefuses('global.anthropic.claude-opus-5[1m]'), true, 'classifier: refusal ignores prefix and [1m]')
equal(classifierRefuses('us.anthropic.claude-opus-5-1'), false, 'classifier: refusal is an exact id match')

{
  const shell = { CLAUDE_CODE_AUTO_MODE_MODEL: 'shell', PATH: '/bin' }
  const on = classifierEnv({ localClassifier: true, classifierModel: PIN }, null)
  equal(childEnv({ classifierEnv: on }, shell).CLAUDE_CODE_AUTO_MODE_MODEL, PIN, 'env: the pin beats a shell value')
  equal(childEnv({ classifierEnv: {} }, shell).CLAUDE_CODE_AUTO_MODE_MODEL, 'shell', 'env: off leaves a shell value alone')
  const cliDefault = classifierEnv({ localClassifier: true, classifierModel: '' }, null)
  equal('CLAUDE_CODE_AUTO_MODE_MODEL' in childEnv({ classifierEnv: cliDefault }, shell), false, 'env: on with CLI default drops a shell pin')
  equal(childEnv({ classifierEnv: on }, { CLAUDE_CODE_AUTO_MODE_SERVER: '1' }).CLAUDE_CODE_AUTO_MODE_SERVER, '0', 'env: on beats a shell server flag')
  equal(childEnv({ enableTaskTools: true }, { CLAUDE_CODE_ENABLE_TODO_TOOLS: '0' }).CLAUDE_CODE_ENABLE_TODO_TOOLS, '0', 'env: a shell task-tools value still wins')
  equal('CLAUDE_CODE_SESSION_ID' in childEnv({}, { CLAUDE_CODE_SESSION_ID: 'x' }), false, 'env: runtime markers are stripped')
}

equal(
  json(classifierModelIds(['us.anthropic.claude-opus-4-8[1m]', 'us.anthropic.claude-opus-4-8', 'us.anthropic.claude-haiku-5-5', 'opusplan', 'us.anthropic.claude-opus-5-5[1m]'])),
  '["us.anthropic.claude-opus-4-8","us.anthropic.claude-haiku-5-5"]',
  'classifier: picker ids are base ids, deduped, without selectors or refused models'
)

{
  const SP = join(app.getPath('userData'), 'settings.json')
  writeFileSync(SP, JSON.stringify({ schemaVersion: 1, onboarded: true }))
  const m = await import('../src/main/settings/store.ts?classifier')
  await m.updateSettings({ localClassifier: true, classifierModel: PIN })
  const raw = (): Record<string, unknown> => JSON.parse(readFileSync(SP, 'utf8'))
  equal(raw().classifierModel, PIN, 'settings: a classifier pin persists')
  await m.updateSettings({ localClassifier: false })
  equal('localClassifier' in raw(), false, 'settings: classifier off is pruned to the default')
  equal(raw().classifierModel, PIN, 'settings: turning the classifier off keeps the pin')
  await m.updateSettings({ classifierModel: '' })
  equal('classifierModel' in raw(), false, 'settings: CLI default is pruned to the default')
}
