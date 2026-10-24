import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isAllowedAdvisory, unexpectedAdvisories } from '../check-audit.mjs'

describe('dependency audit gate', () => {
  it('does not allow any advisory', () => {
    assert.equal(isAllowedAdvisory({}), false)
  })

  it('rejects every advisory', () => {
    const advisory = { github_advisory_id: 'GHSA-new', module_name: 'example', findings: [] }
    assert.equal(unexpectedAdvisories({ advisories: { advisory } }).length, 1)
  })
})
