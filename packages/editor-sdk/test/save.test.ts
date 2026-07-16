import { describe, expect, it } from 'vitest'
import { classifySaveOutcome, type SaveResult } from '../src/save.ts'

describe('classifySaveOutcome', () => {
  it('maps a domain content_update_conflict error to conflict', () => {
    const err = new Error('domain.content.update failed [content_update_conflict]')
    expect(classifySaveOutcome(err)).toEqual<SaveResult>({ status: 'conflict' })
  })
  it('maps a GraphQL CONFLICT extension code to conflict', () => {
    const err = { extensions: { code: 'CONFLICT' } }
    expect(classifySaveOutcome(err)).toEqual<SaveResult>({ status: 'conflict' })
  })
  it('normalizes any other error to save_failed and never leaks the message', () => {
    const err = new Error('connect ECONNREFUSED 10.0.0.1:5432 secret-token')
    const out = classifySaveOutcome(err)
    expect(out).toEqual<SaveResult>({ status: 'error', code: 'save_failed' })
    expect(JSON.stringify(out)).not.toContain('ECONNREFUSED')
    expect(JSON.stringify(out)).not.toContain('secret-token')
  })
  it('normalizes a non-Error value to save_failed', () => {
    expect(classifySaveOutcome(null)).toEqual<SaveResult>({ status: 'error', code: 'save_failed' })
  })
})
