// Pure: where a File surface destination lands in the interleaved item list.
import { firstItemOf } from '../src/renderer/src/components/surfaces/landing.ts'
import { equal } from './support/harness.mjs'

// Items: [notice, l1, chip, pointed, l2, l3]; lineIndex[n] is line n's own row.
const lineIndex = Int32Array.from([0, 1, 4, 5, 0])
equal(firstItemOf(lineIndex, 1, 3), 0, 'line 1 lands at item 0, keeping what sits above it')
equal(firstItemOf(lineIndex, 2, 3), 2, "line 2 lands on its chip, ahead of the pointed row and the line")
equal(firstItemOf(lineIndex, 3, 3), 5, 'a bare line lands on itself')
equal(firstItemOf(lineIndex, 9, 3), 5, 'a start past the end clamps to the last line')
equal(firstItemOf(lineIndex, 0, 3), 0, 'a start before 1 clamps to line 1')
