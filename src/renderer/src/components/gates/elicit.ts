import type { ElicitationRequest, ElicitationResponse } from '../../../../shared/events'

export type ElicitContent = NonNullable<ElicitationResponse['content']>

interface FieldBase {
  key: string
  label: string
  description?: string
  required: boolean
}

/** One form-mode field. Text and number fields hold their draft as a string until submit. */
export type ElicitField =
  | (FieldBase & { kind: 'string'; minLength?: number; maxLength?: number; initial: string })
  | (FieldBase & { kind: 'number'; integer: boolean; minimum?: number; maximum?: number; initial: string })
  | (FieldBase & { kind: 'boolean'; initial: boolean })
  | (FieldBase & { kind: 'enum'; options: { value: string; label: string }[]; initial: string })

export type ElicitValues = Record<string, string | boolean>

export function requestOf(input: unknown): ElicitationRequest | null {
  const r = input as Partial<ElicitationRequest> | null
  if (!r || typeof r.serverName !== 'string' || typeof r.message !== 'string') return null
  if (r.mode !== 'url' && r.mode !== 'form') return null
  return { ...r, serverName: r.serverName, message: r.message, mode: r.mode }
}

/** The host a url-mode request opens, and whether Clui will open it. `URL.hostname` gives a
 *  non-ASCII domain as punycode, so a lookalike can't pass for the real name. */
export function linkOf(url: string | undefined): { host: string; scheme: 'https' | 'http' | 'other' } {
  try {
    const u = new URL(url ?? '')
    if (u.protocol === 'https:' && u.hostname) return { host: u.hostname, scheme: 'https' }
    if (u.protocol === 'http:' && u.hostname) return { host: u.hostname, scheme: 'http' }
  } catch {
    /* not a URL */
  }
  return { host: '', scheme: 'other' }
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

/** The fields of a flat object schema of string, number, integer, boolean and string-enum
 *  properties. Anything else (nesting, arrays, oneOf) is null: the Gate declines it rather than
 *  sending an answer the server didn't ask for. */
export function fieldsOf(schema: unknown): ElicitField[] | null {
  if (!schema || typeof schema !== 'object') return null
  const s = schema as { type?: unknown; properties?: unknown; required?: unknown }
  if (s.type !== 'object' || !s.properties || typeof s.properties !== 'object' || Array.isArray(s.properties)) return null
  const required = new Set(Array.isArray(s.required) ? s.required.filter((k): k is string => typeof k === 'string') : [])
  const fields: ElicitField[] = []
  for (const [key, raw] of Object.entries(s.properties as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') return null
    const p = raw as Record<string, unknown>
    const base: FieldBase = { key, label: str(p.title) ?? key, description: str(p.description), required: required.has(key) }
    if (p.type === 'string' && Array.isArray(p.enum)) {
      if (!p.enum.length || !p.enum.every((v): v is string => typeof v === 'string')) return null
      const names = Array.isArray(p.enumNames) ? p.enumNames : []
      const options = p.enum.map((value, i) => ({ value, label: str(names[i]) ?? value }))
      const initial = typeof p.default === 'string' && p.enum.includes(p.default) ? p.default : ''
      fields.push({ ...base, kind: 'enum', options, initial })
    } else if (p.type === 'string') {
      fields.push({
        ...base,
        kind: 'string',
        minLength: num(p.minLength),
        maxLength: num(p.maxLength),
        initial: typeof p.default === 'string' ? p.default : ''
      })
    } else if (p.type === 'number' || p.type === 'integer') {
      fields.push({
        ...base,
        kind: 'number',
        integer: p.type === 'integer',
        minimum: num(p.minimum),
        maximum: num(p.maximum),
        initial: num(p.default)?.toString() ?? ''
      })
    } else if (p.type === 'boolean') {
      fields.push({ ...base, kind: 'boolean', initial: p.default === true })
    } else return null
  }
  return fields
}

export function initialValues(fields: ElicitField[]): ElicitValues {
  return Object.fromEntries(fields.map((f) => [f.key, f.initial]))
}

/** The field's problem, or null. Called only for touched fields, so an untouched one never shows red. */
export function fieldError(f: ElicitField, value: string | boolean | undefined): string | null {
  if (f.kind === 'boolean') return null
  const v = typeof value === 'string' ? value.trim() : ''
  if (!v) return f.required ? `${f.label} is required.` : null
  if (f.kind === 'string') {
    if (f.minLength !== undefined && v.length < f.minLength) return `Use at least ${f.minLength} characters.`
    if (f.maxLength !== undefined && v.length > f.maxLength) return `Use at most ${f.maxLength} characters.`
  }
  if (f.kind === 'number') {
    const n = Number(v)
    if (!Number.isFinite(n)) return 'Enter a number.'
    if (f.integer && !Number.isInteger(n)) return 'Enter a whole number.'
    const low = f.minimum !== undefined && n < f.minimum
    const high = f.maximum !== undefined && n > f.maximum
    if (low || high) {
      if (f.minimum !== undefined && f.maximum !== undefined) return `Enter a number from ${f.minimum} to ${f.maximum}.`
      return low ? `Enter a number of at least ${f.minimum}.` : `Enter a number of at most ${f.maximum}.`
    }
  }
  return null
}

/** The accept payload typed to the schema, or null while any field is invalid. An empty optional
 *  field is left out, not sent as "". */
export function contentOf(fields: ElicitField[], values: ElicitValues): ElicitContent | null {
  const out: ElicitContent = {}
  for (const f of fields) {
    const value = values[f.key]
    if (fieldError(f, value)) return null
    if (f.kind === 'boolean') {
      out[f.key] = value === true
      continue
    }
    const v = typeof value === 'string' ? value.trim() : ''
    if (!v) continue
    out[f.key] = f.kind === 'number' ? Number(v) : f.kind === 'string' ? (value as string) : v
  }
  return out
}
