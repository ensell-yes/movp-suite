import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildPlatformArtifact } from '../src/build-lib.ts'

describe('buildPlatformArtifact untrusted-I/O guards', () => {
  let root: string
  let src: string
  let out: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'movp-platform-build-'))
    src = join(root, 'src-migrations')
    out = join(root, 'dist')
    mkdirSync(src, { recursive: true })
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('bundles well-formed source migrations', () => {
    writeFileSync(join(src, '20260101000001_a.sql'), '-- a\n')
    const manifest = buildPlatformArtifact({ sourceMigrations: src, outDir: out, platformVersion: '0.0.0' })
    expect(manifest.files.map((f) => f.name)).toEqual(['20260101000001_a.sql'])
    expect(existsSync(join(out, 'migrations', '20260101000001_a.sql'))).toBe(true)
  })

  it('refuses a symlinked source migration and never copies its target bytes', () => {
    const secret = join(root, 'secret.txt')
    writeFileSync(secret, 'TOP SECRET\n')
    symlinkSync(secret, join(src, '20260101000001_evil.sql'))
    expect(() =>
      buildPlatformArtifact({ sourceMigrations: src, outDir: out, platformVersion: '0.0.0' }),
    ).toThrow(/symlink/)
    expect(existsSync(join(out, 'migrations', '20260101000001_evil.sql'))).toBe(false)
  })

  it('refuses a symlinked source migrations root before enumeration', () => {
    const outside = join(root, 'outside-migrations')
    mkdirSync(outside)
    writeFileSync(join(outside, '20260101000001_evil.sql'), '-- TOP SECRET\n')
    rmSync(src, { recursive: true })
    symlinkSync(outside, src)
    expect(() =>
      buildPlatformArtifact({ sourceMigrations: src, outDir: out, platformVersion: '0.0.0' }),
    ).toThrow(/source migrations directory.*symlink/)
    expect(existsSync(join(out, 'migrations', '20260101000001_evil.sql'))).toBe(false)
  })

  it('refuses an oversized source migration before buffering it', () => {
    writeFileSync(join(src, '20260101000002_big.sql'), 'x'.repeat(11 * 1024 * 1024))
    expect(() =>
      buildPlatformArtifact({ sourceMigrations: src, outDir: out, platformVersion: '0.0.0' }),
    ).toThrow(/size bound/)
  })
})
