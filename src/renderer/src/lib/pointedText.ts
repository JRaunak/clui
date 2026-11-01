// Claude's surface_open text is searched by the tab that shows it; the reply waits briefly for that tab to say whether
// the words are there.
const waiting = new Map<string, (found: boolean | undefined) => void>()

/** Resolves with what tab `id` reports for the text it was just given, or undefined after `ms`. */
export function awaitFound(id: string, ms: number): Promise<boolean | undefined> {
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

export const reportFound = (id: string, found: boolean): void => waiting.get(id)?.(found)
