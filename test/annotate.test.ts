// Boundary: a pin's chip label, from the element's role and accessible name. What Claude reads about a pin is
// the <clui-context> record, tested in context.test.ts and packet.test.ts.
import { clipName, pinWords, type AnnotateTarget } from '../src/shared/annotate.ts'
import { equal } from './support/harness.mjs'

const target = (over: Partial<AnnotateTarget> = {}): AnnotateTarget => ({
  tag: 'button',
  role: 'button',
  name: 'Sign in',
  text: 'Sign in',
  selector: '#login > button',
  bbox: { x: 10, y: 20, width: 96, height: 32 },
  styles: { display: 'flex', color: 'rgb(0, 0, 0)' },
  html: '<button>\n  Sign in\n</button>',
  url: 'http://localhost:5173/login?next=/',
  ...over
})

const words = (over: Partial<AnnotateTarget>): string => JSON.stringify(pinWords(target(over)))
equal(words({}), JSON.stringify({ kind: 'button', name: 'Sign in' }), 'label: role and accessible name')
equal(words({ role: null, name: '', tag: 'div', text: 'Total' }), JSON.stringify({ kind: 'div', name: 'Total' }), 'label: no name falls back to the tag and its text')
equal(words({ role: null, name: '', tag: 'hr', text: '' }), JSON.stringify({ kind: 'hr', name: '' }), 'label: nothing to quote')
equal(clipName('A very long accessible name that goes past the chip'), 'A very long accessible name tha…', 'label: name cut to 32 characters')
