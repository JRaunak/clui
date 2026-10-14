// The file-type resolver: exact names, longest dotted suffix, case, dotfiles, fallback, folders.
import { equal } from './support/harness.mjs'

const { iconFor, toneOf } = await import('../src/renderer/src/lib/file-icons.ts')
const is = (name: string, kind: 'file' | 'folder', glyph: string, hue: string | null): void => {
  const got = iconFor(name, kind)
  equal(`${got.glyph}/${got.hue}`, `${glyph}/${hue}`, `${kind} ${name} → ${glyph} ${hue ?? 'neutral'}`)
}

is('package.json', 'file', 'config', 'green')
is('tsconfig.json', 'file', 'config', 'blue')
is('tsconfig.node.json', 'file', 'config', 'blue')

is('a.d.ts', 'file', 'data', 'blue')
is('a.test.tsx', 'file', 'test', 'cyan')
is('x.module.css', 'file', 'style', 'purple')
is('a.spec.ts', 'file', 'test', 'blue')
is('a.test.ts', 'file', 'test', 'blue')
is('my.app.ts', 'file', 'code', 'blue')

is('README.MD', 'file', 'doc', 'cyan')
is('Dockerfile', 'file', 'config', 'cyan')
is('DOCKERFILE', 'file', 'config', 'cyan')
is('IMG.PNG', 'file', 'image', 'purple')
is('Src', 'folder', 'folder', 'blue')

is('.gitignore', 'file', 'git', 'red')
is('.gitkeep', 'file', 'git', 'red')
is('.env.local', 'file', 'env', 'yellow')
is('.eslintrc.json', 'file', 'config', 'purple')
is('.foo', 'file', 'file', null)

is('package-lock.json', 'file', 'lock', 'yellow')
is('yarn.lock', 'file', 'lock', 'yellow')
is('Cargo.lock', 'file', 'lock', 'yellow')

is('notes', 'file', 'file', null)
is('a.unknownext', 'file', 'file', null)
is('weird.', 'file', 'file', null)
is('foo', 'folder', 'folder', null)

is('x.ts', 'folder', 'folder', null)
is('node_modules', 'folder', 'folder', null)
is('dist', 'folder', 'folder', null)
is('.git', 'folder', 'folder', null)

equal(toneOf(iconFor('.env', 'file').hue, 'hue'), 'yellow', 'lit dotfile keeps its hue')
equal(toneOf(iconFor('.DS_Store', 'file').hue, 'hue'), 'faint', 'lit unmapped dotfile drops to faint, never brighter than its name')
equal(toneOf(iconFor('.github', 'folder').hue, 'hue'), 'purple', 'lit mapped dot folder keeps its hue')
equal(toneOf(iconFor('.env', 'file').hue, true), 'faint', 'dimmed always faint')
equal(toneOf(iconFor('notes', 'file').hue, false), 'dim', 'undimmed unmapped is dim')
equal(toneOf(iconFor('a.ts', 'file').hue, false), 'blue', 'undimmed mapped keeps its hue')
