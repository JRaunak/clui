// Boundary: readConfig lists project entries before user ones, alphabetical within each,
// so the Configuration panel can split its groups at the first non-project row.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readConfig } from '../src/main/config/reader.ts'
import { equal } from './support/harness.mjs'

const root = mkdtempSync(join(tmpdir(), 'clui-config-'))
const home = join(root, 'home')
const proj = join(root, 'proj')
const agent = (dir: string, name: string): void => writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\n---\n`)
const hook = (event: string, matcher: string) => ({ [event]: [{ matcher, hooks: [{ type: 'command', command: 'true' }] }] })

mkdirSync(join(home, 'agents'), { recursive: true })
mkdirSync(join(proj, '.claude/agents'), { recursive: true })
for (const n of ['zz-cfgtest-proj', 'mm-cfgtest-proj']) agent(join(proj, '.claude/agents'), n)
for (const n of ['aa-cfgtest-user', 'nn-cfgtest-user']) agent(join(home, 'agents'), n)
writeFileSync(
  join(home, 'settings.json'),
  JSON.stringify({ hooks: hook('Alpha', 'u'), mcpServers: { 'aa-cfgtest-mcp': { command: 'x' } } })
)
writeFileSync(
  join(proj, '.claude/settings.json'),
  JSON.stringify({
    hooks: { Zeta: [{ matcher: 'p1', hooks: [] }, { matcher: 'p2', hooks: [] }], Beta: [{ matcher: 'p', hooks: [] }] },
    mcpServers: { 'zz-cfgtest-mcp': { command: 'x' } }
  })
)

const prev = process.env.CLAUDE_CONFIG_DIR
process.env.CLAUDE_CONFIG_DIR = home
const b = await readConfig(proj)
if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
else process.env.CLAUDE_CONFIG_DIR = prev
rmSync(root, { recursive: true, force: true })

equal(
  b.agents.filter((a) => a.name.includes('cfgtest')).map((a) => a.name).join(),
  'mm-cfgtest-proj,zz-cfgtest-proj,aa-cfgtest-user,nn-cfgtest-user',
  'config: agents sort project first, then by name'
)
equal(
  b.hooks.map((h) => `${h.event}:${h.matcher}`).join(),
  'Beta:p,Zeta:p1,Zeta:p2,Alpha:u',
  'config: hooks sort project first, then by event, keeping file order within an event'
)
equal(
  b.mcpServers.filter((m) => m.name.includes('cfgtest')).map((m) => m.name).join(),
  'zz-cfgtest-mcp,aa-cfgtest-mcp',
  'config: MCP servers sort project first'
)
