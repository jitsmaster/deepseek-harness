/**
 * Narrow string-to-scalar coercion for model-generated tool arguments.
 * Deliberate limits: only top-level properties whose declared `type` is the
 * literal `number`, `integer` or `boolean` are coerced; union/array types,
 * `oneOf`/`$ref` and nested properties are left strict. Coerced values reach
 * only the tool itself (`execute`, `output.render`, `output.presentationMeta`,
 * `isConcurrencySafe`); `exec.arguments`, hooks, guards and the log keep the
 * model's raw value. Tools whose `parameters` come from an outside
 * source (for example an MCP server) and that do no validation of their own
 * now receive the declared scalar type instead of a rejected string.
 * @module
 */

/** A plain decimal number: optional minus, up to 15 integer digits, optional short fraction. */
const CLEAN_NUMBER = /^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,10})?$/
/** A plain integer: optional minus, no leading zeros, up to 15 digits. */
const CLEAN_INTEGER = /^-?(?:0|[1-9]\d{0,14})$/

/**
 * Convert a clean numeric string to a number.
 * @param value - candidate string.
 * @param integer - require an integer.
 * @returns the number, or undefined when the string is not a plain number (or is negative zero).
 */
function cleanNumber(value: string, integer: boolean): number | undefined {
  if (!(integer ? CLEAN_INTEGER : CLEAN_NUMBER).test(value)) return undefined
  // More than 15 significant digits can be rounded by Number(); leave such strings to be rejected.
  if (value.replace(/[-.]/g, '').replace(/^0+(?=\d)/, '').length > 15) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && !Object.is(parsed, -0) ? parsed : undefined
}

/**
 * Coerce one scalar when its schema type is number, integer, or boolean and the
 * value is a clean string of that type. Anything else is returned unchanged.
 * @param type - declared JSON Schema type of the property.
 * @param value - candidate value.
 * @returns the coerced scalar, or the original value.
 */
function coerceScalar(type: unknown, value: unknown): unknown {
  if (typeof value !== 'string') return value
  if (type === 'number' || type === 'integer') return cleanNumber(value, type === 'integer') ?? value
  if (type === 'boolean') return value === 'true' ? true : value === 'false' ? false : value
  return value
}

/**
 * Coerce clean numeric and boolean strings in the top-level properties of a tool
 * call's arguments, using the tool's declared parameter schema. Objects, arrays,
 * string-typed parameters and non-clean strings are never touched.
 * @param parameters - the tool's JSON Schema parameters object.
 * @param args - parsed (possibly frozen) arguments.
 * @returns the original args when nothing changed, otherwise a shallow copy with coerced scalars.
 */
export function coerceScalarArgs<T>(parameters: unknown, args: T): T {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return args
  if (typeof parameters !== 'object' || parameters === null) return args
  const properties = (parameters as { properties?: unknown }).properties
  if (typeof properties !== 'object' || properties === null) return args
  let copy: Record<string, unknown> | undefined
  for (const [key, schema] of Object.entries(properties)) {
    if (!Object.hasOwn(args, key)) continue
    const current = (args as Record<string, unknown>)[key]
    const type = typeof schema === 'object' && schema !== null ? (schema as { type?: unknown }).type : undefined
    const next = coerceScalar(type, current)
    if (next !== current) {
      copy ??= { ...(args as Record<string, unknown>) }
      copy[key] = next
    }
  }
  return (copy ?? args) as T
}

/**
 * Extra guidance for a validation failure on a quoted scalar.
 * @param type - declared type that failed.
 * @param value - the offending value.
 * @returns a `: pass a JSON ... without quotes, e.g. <value>` suffix, or '' when the value is not a clean quoted scalar of that type.
 */
export function quotedScalarHint(type: 'number' | 'integer' | 'boolean', value: unknown): string {
  if (typeof value !== 'string') return ''
  if (type === 'boolean') {
    return value === 'true' || value === 'false' ? `: pass a JSON boolean without quotes, e.g. ${value}` : ''
  }
  return cleanNumber(value, type === 'integer') === undefined ? '' : `: pass a JSON number without quotes, e.g. ${value}`
}
