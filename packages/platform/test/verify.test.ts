import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyPlatformArtifact } from '../src/verify.ts'

function sha(body: string): string {
  return createHash('sha256').update(Buffer.from(body)).digest('hex')
}

const files = [
  { name: '20260701000001_a.sql', body: '-- a\n' },
  { name: '20260701000002_b.sql', body: '-- b\n' },
]

function writeArtifact(dir: string, order?: string[]): void {
  mkdirSync(join(dir, 'migrations'), { recursive: true })
  for (const f of files) writeFileSync(join(dir, 'migrations', f.name), f.body)
  const manifestFiles = (order ?? files.map((f) => f.name)).map((name) => ({
    name,
    sha256: sha(files.find((f) => f.name === name)!.body),
  }))
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ platformVersion: '0.0.0', files: manifestFiles }, null, 2),
  )
}

describe('verifyPlatformArtifact', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'movp-platform-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('accepts a well-formed artifact', () => {
    writeArtifact(dir)
    expect(() => verifyPlatformArtifact(dir)).not.toThrow()
  })

  it('rejects a missing migration', () => {
    writeArtifact(dir)
    rmSync(join(dir, 'migrations', '20260701000002_b.sql'))
    expect(() => verifyPlatformArtifact(dir)).toThrow(/platform_artifact_invalid/)
  })

  it('rejects an extra migration not in the manifest', () => {
    writeArtifact(dir)
    writeFileSync(join(dir, 'migrations', '20260701000003_c.sql'), '-- c\n')
    expect(() => verifyPlatformArtifact(dir)).toThrow(/platform_artifact_invalid/)
  })

  it('rejects a reordered manifest', () => {
    writeArtifact(dir, ['20260701000002_b.sql', '20260701000001_a.sql'])
    expect(() => verifyPlatformArtifact(dir)).toThrow(/platform_artifact_invalid/)
  })

  it('rejects a digest mismatch', () => {
    writeArtifact(dir)
    writeFileSync(join(dir, 'migrations', '20260701000001_a.sql'), '-- tampered\n')
    expect(() => verifyPlatformArtifact(dir)).toThrow(/platform_artifact_invalid/)
  })

  it('rejects a symlinked migration even when its target bytes match', () => {
    writeArtifact(dir)
    const outside = join(dir, 'outside.sql')
    writeFileSync(outside, '-- a\n')
    rmSync(join(dir, 'migrations', '20260701000001_a.sql'))
    symlinkSync(outside, join(dir, 'migrations', '20260701000001_a.sql'))
    expect(() => verifyPlatformArtifact(dir)).toThrow(/symlink/)
  })

  it('rejects an oversized manifest on its size bound (never buffers it)', () => {
    writeArtifact(dir)
    const huge = `{"platformVersion":"0.0.0","files":[],"pad":"${'x'.repeat(1024 * 1024 + 16)}"}`
    writeFileSync(join(dir, 'manifest.json'), huge)
    expect(() => verifyPlatformArtifact(dir)).toThrow(/platform_artifact_invalid/)
  })

  it('rejects malformed JSON without exposing its content', () => {
    mkdirSync(join(dir, 'migrations'), { recursive: true })
    writeFileSync(join(dir, 'manifest.json'), 'aws_secret_access_key = SUPERSECRET\n')
    let message = ''
    try {
      verifyPlatformArtifact(dir)
    } catch (error: unknown) {
      message = String(error)
    }
    expect(message).toMatch(/platform_artifact_invalid/)
    expect(message).not.toMatch(/SUPERSECRET|aws_secret/)
  })
})
