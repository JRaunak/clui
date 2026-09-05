// Node ESM resolve hook for the boundary tests:
//  - stubs `electron` and `node:child_process` (main-process modules can't load under plain node)
//  - resolves bundler-style extensionless relative TS imports (`./ndjson` → `./ndjson.ts`)
// Type stripping itself is on by default in the Node the repo requires (>=22.12).
export async function resolve(spec, ctx, next) {
  if (spec === 'electron') {
    return { url: new URL('./electron-stub.mjs', import.meta.url).href, shortCircuit: true }
  }
  if (spec === 'node:child_process' || spec === 'child_process') {
    return { url: new URL('./child-process-stub.mjs', import.meta.url).href, shortCircuit: true }
  }
  if ((spec.startsWith('./') || spec.startsWith('../')) && !/\.[a-z]+(\?|$)/i.test(spec)) {
    for (const ext of ['.ts', '.tsx']) {
      try {
        return await next(spec + ext, ctx)
      } catch {
        /* try the next extension */
      }
    }
  }
  return next(spec, ctx)
}
