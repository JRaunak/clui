// Runs the boundary suites and exits nonzero on any failure. A fresh checkout can replay
// this without machine-specific `.claude` scripts. Each suite asserts at import time via
// the shared harness.
import { summary } from './support/harness.mjs'

let suiteError = false
for (const name of ['transport', 'mapper', 'settings', 'security']) {
  console.log(`\n# ${name}`)
  try {
    await import(`./${name}.test.ts`)
  } catch (e) {
    suiteError = true
    console.log('  SUITE ERROR:', e && e.stack ? e.stack : e)
  }
}

const { passed, failed } = summary()
const green = failed === 0 && !suiteError
console.log(`\n${green ? '✓ PASS' : '✗ FAIL'} — ${passed} passed, ${failed} failed`)
process.exit(green ? 0 : 1)
