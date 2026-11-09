// Boundary: model list by provider. The CLI catalog parse, the AWS profile/region precedence,
// and which source a query returns. Fixtures are initialize `models[]` captured from CLI 2.1.319.
import { readFileSync } from 'node:fs'
import { catalogIds, FALLBACK_MODEL_IDS } from '../src/shared/settings.ts'
import { awsTarget, type CliSettings } from '../src/main/settings/cli-settings.ts'
import { pickModelList } from '../src/main/models/list.ts'
import { equal, ok } from './support/harness.mjs'

const fixture = (name: string): { account: { apiProvider: string }; models: unknown } =>
  JSON.parse(readFileSync(new URL(`./fixtures/catalog-${name}.json`, import.meta.url), 'utf8'))
const same = (a: unknown, b: unknown, msg: string): void => equal(JSON.stringify(a), JSON.stringify(b), msg)

const bedrockCatalog = catalogIds(fixture('bedrock').models)
same(
  bedrockCatalog,
  [
    'us.anthropic.claude-fable-5-1',
    'us.anthropic.claude-sonnet-5-5',
    'us.anthropic.claude-sonnet-5',
    'us.anthropic.claude-sonnet-4-6',
    'us.anthropic.claude-sonnet-4-6[1m]',
    'us.anthropic.claude-opus-5-5',
    'us.anthropic.claude-haiku-4-5-20251001-v1:0'
  ],
  'catalog: bedrock drops default, resolves aliases, keeps the listed [1m] row'
)
same(
  catalogIds(fixture('firstparty').models),
  ['claude-opus-5-5', 'claude-fable-5-1', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  'catalog: firstParty aliases become their resolved ids, deduped against default'
)
same(
  catalogIds([{ value: 'sonnet', resolvedModel: 'sonnet' }, { value: 'claude-3-7-sonnet-20250219' }, null, { value: 7 }]),
  ['sonnet'],
  'catalog: an unversioned resolution keeps the value; claude-3 and junk rows drop'
)
same(catalogIds(undefined), [], 'catalog: a missing models[] is empty')

const cli = (env: CliSettings['env'], bedrock: CliSettings['bedrock'] = {}): CliSettings => ({ env, bedrock })
const legacy = { profile: 'legacy-p', region: 'legacy-r' }
equal(awsTarget(cli({ AWS_PROFILE: 'set-p' }, legacy), { AWS_PROFILE: 'sh-p' }).profile, 'set-p', 'aws: settings env profile beats shell and legacy')
equal(awsTarget(cli({}, legacy), { AWS_PROFILE: 'sh-p' }).profile, 'sh-p', 'aws: shell profile beats legacy')
equal(awsTarget(cli({}, legacy), {}).profile, 'legacy-p', 'aws: legacy profile is the last resort')
equal(awsTarget(cli({ AWS_DEFAULT_REGION: 'set-dr' }, legacy), { AWS_REGION: 'sh-r' }).region, 'set-dr', 'aws: settings AWS_DEFAULT_REGION beats shell AWS_REGION')
equal(awsTarget(cli({ AWS_REGION: 'set-r', AWS_DEFAULT_REGION: 'set-dr' }), {}).region, 'set-r', 'aws: settings AWS_REGION beats its AWS_DEFAULT_REGION')
equal(awsTarget(cli({}, legacy), { AWS_DEFAULT_REGION: 'sh-dr' }).region, 'sh-dr', 'aws: shell region beats legacy')
equal(awsTarget(cli({}, legacy), { AWS_REGION: '' }).region, 'legacy-r', 'aws: an empty shell region falls through to legacy')
same(awsTarget(cli({}), {}), { useBedrock: false }, 'aws: nothing configured means no target and no Bedrock hint')
equal(awsTarget(cli({ CLAUDE_CODE_USE_BEDROCK: '0' }), { CLAUDE_CODE_USE_BEDROCK: '1' }).useBedrock, false, 'aws: settings provider switch beats the shell')
equal(awsTarget(cli({}), { CLAUDE_CODE_USE_BEDROCK: 'true' }).useBedrock, true, 'aws: shell provider switch hints Bedrock')
equal(awsTarget(cli({}, { profile: 'legacy-p' }), {}).useBedrock, true, 'aws: the legacy bedrock key hints Bedrock')

const profiles = ['us.anthropic.claude-opus-5-5', 'us.anthropic.claude-sonnet-4-6']
const awsOk = { ids: profiles }
const awsFail = { reason: 'expired-creds' as const }
const withVariants = ['us.anthropic.claude-opus-5-5', 'us.anthropic.claude-sonnet-4-6[1m]']
const fallback = (r: { ids: string[] }): boolean => r.ids.length >= FALLBACK_MODEL_IDS.length && r.ids[0] === FALLBACK_MODEL_IDS[0]

same(
  pickModelList({ provider: 'bedrock', catalog: bedrockCatalog, bedrock: awsOk, hinted: false }),
  { ids: withVariants, live: true, provider: 'bedrock' },
  'pick: bedrock with a working aws query lists the account profiles'
)
same(
  pickModelList({ provider: 'bedrock', catalog: bedrockCatalog, bedrock: awsFail, hinted: true }),
  { ids: bedrockCatalog, live: true, provider: 'bedrock', partial: true, reason: 'expired-creds' },
  'pick: bedrock with a failed aws query falls back to the catalog, flagged partial'
)
same(
  pickModelList({ provider: 'firstParty', catalog: ['claude-opus-5-5'], bedrock: awsOk, hinted: true }),
  { ids: ['claude-opus-5-5'], live: true, provider: 'firstParty' },
  'pick: a non-Bedrock provider takes the catalog and discards aws'
)
same(
  pickModelList({ provider: null, catalog: [], bedrock: awsOk, hinted: true }),
  { ids: withVariants, live: true },
  'pick: no CLI answer with a Bedrock hint lists the aws profiles'
)
const noCliFail = pickModelList({ provider: null, catalog: [], bedrock: awsFail, hinted: true })
ok(fallback(noCliFail) && !noCliFail.live && noCliFail.reason === 'expired-creds' && !noCliFail.provider, 'pick: no CLI answer and a failed aws query is the fallback with the aws reason')
const unhinted = pickModelList({ provider: null, catalog: [], bedrock: awsOk, hinted: false })
ok(fallback(unhinted) && !unhinted.live && unhinted.reason === 'other', 'pick: no CLI answer and no Bedrock hint ignores aws and falls back')
const unknownProvider = pickModelList({ provider: 'someNewProvider', catalog: ['x-model'], bedrock: awsFail, hinted: false })
same(unknownProvider, { ids: ['x-model'], live: true }, 'pick: an unrecognized provider still takes its catalog')
