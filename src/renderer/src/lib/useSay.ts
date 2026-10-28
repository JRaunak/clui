import { useCallback, useRef, useState } from 'react'

/** A polite live region's text. A zero-width space toggles so an identical announcement still changes the region. */
export function useSay(): [string, (text: string) => void] {
  const [said, setSaid] = useState('')
  const n = useRef(0)
  const say = useCallback((text: string) => setSaid(`${text}${'\u200b'.repeat(++n.current % 2)}`), [])
  return [said, say]
}
