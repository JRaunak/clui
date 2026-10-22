// A chip card's preview: which lines a file window shows, and how a change snapshot's rows are numbered.
import { changeRows, fileLines, fileWindow } from '../src/renderer/src/lib/peek.ts'
import { equal } from './support/harness.mjs'

const same = (a: unknown, b: unknown, m: string): void => equal(JSON.stringify(a), JSON.stringify(b), m)

same(fileWindow(40, { start: 5, end: 8 }), { start: 1, end: 20 }, 'window: a range near the top takes its context below')
same(fileWindow(100, { start: 50, end: 53 }), { start: 42, end: 61 }, 'window: context splits evenly around a range')
same(fileWindow(40, { start: 38, end: 40 }), { start: 21, end: 40 }, 'window: a range at the end takes its context above')
same(fileWindow(10, { start: 3, end: 4 }), { start: 1, end: 10 }, 'window: a short file shows all of it')
same(fileWindow(100, { start: 1, end: 60 }), { start: 1, end: 20 }, 'window: a long range shows its first 20 lines')
same(fileWindow(100, { start: 11, end: 30 }), { start: 11, end: 30 }, 'window: a 20-line range is exactly the window')
same(fileWindow(100), { start: 1, end: 20 }, 'window: a whole file shows its head')
same(fileLines('a\nb\n'), ['a', 'b'], 'lines: a trailing newline ends the last line')

same(
  changeRows(' keep\n-gone\n+new\n+more\n tail', 'diff', { start: 40, end: 42 }, { start: 40, end: 43 }).map((r) => [r.kind, r.text, r.oldNo, r.newNo]),
  [
    [' ', 'keep', 40, 40],
    ['-', 'gone', 41, undefined],
    ['+', 'new', undefined, 41],
    ['+', 'more', undefined, 42],
    [' ', 'tail', 42, 43]
  ],
  'change: a diff slice numbers each side from its own start'
)
same(changeRows('a\nb', 'before', { start: 7, end: 8 }).map((r) => [r.kind, r.n]), [[' ', 7], [' ', 8]], 'change: a one-sided slice numbers from that side')
equal(changeRows('x', 'after', undefined, { start: 3, end: 3 })[0].n, 3, 'change: the after side numbers from new.start')
