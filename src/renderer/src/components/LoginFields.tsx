import { IconEye, IconEyeOff, IconWarn } from './Icon'

/** The saved-login fields' input style, shared by the sign-in Gate and Settings. The control-edge
 *  border is what gives the field a 3:1 boundary against the inset it sits on. */
export const LOGIN_INPUT =
  'h-8 w-full rounded-md border border-control-edge bg-bg px-2.5 text-ui text-content focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-offset-[-1px]'

export function FieldError({ id, text }: { id: string; text: string }): JSX.Element {
  return (
    <p id={id} className="flex items-center gap-1.5 text-meta text-err">
      <IconWarn className="h-3.5 w-3.5 shrink-0" />
      {text}
    </p>
  )
}

/** Sits inside a password input that reserves pr-9 for it. */
export function RevealButton({ pressed, onToggle }: { pressed: boolean; onToggle: () => void }): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label="Show password"
      onClick={onToggle}
      className="toggle-press absolute right-0.5 top-0.5 flex h-7 w-7 items-center justify-center rounded text-dim transition-colors pointer-fine:hover:text-content focus-visible:-outline-offset-2"
    >
      {pressed ? <IconEyeOff className="h-4 w-4" /> : <IconEye className="h-4 w-4" />}
    </button>
  )
}
