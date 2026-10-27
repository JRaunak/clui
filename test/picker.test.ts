// The shared path ranker (the @ picker and Open file) and the pane picker's item list.
import { equal, ok } from './support/harness.mjs'

const { rankPaths, scorePath, splitLine, NAME_TIER } = await import('../src/renderer/src/lib/fuzzy.ts')
const { paneItems } = await import('../src/renderer/src/lib/paneItems.ts')

const order = (q: string, paths: string[]): string => rankPaths(q, paths).map((r) => r.item).join(' ')

// Tiers: exact basename > prefix > substring > a match spread along the path.
equal(order('store.ts', ['src/store.ts.bak', 'src/a/store.ts', 'store/ts.md']), 'src/a/store.ts src/store.ts.bak', 'ranker: exact basename beats prefix, scattered drops')
equal(order('comp', ['src/x/Composer.tsx', 'src/mycomp.ts', 'c/o/m/p.ts']), 'src/x/Composer.tsx src/mycomp.ts', 'ranker: prefix beats substring, scattered drops under a name match')
equal(order('store', ['src/store/index.ts', 'lib/store.ts']), 'lib/store.ts', 'ranker: a path-segment match loses to a basename match')
equal(order('cpa', ['c/p/a.ts', 'cxp/ya.ts']), 'c/p/a.ts cxp/ya.ts', 'ranker: with no name match, scattered matches stay')
equal(order('a.ts', ['deep/dir/a.ts', 'a.ts']), 'a.ts deep/dir/a.ts', 'ranker: ties go to the shorter path')

// Case and whitespace.
equal(order('README', ['docs/readme.md', 'x/Readme.txt', 'x/ReadMe.txt.old']), 'x/Readme.txt docs/readme.md x/ReadMe.txt.old', 'ranker: case-insensitive')
equal(rankPaths('  store.ts ', ['a/store.ts'])[0]?.score, 3 * NAME_TIER, 'ranker: surrounding spaces are ignored')

// Separators: a query with a slash ranks on the whole path, never as a name match.
const slash = rankPaths('src/st', ['a/src/b/st.ts', 'src/store.ts', 'lib/src-st.ts'])
equal(slash.map((r) => r.item).join(' '), 'src/store.ts a/src/b/st.ts', 'ranker: a slash query matches along the path, the tighter run first')
ok(slash.every((r) => r.score < NAME_TIER), 'ranker: a slash query never scores as a name')

// Highlights index the whole path; a name hit lights the name, contiguously.
equal(scorePath('sto', 'src/store.ts')?.matches.join(), '4,5,6', 'ranker: a prefix highlights the start of the basename')
equal(scorePath('ore', 'src/store.ts')?.matches.join(), '6,7,8', 'ranker: a substring highlights its run in the basename')
equal(scorePath('zzz', 'src/store.ts'), null, 'ranker: no subsequence, no result')

// Empty query: everything, in input order, nothing lit.
const all = rankPaths('', ['b.ts', 'a.ts'])
equal(all.map((r) => r.item).join(' '), 'b.ts a.ts', 'ranker: an empty query keeps the input order')
ok(all.every((r) => r.matches.length === 0), 'ranker: an empty query highlights nothing')

// Lift raises a name match above every plain path, not a scattered one.
const lifted = rankPaths('basil', ['img/b-a-s-i-l.light.png', 'basil'], (x) => x, (x) => (x === 'basil' ? 10000 : 0))
equal(lifted[0]?.item, 'basil', 'ranker: lift floats a name match first')

// 3000 paths, the listing cap, rank well inside a frame.
const many = Array.from({ length: 3000 }, (_, i) => `src/renderer/src/components/group${i % 40}/Component${i}.tsx`)
rankPaths('comp', many)
const t0 = performance.now()
for (let i = 0; i < 5; i++) rankPaths('cmp12', many)
const per = (performance.now() - t0) / 5
ok(per < 40, `ranker: 3000 paths rank in under 40ms (took ${per.toFixed(1)}ms)`)

// Line suffixes.
const sl = (q: string): string => JSON.stringify(splitLine(q))
equal(sl('store.ts:142'), '{"query":"store.ts","line":142}', 'line: name:line')
equal(sl('store.ts:142:5'), '{"query":"store.ts","line":142}', 'line: the column is dropped')
equal(sl('store.ts:'), '{"query":"store.ts:","line":null}', 'line: a bare colon stays in the query')
equal(sl(':12'), '{"query":":12","line":null}', 'line: no name, no line')
equal(sl('store.ts:0'), '{"query":"store.ts:0","line":null}', 'line: line 0 is not a line')

// Pane items: fixed order, the conditional items last.
const NONE_OPEN = { treeOpen: false, changesOpen: false }
const keys = (changes: number, browser: boolean, open = NONE_OPEN): string => paneItems({ cwd: '/Users/me/clui', home: '/Users/me', changes, browser, ...open }).map((i) => i.key).join()
equal(keys(0, false), 'open-file,tree', 'items: open file and the tree are always there')
equal(keys(3, false), 'open-file,tree,changes', 'items: changes join after the tree')
equal(keys(0, true), 'open-file,tree,browser', 'items: the browser joins last')
equal(keys(2, true), 'open-file,tree,changes,browser', 'items: both conditionals, in order')
equal(keys(2, true, { treeOpen: true, changesOpen: false }), 'open-file,changes,browser', 'items: an open tree is not offered again')
equal(keys(2, true, { treeOpen: false, changesOpen: true }), 'open-file,tree,browser', 'items: an open changes tab is not offered again')
equal(keys(0, false, { treeOpen: true, changesOpen: true }), 'open-file', 'items: open file stays with both singletons open')
const items = paneItems({ cwd: '/Users/me/clui', home: '/Users/me', changes: 1, browser: true, ...NONE_OPEN })
equal(items[1].meta, 'clui', 'items: the tree shows the cwd basename')
equal(items[1].description, 'Folder ~/clui', 'items: the tree describes the folder from home')
equal(items[2].meta, '1 file', 'items: one change is singular')
equal(paneItems({ cwd: '/w', home: '/Users/me', changes: 7, browser: false, ...NONE_OPEN })[2].description, '7 files changed by Claude', 'items: the changes description')
equal(items[0].keys, 'Meta+P', 'items: open file advertises its shortcut')
equal(items[3].label, 'New browser tab', 'items: the browser item says what it makes')
