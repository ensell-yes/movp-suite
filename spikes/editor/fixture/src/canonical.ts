/** §5.2 normative canonical inner-JSON algorithm. Byte-stable string for a JSON value. */
export function canonicalizeInnerJson(value: unknown): string {
  return serialize(value)
}

function isPlainObject(v: object): v is Record<string, unknown> {
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function serialize(value: unknown): string {
  if (value === null) return 'null'
  const t = typeof value
  if (t === 'string') return JSON.stringify(value)
  if (t === 'boolean') return value ? 'true' : 'false'
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical: non-finite number rejected')
    return JSON.stringify(value)
  }
  if (t === 'bigint') throw new Error('canonical: bigint rejected')
  if (t === 'undefined') throw new Error('canonical: undefined rejected')
  if (Array.isArray(value)) return `[${value.map((v) => serialize(v)).join(',')}]`
  if (t === 'object') {
    const obj = value as object
    if (!isPlainObject(obj)) throw new Error('canonical: non-plain object rejected')
    const keys = Object.keys(obj).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k])}`).join(',')}}`
  }
  throw new Error(`canonical: unsupported value of type ${t}`)
}
