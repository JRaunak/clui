export type FileGlyph = 'file' | 'code' | 'test' | 'data' | 'style' | 'doc' | 'image' | 'config' | 'shell' | 'lock' | 'git' | 'env' | 'folder'
export type FileHue = 'blue' | 'cyan' | 'green' | 'yellow' | 'purple' | 'pink' | 'red' | null
export interface FileIconSpec {
  glyph: FileGlyph
  hue: FileHue
}

const table = (rows: [string, FileGlyph, FileHue][]): Record<string, FileIconSpec> => {
  const out: Record<string, FileIconSpec> = Object.create(null)
  for (const [names, glyph, hue] of rows) for (const n of names.split(' ')) out[n] = { glyph, hue }
  return out
}

const NAMES = table([
  ['package.json', 'config', 'green'],
  ['tsconfig.json tsconfig.node.json tsconfig.web.json tsconfig.base.json', 'config', 'blue'],
  ['jsconfig.json', 'config', 'yellow'],
  [
    'vite.config.ts vite.config.js vitest.config.ts electron.vite.config.ts electron-builder.yml eslint.config.js eslint.config.mjs .eslintrc.json .prettierrc .prettierrc.json prettier.config.js',
    'config',
    'purple'
  ],
  ['tailwind.config.ts tailwind.config.js postcss.config.js postcss.config.mjs', 'config', 'cyan'],
  ['pyproject.toml requirements.txt setup.py setup.cfg', 'config', 'green'],
  ['dockerfile docker-compose.yml docker-compose.yaml compose.yaml .dockerignore', 'config', 'cyan'],
  ['makefile .editorconfig .npmrc .nvmrc .python-version', 'config', null],
  ['package-lock.json yarn.lock pnpm-lock.yaml bun.lockb poetry.lock uv.lock cargo.lock', 'lock', 'yellow'],
  ['.gitignore .gitattributes .gitmodules .gitkeep', 'git', 'red'],
  ['.env .env.local .env.example .env.development .env.production .env.test', 'env', 'yellow'],
  ['license license.md license.txt', 'doc', null]
])

const EXTS = table([
  ['.ts .mts .cts', 'code', 'blue'],
  ['.d.ts', 'data', 'blue'],
  ['.tsx .jsx', 'code', 'cyan'],
  ['.js .mjs .cjs', 'code', 'yellow'],
  ['.test.ts .spec.ts', 'test', 'blue'],
  ['.test.tsx .spec.tsx', 'test', 'cyan'],
  ['.test.js .spec.js', 'test', 'yellow'],
  ['.py', 'code', 'green'],
  ['.html', 'code', 'pink'],
  ['.css .module.css', 'style', 'purple'],
  ['.scss .sass', 'style', 'pink'],
  ['.json .jsonc', 'data', 'yellow'],
  ['.yaml .yml', 'data', 'purple'],
  ['.toml', 'data', null],
  ['.md .mdx', 'doc', 'cyan'],
  ['.txt', 'doc', null],
  ['.png .jpg .jpeg .gif .webp .ico .icns', 'image', 'purple'],
  ['.svg', 'image', 'yellow'],
  ['.sh .bash .zsh', 'shell', null]
])

// Generated folders are listed as neutral on purpose, so nobody "fixes" them to a colour.
const FOLDERS = table([
  ['src lib app packages', 'folder', 'blue'],
  ['components docs doc', 'folder', 'cyan'],
  ['test tests __tests__ spec e2e fixtures', 'folder', 'green'],
  ['public assets static images img icons fonts', 'folder', 'yellow'],
  ['.github .vscode .claude .husky config scripts', 'folder', 'purple'],
  ['styles', 'folder', 'pink'],
  ['node_modules .git dist out build release coverage .venv venv __pycache__', 'folder', null]
])

/** `'hue'` dims only an icon with no mapped hue, so an unmapped dotfile is never brighter than its faint name. */
export type IconDim = boolean | 'hue'
export const toneOf = (hue: FileHue, dim: IconDim): NonNullable<FileHue> | 'dim' | 'faint' =>
  dim === true || (dim === 'hue' && !hue) ? 'faint' : (hue ?? 'dim')

const FILE: FileIconSpec = { glyph: 'file', hue: null }
const FOLDER: FileIconSpec = { glyph: 'folder', hue: null }

/** Exact name first, then the longest dotted suffix. The scan starts after index 0 so a dotfile isn't all extension. */
export function iconFor(name: string, kind: 'file' | 'folder'): FileIconSpec {
  const n = name.toLowerCase()
  if (kind === 'folder') return FOLDERS[n] ?? FOLDER
  const exact = NAMES[n]
  if (exact) return exact
  for (let i = n.indexOf('.', 1); i !== -1; i = n.indexOf('.', i + 1)) {
    const hit = EXTS[n.slice(i)]
    if (hit) return hit
  }
  return FILE
}
