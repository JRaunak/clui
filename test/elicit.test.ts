// Boundary: an MCP elicitation's schema → Gate fields, their validation, and the typed accept payload.
import { contentOf, fieldError, fieldsOf, initialValues, linkOf, requestOf } from '../src/renderer/src/components/gates/elicit.ts'
import { equal, ok } from './support/harness.mjs'

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string', title: 'Your name', description: 'As on the account', minLength: 2 },
    seats: { type: 'integer', minimum: 1, maximum: 10 },
    ratio: { type: 'number' },
    agree: { type: 'boolean', default: true },
    plan: { type: 'string', enum: ['free', 'pro'], enumNames: ['Free', 'Pro'] }
  },
  required: ['name', 'plan']
}
const fields = fieldsOf(schema)!
ok(!!fields && fields.length === 5, 'elicit: a flat schema of primitives yields one field each')
equal(fields[0].label, 'Your name', 'elicit: title is the label')
equal(fields[2].label, 'ratio', 'elicit: the key is the label without a title')
ok(fields[0].required && !fields[1].required, 'elicit: required comes from the schema')
ok(fields[1].kind === 'number' && fields[1].integer && fields[2].kind === 'number' && !fields[2].integer, 'elicit: integer vs number')
ok(fields[4].kind === 'enum' && fields[4].options[1].label === 'Pro', 'elicit: enumNames label the options')

equal(fieldsOf({ type: 'object', properties: { a: { type: 'object', properties: {} } } }), null, 'elicit: a nested object is unsupported')
equal(fieldsOf({ type: 'object', properties: { a: { type: 'array', items: { type: 'string' } } } }), null, 'elicit: an array is unsupported')
equal(fieldsOf({ type: 'object', properties: { a: { type: 'string', enum: [1, 2] } } }), null, 'elicit: a non-string enum is unsupported')
equal(fieldsOf({ type: 'object', properties: { a: { oneOf: [{ const: 'x' }] } } }), null, 'elicit: oneOf is unsupported')
equal(fieldsOf(undefined), null, 'elicit: no schema is unsupported')
equal(fieldsOf({ type: 'object', properties: {} })?.length, 0, 'elicit: an empty object is an empty form')

const v = initialValues(fields)
ok(v.agree === true && v.name === '' && v.plan === '', 'elicit: defaults seed the values')
equal(fieldError(fields[0], ''), 'Your name is required.', 'elicit: empty required text names its field')
equal(fieldError(fields[0], '   '), 'Your name is required.', 'elicit: whitespace is empty')
equal(fieldError(fields[0], 'a'), 'Use at least 2 characters.', 'elicit: minLength')
equal(fieldError(fields[1], ''), null, 'elicit: empty optional number is fine')
equal(fieldError(fields[1], '2.5'), 'Enter a whole number.', 'elicit: integer rejects a fraction')
equal(fieldError(fields[1], '11'), 'Enter a number from 1 to 10.', 'elicit: out of range names the range')
equal(fieldError(fields[2], 'abc'), 'Enter a number.', 'elicit: not a number')
equal(fieldError(fields[4], ''), 'plan is required.', 'elicit: a required enum left on its placeholder fails')

equal(contentOf(fields, v), null, 'elicit: no payload while a required field is empty')
const content = contentOf(fields, { ...v, name: 'Ada', seats: '3', plan: 'pro', agree: false })
equal(JSON.stringify(content), '{"name":"Ada","seats":3,"agree":false,"plan":"pro"}', 'elicit: payload is typed and skips empty optionals')

equal(linkOf('https://example.com/auth?x=1').host, 'example.com', 'link: https host')
equal(linkOf('http://example.com').scheme, 'http', 'link: http is flagged')
equal(linkOf('https://exаmple.com').host, 'xn--exmple-4nf.com', 'link: a non-ASCII host shows as punycode')
equal(linkOf('javascript:alert(1)').scheme, 'other', 'link: javascript: is not openable')
equal(linkOf('file:///etc/passwd').scheme, 'other', 'link: file: is not openable')
equal(linkOf(undefined).scheme, 'other', 'link: no url')

equal(requestOf({ serverName: 's', message: 'm', mode: 'url' })?.mode, 'url', 'request: well-formed input')
equal(requestOf({ serverName: 's', message: 'm', mode: 'other' }), null, 'request: unknown mode')
