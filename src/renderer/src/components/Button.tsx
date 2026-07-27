/**
 * Shared button primitive — one place for variants, sizes, focus, and disabled
 * treatment, so buttons can't drift back into per-site rounding, ad-hoc hovers, and
 * missing focus rings. Variants follow the design-system spec: primary / secondary /
 * outline / ghost / destructive.
 */
import type { ButtonHTMLAttributes } from 'react'

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'destructive'
type Size = 'sm' | 'md' | 'lg' | 'icon'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-deep',
  secondary: 'bg-bg-raised text-content hover:bg-border border border-border',
  outline: 'border border-border text-content hover:border-accent hover:text-content bg-transparent',
  ghost: 'text-dim hover:text-content hover:bg-bg-raised bg-transparent',
  destructive: 'bg-err text-on-err hover:brightness-110'
}

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
  lg: 'h-11 px-6 text-base gap-2',
  icon: 'h-9 w-9 justify-center'
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  children,
  ...rest
}: {
  variant?: Variant
  size?: Size
} & ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      /* Disabled: don't just fade the fill — a faded terracotta primary still reads
         as a live (if weak) button, and in dark it's near-indistinguishable from
         enabled. Override to a NEUTRAL inert surface + dim label in both themes so
         "disabled" is unambiguous and its label stays legible. */
      className={`inline-flex cursor-pointer items-center justify-center rounded-md font-semibold transition-[background-color,border-color,color,filter] duration-150 ease-out disabled:cursor-default disabled:border-transparent disabled:bg-bg-raised disabled:text-faint disabled:hover:bg-bg-raised disabled:hover:brightness-100 ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}
