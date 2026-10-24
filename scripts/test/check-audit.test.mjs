import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isAllowedAdvisory, unexpectedAdvisories } from '../check-audit.mjs'

const allowed = {
  github_advisory_id: 'GHSA-ch52-4w7c-c8xp',
  module_name: 'http-cache-semantics',
  severity: 'high',
  patched_versions: '<0.0.0',
  findings: [{ paths: ['. > verdaccio@6.8.0 > @verdaccio/hooks@8.0.4 > got-cjs@12.5.4 > cacheable-request@7.0.2 > http-cache-semantics@4.2.0'] }],
}

describe('dependency audit gate', () => {
  it('allows only the documented upstream-unfixable Verdaccio advisory', () => {
    assert.equal(isAllowedAdvisory(allowed), true)
    assert.deepEqual(unexpectedAdvisories({ advisories: { known: allowed } }), [])
  })

  it('rejects the advisory when its dependency path changes', () => {
    const changed = { ...allowed, findings: [{ paths: ['. > another-package > http-cache-semantics@4.2.0'] }] }
    assert.equal(isAllowedAdvisory(changed), false)
    assert.equal(unexpectedAdvisories({ advisories: { changed } }).length, 1)
  })

  it('rejects any additional advisory', () => {
    const additional = { ...allowed, github_advisory_id: 'GHSA-new' }
    assert.equal(unexpectedAdvisories({ advisories: { known: allowed, additional } }).length, 1)
  })
})
