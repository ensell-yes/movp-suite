import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  EXPECTED_VERSION, PUBLISHABLE, checkPublishableVersions, pinnedZeroConsumers,
} from '../check-publishable-versions.mjs'

// A SYNTHETIC repo root under $TMPDIR — the gate is driven against it, never against the real
// worktree, so no test writes under the repository (INTERFACES round-5 F1) and a dirty tree cannot
// flip a result.
let repoRoot = ''

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'movp-version-gate-'))
  for (const name of PUBLISHABLE) {
    mkdirSync(join(repoRoot, 'packages', name), { recursive: true })
    writeFileSync(
      join(repoRoot, 'packages', name, 'package.json'),
      `${JSON.stringify({ name: `@movp/${name}`, version: EXPECTED_VERSION }, null, 2)}\n`,
    )
  }
})
afterEach(() => rmSync(repoRoot, { recursive: true, force: true }))

/** A stubbed `spawnSync` result: `{ status, stdout, stderr, signal, error }`. */
const stubGit = (result) => () => ({ stdout: '', stderr: '', status: 0, signal: null, ...result })

describe('pinnedZeroConsumers — the git exit status is DISCRIMINATED, never swallowed', () => {
  it('status 0 → returns the matched lines', () => {
    const hit = 'templates/crm-lite/package.json.template:5:    "@movp/cli": "0.0.0",'
    assert.deepEqual(pinnedZeroConsumers(repoRoot, stubGit({ status: 0, stdout: `${hit}\n` })), [hit])
  })

  it('status 1 → no matches (the benign case)', () => {
    assert.deepEqual(pinnedZeroConsumers(repoRoot, stubGit({ status: 1 })), [])
  })

  it('status 2 → throws LOUDLY, carrying the status', () => {
    assert.throws(
      () => pinnedZeroConsumers(repoRoot, stubGit({ status: 2, stderr: 'fatal: not a git repository' })),
      /version_gate_git_failed: .*status=2/,
    )
  })

  it('a spawn error (git not installed) → throws LOUDLY', () => {
    const error = Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' })
    assert.throws(
      () => pinnedZeroConsumers(repoRoot, stubGit({ status: null, error })),
      /version_gate_git_failed: .*ENOENT/,
    )
  })
})

describe('checkPublishableVersions', () => {
  it('PASSES when every publishable matches EXPECTED_VERSION and git reports no match (status 1)', () => {
    assert.deepEqual(checkPublishableVersions(repoRoot, stubGit({ status: 1 })), [])
  })

  it('FAILS when git finds a 0.0.0 pin (status 0 with a match)', () => {
    const problems = checkPublishableVersions(
      repoRoot, stubGit({ status: 0, stdout: 'x/package.json:5:  "@movp/cli": "0.0.0",\n' }),
    )
    assert.equal(problems.length, 1)
    assert.match(problems[0], /pins a @movp dependency at 0\.0\.0/)
  })

  // The regression this gate's own bug produced: a broken git run must NOT look like a clean tree.
  it('FAILS LOUDLY on an operational git failure (status 2) — it does NOT report "no pins"', () => {
    assert.throws(() => checkPublishableVersions(repoRoot, stubGit({ status: 2 })), /version_gate_git_failed/)
  })

  it('FAILS when a publishable is still 0.0.0', () => {
    writeFileSync(
      join(repoRoot, 'packages', 'auth', 'package.json'),
      '{"name":"@movp/auth","version":"0.0.0"}\n',
    )
    const problems = checkPublishableVersions(repoRoot, stubGit({ status: 1 }))
    assert.equal(problems.length, 1)
    assert.equal(
      problems[0],
      `version check failed: @movp/auth is 0.0.0, expected ${EXPECTED_VERSION}`,
    )
  })

  it('THROWS on a symlinked manifest instead of following it, and leaks no target bytes', () => {
    const secret = join(repoRoot, 'credentials')
    writeFileSync(secret, 'aws_secret_access_key = SUPERSECRET\n')
    const manifest = join(repoRoot, 'packages', 'auth', 'package.json')
    rmSync(manifest)
    symlinkSync(secret, manifest)
    assert.throws(() => checkPublishableVersions(repoRoot, stubGit({ status: 1 })), (err) => {
      assert.match(String(err), /manifest_symlink_rejected/)
      assert.doesNotMatch(String(err), /SUPERSECRET/)
      return true
    })
  })
})
