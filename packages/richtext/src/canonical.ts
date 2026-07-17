/** §5.2 normative canonical inner-JSON algorithm. Byte-stable string for a JSON value. */
export function canonicalizeInnerJson(value: unknown): string {
  return serialize(value, new WeakSet<object>())
}

function isPlainObject(v: object): v is Record<string, unknown> {
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function serialize(value: unknown, ancestors: WeakSet<object>): string {
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
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error('canonical: cycle rejected')
    ancestors.add(value)
    try {
      const items: string[] = []
      for (let index = 0; index < value.length; index += 1) {
        items.push(serialize(value[index], ancestors))
      }
      return `[${items.join(',')}]`
    } finally {
      ancestors.delete(value)
    }
  }
  if (t === 'object') {
    const obj = value as object
    if (!isPlainObject(obj)) throw new Error('canonical: non-plain object rejected')
    if (ancestors.has(obj)) throw new Error('canonical: cycle rejected')
    ancestors.add(obj)
    try {
      const keys = Object.keys(obj).sort()
      return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(obj[k], ancestors)}`).join(',')}}`
    } finally {
      ancestors.delete(obj)
    }
  }
  throw new Error(`canonical: unsupported value of type ${t}`)
}
