// Claude's surface_open text or diagram parts are looked for by the tab that shows them; the reply waits briefly for
// that tab to say what it found: whether the words are there, or which parts the diagram doesn't have.
export type Found = boolean | string[] | 'no-diagram'
const waiting = new Map<string, (found: Found | undefined) => void>()

/** Resolves with what tab `id` reports for what it was just given, or undefined after `ms`. */
export function awaitFound(id: string, ms: number): Promise<Found | undefined> {
  waiting.get(id)?.(undefined)
  return new Promise((done) => {
    const t = setTimeout(() => {
      waiting.delete(id)
      done(undefined)
    }, ms)
    waiting.set(id, (found) => {
      clearTimeout(t)
      waiting.delete(id)
      done(found)
    })
  })
}

export const reportFound = (id: string, found: Found): void => waiting.get(id)?.(found)
