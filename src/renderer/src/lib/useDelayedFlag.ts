import { useEffect, useState } from 'react'

/** `on`, once it has held for `ms`. A state that resolves within that never shows. */
export function useDelayedFlag(on: boolean, ms = 400): boolean {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (!on) {
      setShown(false)
      return
    }
    const t = setTimeout(() => setShown(true), ms)
    return () => clearTimeout(t)
  }, [on, ms])
  return on && shown
}
