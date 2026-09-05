// Boundary: no code execution when reading project metadata, and session deletion
// can't escape its directory.
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readConfig } from '../src/main/config/reader.ts'
import { deleteSession } from '../src/main/sessions/store.ts'
import { ok } from './support/harness.mjs'

// a `---js` / `---javascript` frontmatter fence must NOT execute
const proj = mkdtempSync(join(tmpdir(), 'clui-sec-'))
mkdirSync(join(proj, '.claude/agents'), { recursive: true })
mkdirSync(join(proj, '.claude/skills/evil'), { recursive: true })
;(globalThis as any).__PWNED__ = false
writeFileSync(join(proj, '.claude/agents/evil.md'), '---js\nglobalThis.__PWNED__ = true; ({name:"evil"})\n---\nbody\n')
writeFileSync(join(proj, '.claude/agents/good.md'), '---\nname: good-agent\ndescription: ok\n---\nbody\n')
writeFileSync(join(proj, '.claude/skills/evil/SKILL.md'), '---javascript\nglobalThis.__PWNED__ = true\n---\nx\n')

const bundle = await readConfig(proj)
ok((globalThis as any).__PWNED__ === false, 'security: js frontmatter fence does not execute')
ok(bundle.agents.some((a) => a.name === 'good-agent'), 'security: normal YAML frontmatter still parses')
ok(!bundle.agents.some((a) => a.name === 'evil'), 'security: js-fenced agent is skipped')
rmSync(proj, { recursive: true, force: true })

// deletion rejects traversal / unsafe ids
async function throws(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}
ok(await throws(() => deleteSession('slug', '..')), 'security: id ".." rejected')
ok(await throws(() => deleteSession('slug', '../../outside/x')), 'security: traversal id rejected')
ok(await throws(() => deleteSession('..', 'id')), 'security: slug ".." rejected')
ok(await throws(() => deleteSession('slug', '')), 'security: empty id rejected')
ok(await throws(() => deleteSession('slug', 'a/b')), 'security: separator in id rejected')
