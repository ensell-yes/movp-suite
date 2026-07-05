const MAX_DEPTH = 5
const MAX_NODES = 50
const BLOCKED_PATH = new Set(['__proto__', 'prototype', 'constructor'])

export type ConditionResult =
  | { ok: true; matched: boolean }
  | { ok: false; errorCode: 'condition_invalid' | 'condition_too_deep' | 'condition_too_large' | 'condition_unknown_operator' }

function readPath(payload: Record<string, unknown>, path: string): unknown {
  let cur: unknown = payload
  for (const part of path.split('.')) {
    if (!part || BLOCKED_PATH.has(part)) return undefined
    if (cur == null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function visit(node: unknown, payload: Record<string, unknown>, depth: number, count: { n: number }): ConditionResult {
  if (depth > MAX_DEPTH) return { ok: false, errorCode: 'condition_too_deep' }
  if (++count.n > MAX_NODES) return { ok: false, errorCode: 'condition_too_large' }
  if (node == null || (typeof node === 'object' && Object.keys(node as object).length === 0)) return { ok: true, matched: true }
  if (typeof node !== 'object') return { ok: false, errorCode: 'condition_invalid' }
  const n = node as Record<string, unknown>

  if (Array.isArray(n.and)) {
    for (const child of n.and) {
      const r = visit(child, payload, depth + 1, count)
      if (!r.ok || !r.matched) return r
    }
    return { ok: true, matched: true }
  }
  if (Array.isArray(n.or)) {
    let any = false
    for (const child of n.or) {
      const r = visit(child, payload, depth + 1, count)
      if (!r.ok) return r
      any ||= r.matched
    }
    return { ok: true, matched: any }
  }
  if ('not' in n) {
    const r = visit(n.not, payload, depth + 1, count)
    return r.ok ? { ok: true, matched: !r.matched } : r
  }

  if (typeof n.field !== 'string' || typeof n.op !== 'string') return { ok: false, errorCode: 'condition_invalid' }
  const actual = readPath(payload, n.field)
  switch (n.op) {
    case 'exists':
      return { ok: true, matched: actual !== undefined }
    case 'eq':
      return { ok: true, matched: actual === n.value }
    case 'neq':
      return { ok: true, matched: actual !== n.value }
    case 'in':
      return { ok: true, matched: Array.isArray(n.value) && n.value.includes(actual) }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
      if (typeof actual !== 'number' || typeof n.value !== 'number') return { ok: true, matched: false }
      if (n.op === 'gt') return { ok: true, matched: actual > n.value }
      if (n.op === 'gte') return { ok: true, matched: actual >= n.value }
      if (n.op === 'lt') return { ok: true, matched: actual < n.value }
      return { ok: true, matched: actual <= n.value }
    default:
      return { ok: false, errorCode: 'condition_unknown_operator' }
  }
}

export function evaluateCondition(condition: unknown, payload: Record<string, unknown>): ConditionResult {
  return visit(condition, payload, 0, { n: 0 })
}
