import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { MAX_MANIFEST_BYTES, readJsonGuarded, readTextGuarded } from '../lib/guarded-read.mjs'

// Synthetic fixtures under $TMPDIR only. NO writes under the real repository (INTERFACES round-5 F1).
let work = ''
before(() => { work = mkdtempSync(join(tmpdir(), 'movp-guarded-read-')) })
after(() => rmSync(work, { recursive: true, force: true }))

// `chmod 000` does NOT deny root (it ignores the mode bits) and does not remove read access on win32,
// so the EACCES case is SKIPPED there rather than asserted falsely. Every other case is portable.
const canDenyRead =
  process.platform !== 'win32' && typeof process.getuid === 'function' && process.getuid() !== 0

// `readTextGuarded` is THE primitive — `readJsonGuarded` is built on top of it, so these guards are
// tested once and inherited. The `codePrefix` argument keeps each caller's error-code set closed:
// 'manifest' for package.json, 'workflow' for ci.yml, 'file' by default.
describe('readTextGuarded', () => {
  const TEXT_MAX = 1024

  it('returns the file contents for a regular, in-bounds file', () => {
    const path = join(work, 'ok.txt')
    writeFileSync(path, 'jobs:\n')
    assert.equal(readTextGuarded(path, TEXT_MAX, 'workflow'), 'jobs:\n')
  })

  it('rejects a symlink WITHOUT reading its target', () => {
    const secret = join(work, 'text-credentials')
    writeFileSync(secret, 'aws_secret_access_key = SUPERSECRET\n')
    const path = join(work, 'linked.yml')
    symlinkSync(secret, path) // .github/workflows/ci.yml -> ~/.aws/credentials
    assert.throws(() => readTextGuarded(path, TEXT_MAX, 'workflow'), (err) => {
      assert.match(String(err), /workflow_symlink_rejected/)
      assert.doesNotMatch(String(err), /SUPERSECRET|aws_secret/) // the target was never opened
      return true
    })
  })

  it('rejects a non-regular file (a directory)', () => {
    const dir = join(work, 'text-dir')
    mkdirSync(dir)
    assert.throws(() => readTextGuarded(dir, TEXT_MAX, 'workflow'), /workflow_not_regular_file/)
  })

  it('rejects an oversized file BEFORE buffering it', () => {
    const path = join(work, 'big.yml')
    writeFileSync(path, 'x'.repeat(TEXT_MAX + 1))
    assert.throws(() => readTextGuarded(path, TEXT_MAX, 'workflow'), /workflow_too_large/)
  })

  it('throws <prefix>_unreadable (not a raw ENOENT) for a missing file', () => {
    assert.throws(() => readTextGuarded(join(work, 'nope.yml'), TEXT_MAX, 'workflow'), (err) => {
      assert.match(String(err), /workflow_unreadable: .* cannot be inspected/)
      assert.doesNotMatch(String(err), /ENOENT|no such file/)
      return true
    })
  })

  it('throws <prefix>_unreadable (not a raw EACCES) for an unreadable file', { skip: !canDenyRead }, () => {
    const path = join(work, 'text-noperm.yml')
    writeFileSync(path, 'jobs:\n')
    chmodSync(path, 0o000) // lstat still succeeds; the READ is what fails
    try {
      assert.throws(() => readTextGuarded(path, TEXT_MAX, 'workflow'), (err) => {
        assert.match(String(err), /workflow_unreadable: .* cannot be read/)
        assert.doesNotMatch(String(err), /EACCES|permission denied/)
        return true
      })
    } finally {
      chmodSync(path, 0o600) // restore so the `after` hook can remove the temp tree
    }
  })
})

describe('readJsonGuarded', () => {
  it('returns the parsed manifest for a regular, valid file', () => {
    const path = join(work, 'ok.json')
    writeFileSync(path, JSON.stringify({ name: '@movp/auth', version: '0.1.0' }))
    assert.equal(readJsonGuarded(path).version, '0.1.0')
  })

  it('rejects a symlink WITHOUT reading its target', () => {
    const secret = join(work, 'credentials')
    writeFileSync(secret, 'aws_secret_access_key = SUPERSECRET\n')
    const path = join(work, 'linked.json')
    symlinkSync(secret, path) // packages/auth/package.json -> ~/.aws/credentials
    assert.throws(() => readJsonGuarded(path), (err) => {
      assert.match(String(err), /manifest_symlink_rejected/)
      assert.doesNotMatch(String(err), /SUPERSECRET|aws_secret/) // the target was never opened
      return true
    })
  })

  it('rejects a non-regular file (a directory)', () => {
    const dir = join(work, 'a-dir')
    mkdirSync(dir)
    assert.throws(() => readJsonGuarded(dir), /manifest_not_regular_file/)
  })

  it('rejects an oversized file BEFORE buffering it', () => {
    const path = join(work, 'big.json')
    writeFileSync(path, `{"name":"x","version":"0.1.0","pad":"${'x'.repeat(MAX_MANIFEST_BYTES)}"}`)
    assert.throws(() => readJsonGuarded(path), /manifest_too_large/)
  })

  // THE leak: `JSON.parse` throws `Unexpected token 'a', "aws_secret"... is not valid JSON`. Re-throwing
  // that message — or including `err.message` in ours — prints the file's bytes to CI. Assert it cannot.
  it('rejects malformed JSON WITHOUT echoing the file content', () => {
    const path = join(work, 'bad.json')
    writeFileSync(path, 'aws_secret_access_key = SUPERSECRET\n')
    assert.throws(() => readJsonGuarded(path), (err) => {
      assert.match(String(err), /manifest_unreadable: .* is not valid JSON/) // a CONTENT fault
      assert.doesNotMatch(String(err), /SUPERSECRET|aws_secret/)
      return true
    })
  })

  // I/O faults must stay INSIDE the closed `manifest_*` set — a raw ENOENT/EACCES escaping it is a
  // gate that crashes instead of diagnosing. The reason must stay DISTINCT from "is not valid JSON":
  // "cannot be read" and "is not valid JSON" have different remedies, and conflating them loses that.
  it('throws manifest_unreadable (not a raw ENOENT) for a missing manifest', () => {
    const path = join(work, 'does-not-exist.json')
    assert.throws(() => readJsonGuarded(path), (err) => {
      assert.match(String(err), /manifest_unreadable: .* cannot be inspected/) // an I/O fault
      assert.doesNotMatch(String(err), /ENOENT|no such file/)
      return true
    })
  })

  it('throws manifest_unreadable (not a raw EACCES) for an unreadable manifest', { skip: !canDenyRead }, () => {
    const path = join(work, 'noperm.json')
    writeFileSync(path, JSON.stringify({ name: '@movp/auth', version: '0.1.0' }))
    chmodSync(path, 0o000) // lstat still succeeds; the READ is what fails
    try {
      assert.throws(() => readJsonGuarded(path), (err) => {
        assert.match(String(err), /manifest_unreadable: .* cannot be read/)
        assert.doesNotMatch(String(err), /EACCES|permission denied/)
        return true
      })
    } finally {
      chmodSync(path, 0o600) // restore so the `after` hook can remove the temp tree
    }
  })

  it('rejects a parseable-but-structurally-invalid manifest (parseable is not valid)', () => {
    const path = join(work, 'shape.json')
    writeFileSync(path, JSON.stringify({ name: 123, version: '0.1.0' }))
    assert.throws(() => readJsonGuarded(path), /manifest_invalid_shape/)
  })
})
