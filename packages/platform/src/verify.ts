import { createHash } from 'node:crypto'
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface PlatformManifestEntry {
  name: string
  sha256: string
}

export interface PlatformManifest {
  platformVersion: string
  files: PlatformManifestEntry[]
}

export const MAX_MIGRATION_BYTES = 10 * 1024 * 1024
export const MAX_MANIFEST_BYTES = 1 * 1024 * 1024

export class PlatformArtifactError extends Error {
  readonly code = 'platform_artifact_invalid'
  constructor(reason: string) {
    super(`platform_artifact_invalid: ${reason}`)
    this.name = 'PlatformArtifactError'
  }
}

export function assertRealDirectory(path: string, label: string): void {
  const info = lstatSync(path, { throwIfNoEntry: false })
  if (!info) throw new PlatformArtifactError(`${label} missing`)
  if (info.isSymbolicLink()) throw new PlatformArtifactError(`${label} is a symlink`)
  if (!info.isDirectory()) throw new PlatformArtifactError(`${label} is not a directory`)
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function readManifest(dir: string): PlatformManifest {
  const manifestPath = join(dir, 'manifest.json')
  const info = lstatSync(manifestPath, { throwIfNoEntry: false })
  if (!info) throw new PlatformArtifactError('manifest.json missing')
  if (info.isSymbolicLink()) throw new PlatformArtifactError('manifest.json is a symlink')
  if (!info.isFile()) throw new PlatformArtifactError('manifest.json is not a regular file')
  if (info.size > MAX_MANIFEST_BYTES) throw new PlatformArtifactError('manifest.json exceeds size bound')

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    throw new PlatformArtifactError('manifest.json is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new PlatformArtifactError('manifest.json is not an object')
  }
  const version = (parsed as { platformVersion?: unknown }).platformVersion
  const rawFiles = (parsed as { files?: unknown }).files
  if (typeof version !== 'string' || !Array.isArray(rawFiles)) {
    throw new PlatformArtifactError('manifest.json is missing platformVersion or files')
  }
  const files = rawFiles.map((entry, i): PlatformManifestEntry => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new PlatformArtifactError(`manifest.json files[${i}] is not an object`)
    }
    const name = (entry as { name?: unknown }).name
    const sha256 = (entry as { sha256?: unknown }).sha256
    if (typeof name !== 'string' || typeof sha256 !== 'string') {
      throw new PlatformArtifactError(`manifest.json files[${i}] is malformed`)
    }
    return { name, sha256 }
  })
  return { platformVersion: version, files }
}

export function verifyPlatformArtifact(dir: string): void {
  assertRealDirectory(dir, 'artifact directory')
  const manifest = readManifest(dir)
  const migrationsDir = join(dir, 'migrations')
  assertRealDirectory(migrationsDir, 'migrations/ directory')

  const present = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()

  const expected = manifest.files.map((f) => f.name)
  const expectedSet = new Set(expected)
  const presentSet = new Set(present)

  for (const name of present) {
    if (!expectedSet.has(name)) throw new PlatformArtifactError(`extra migration not in manifest: ${name}`)
  }
  for (const name of expected) {
    if (!presentSet.has(name)) throw new PlatformArtifactError(`manifest migration missing on disk: ${name}`)
  }

  const expectedSorted = [...expected].sort()
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] !== expectedSorted[i]) {
      throw new PlatformArtifactError(`manifest files are not in applied order at index ${i}: ${expected[i]}`)
    }
  }

  for (const { name, sha256 } of manifest.files) {
    const filePath = join(migrationsDir, name)
    const info = lstatSync(filePath, { throwIfNoEntry: false })
    if (!info) throw new PlatformArtifactError(`manifest migration missing on disk: ${name}`)
    if (info.isSymbolicLink()) throw new PlatformArtifactError(`migration is a symlink: ${name}`)
    if (!info.isFile()) throw new PlatformArtifactError(`migration is not a regular file: ${name}`)
    if (info.size > MAX_MIGRATION_BYTES) throw new PlatformArtifactError(`migration exceeds size bound: ${name}`)
    if (sha256Hex(readFileSync(filePath)) !== sha256) {
      throw new PlatformArtifactError(`digest mismatch for ${name}`)
    }
  }
}
