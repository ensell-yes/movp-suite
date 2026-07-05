import { describe, expect, it } from 'vitest'
import { evaluateCondition } from '../src/condition.ts'

const payload = {
  entity_type: 'task',
  count: 3,
  payload: { status: { to: 'done' } },
}

describe('evaluateCondition', () => {
  it('matches empty conditions', () => {
    expect(evaluateCondition(null, payload)).toEqual({ ok: true, matched: true })
    expect(evaluateCondition({}, payload)).toEqual({ ok: true, matched: true })
  })

  it('evaluates field operators without coercion', () => {
    expect(evaluateCondition({ field: 'entity_type', op: 'eq', value: 'task' }, payload)).toEqual({ ok: true, matched: true })
    expect(evaluateCondition({ field: 'entity_type', op: 'neq', value: 'note' }, payload)).toEqual({ ok: true, matched: true })
    expect(evaluateCondition({ field: 'entity_type', op: 'in', value: ['task', 'note'] }, payload)).toEqual({ ok: true, matched: true })
    expect(evaluateCondition({ field: 'entity_type', op: 'exists' }, payload)).toEqual({ ok: true, matched: true })
    expect(evaluateCondition({ field: 'count', op: 'gt', value: 2 }, payload)).toEqual({ ok: true, matched: true })
    expect(evaluateCondition({ field: 'count', op: 'gte', value: 3 }, payload)).toEqual({ ok: true, matched: true })
    expect(evaluateCondition({ field: 'count', op: 'lt', value: 4 }, payload)).toEqual({ ok: true, matched: true })
    expect(evaluateCondition({ field: 'count', op: 'lte', value: 3 }, payload)).toEqual({ ok: true, matched: true })
    expect(evaluateCondition({ field: 'count', op: 'gt', value: '2' }, payload)).toEqual({ ok: true, matched: false })
  })

  it('supports boolean composition and nested dot paths', () => {
    expect(evaluateCondition({
      and: [
        { field: 'payload.status.to', op: 'eq', value: 'done' },
        { not: { field: 'entity_type', op: 'eq', value: 'note' } },
      ],
    }, payload)).toEqual({ ok: true, matched: true })
    expect(evaluateCondition({
      or: [
        { field: 'entity_type', op: 'eq', value: 'note' },
        { field: 'payload.status.to', op: 'eq', value: 'done' },
      ],
    }, payload)).toEqual({ ok: true, matched: true })
  })

  it('fails closed on invalid operators and unsafe paths', () => {
    expect(evaluateCondition({ field: 'entity_type', op: 'contains', value: 'task' }, payload))
      .toEqual({ ok: false, errorCode: 'condition_unknown_operator' })
    expect(evaluateCondition({ field: '__proto__.polluted', op: 'exists' }, payload)).toEqual({ ok: true, matched: false })
  })

  it('enforces depth and node bounds', () => {
    let tooDeep: unknown = { field: 'entity_type', op: 'eq', value: 'task' }
    for (let i = 0; i < 6; i++) tooDeep = { not: tooDeep }
    expect(evaluateCondition(tooDeep, payload)).toEqual({ ok: false, errorCode: 'condition_too_deep' })

    const tooMany = { and: Array.from({ length: 51 }, () => ({ field: 'entity_type', op: 'eq', value: 'task' })) }
    expect(evaluateCondition(tooMany, payload)).toEqual({ ok: false, errorCode: 'condition_too_large' })
  })
})
