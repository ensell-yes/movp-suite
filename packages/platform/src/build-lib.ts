import { createHash } from 'node:crypto'
import {
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  assertRealDirectory,
  MAX_MIGRATION_BYTES,
  verifyPlatformArtifact,
  type PlatformManifest,
} from './verify.ts'

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function assertSafeSourceMigration(path: string, name: string): void {
  const info = lstatSync(path, { throwIfNoEntry: false })
  if (!info) throw new Error(`source migration missing: ${name}`)
  if (info.isSymbolicLink()) throw new Error(`refusing to read symlinked source migration: ${name}`)
  if (!info.isFile()) throw new Error(`source migration is not a regular file: ${name}`)
  if (info.size > MAX_MIGRATION_BYTES) throw new Error(`source migration exceeds size bound: ${name}`)
}

export function buildPlatformArtifact(opts: {
  sourceMigrations: string
  outDir: string
  platformVersion: string
  metadata: PlatformManifest['metadata']
}): PlatformManifest {
  assertRealDirectory(opts.sourceMigrations, 'source migrations directory')
  const outMigrations = join(opts.outDir, 'migrations')
  rmSync(outMigrations, { recursive: true, force: true })
  rmSync(join(opts.outDir, 'manifest.json'), { force: true })
  mkdirSync(outMigrations, { recursive: true })

  const files = readdirSync(opts.sourceMigrations)
    .filter((name) => name.endsWith('.sql'))
    .sort()

  const manifest: PlatformManifest = {
    platformVersion: opts.platformVersion,
    metadata: opts.metadata,
    files: files.map((name) => {
      const srcPath = join(opts.sourceMigrations, name)
      assertSafeSourceMigration(srcPath, name)
      const bytes = readFileSync(srcPath)
      copyFileSync(srcPath, join(outMigrations, name), constants.COPYFILE_EXCL)
      return { name, sha256: sha256Hex(bytes) }
    }),
  }

  writeFileSync(join(opts.outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  verifyPlatformArtifact(opts.outDir)
  return manifest
}
