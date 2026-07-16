import { describe, expect, it } from 'vitest'
import { FIXTURE_FIELD_SCHEMA, SEED_RECORD } from '../src/schema.ts'

describe('fixture', () => {
  it('is multi-field with exactly one richtext field named body', () => {
    const rich = FIXTURE_FIELD_SCHEMA.filter((f) => f.type === 'richtext')
    expect(rich).toHaveLength(1)
    expect(rich[0]?.name).toBe('body')
    expect(FIXTURE_FIELD_SCHEMA.map((f) => f.name)).toEqual(['title', 'body', 'meta'])
  })
  it('seed record carries a blank body and non-empty meta', () => {
    expect(SEED_RECORD.body).toBe('')
    expect(SEED_RECORD.meta).toEqual({ locale: 'en', tags: ['spike', 'editor'] })
  })
})
