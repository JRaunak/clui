/** Agent faces: a head outline and two dot eyes. Silhouette tells faces apart; the pastel head tint is an identity aid
 *  and never carries status. Ids are for code and tests only; a screen reader names an agent by its description. */
import { Svg } from './Icon'

type P = { className?: string }
const Eyes = ({ l, r }: { l: [number, number]; r: [number, number] }): JSX.Element => (
  <>
    <circle cx={l[0]} cy={l[1]} r="1.5" fill="currentColor" stroke="none" />
    <circle cx={r[0]} cy={r[1]} r="1.5" fill="currentColor" stroke="none" />
  </>
)
const face = (id: string, head: JSX.Element, rest: JSX.Element) => ({
  id,
  Icon: ({ className = 'h-4 w-4' }: P): JSX.Element => (
    <Svg className={className}>
      <g className="face-head" style={{ fill: `var(--face-${id})` }}>{head}</g>
      {rest}
    </Svg>
  )
})

export const FACES: readonly { id: string; Icon: (p: P) => JSX.Element }[] = [
  face('bear', <circle cx="12" cy="14" r="7" />, <><circle cx="6.2" cy="8.2" r="2.4" fill="currentColor" stroke="none" /><circle cx="17.8" cy="8.2" r="2.4" fill="currentColor" stroke="none" /><Eyes l={[9.3, 14.5]} r={[14.7, 14.5]} /></>),
  face('cat', <circle cx="12" cy="14.5" r="6.5" />, <><path d="M6.3 11.3 6.6 4.8l4 3.6M17.7 11.3l-.3-6.5-4 3.6" /><Eyes l={[9.4, 15]} r={[14.6, 15]} /></>),
  face('antenna', <circle cx="12" cy="14.5" r="6.5" />, <><path d="M12 8V5" /><circle cx="12" cy="3.4" r="1.7" fill="currentColor" stroke="none" /><Eyes l={[9.4, 15]} r={[14.6, 15]} /></>),
  face('sprocket', <circle cx="12" cy="13.5" r="6.5" />, <><path d="M5.6 11.2a2.3 2.3 0 1 0 0 4.6M18.4 11.2a2.3 2.3 0 1 1 0 4.6" /><Eyes l={[9.4, 14]} r={[14.6, 14]} /></>),
  face('bolt', <rect x="5.5" y="7.5" width="13" height="13" rx="3" />, <><path d="M2.8 14h2.7M18.5 14h2.7" /><Eyes l={[9.4, 14]} r={[14.6, 14]} /></>),
  face('hat', <rect x="5.5" y="9.5" width="13" height="11.5" rx="3" />, <><path d="M3 9.5h18M8 9.5V6.5A1.5 1.5 0 0 1 9.5 5h5A1.5 1.5 0 0 1 16 6.5v3" /><Eyes l={[9.4, 15.2]} r={[14.6, 15.2]} /></>),
  face('stadium', <rect x="6" y="3" width="12" height="18" rx="6" />, <Eyes l={[9.4, 10.5]} r={[14.6, 10.5]} />),
  face('loaf', <rect x="2.5" y="8.5" width="19" height="11" rx="5.5" />, <Eyes l={[9, 14]} r={[15, 14]} />),
  face('hex', <path d="M12 3.2 19.8 7.7v9L12 21.2l-7.8-4.5v-9Z" />, <Eyes l={[9.4, 12.8]} r={[14.6, 12.8]} />),
  face('cone', <path d="M5.5 19.5A1.5 1.5 0 0 1 4 18C4.6 12.4 9.2 4.5 12 4.5S19.4 12.4 20 18a1.5 1.5 0 0 1-1.5 1.5Z" />, <Eyes l={[9.6, 15.4]} r={[14.4, 15.4]} />),
  face('kite', <path d="M12 2.5 21.5 12 12 21.5 2.5 12Z" />, <Eyes l={[9.3, 12]} r={[14.7, 12]} />),
  face('bunny', <circle cx="12" cy="15.5" r="5.8" />, <><path d="M7.4 12V4.6a1.6 1.6 0 0 1 3.2 0V10M16.6 12V4.6a1.6 1.6 0 0 0-3.2 0V10" /><Eyes l={[9.6, 16]} r={[14.4, 16]} /></>)
]

/** The mark an agent wears until its face is known; never handed out. */
export function IconAgent({ className = 'h-4 w-4' }: P): JSX.Element {
  return (
    <Svg className={className}>
      <circle cx="12" cy="13" r="7.5" />
      <Eyes l={[9.3, 13.5]} r={[14.7, 13.5]} />
    </Svg>
  )
}

export function AgentFace({ face, className }: { face: number | null } & P): JSX.Element {
  const F = face === null ? IconAgent : (FACES[face]?.Icon ?? IconAgent)
  return <F className={className} />
}
