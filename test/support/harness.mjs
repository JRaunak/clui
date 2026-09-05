// Tiny assertion + suite harness shared by the boundary tests. No dependencies. A failed
// assertion is recorded and the runner exits nonzero, so `npm test` is a real gate.
let passed = 0
let failed = 0
const failures = []

export function ok(cond, message) {
  if (cond) passed++
  else {
    failed++
    failures.push(message)
    console.log('  FAIL:', message)
  }
}

export function equal(actual, expected, message) {
  ok(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
}

export function summary() {
  return { passed, failed, failures }
}

export const register = (name, fn) => ({ name, fn })
