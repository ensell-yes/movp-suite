import { lstatSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPlatformArtifact } from './build-lib.ts'
import { MAX_MANIFEST_BYTES } from './verify.ts'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = join(here, '..')
const repoRoot = join(packageDir, '..', '..')

function platformVersion(): string {
  const pkgPath = join(packageDir, 'package.json')
  const info = lstatSync(pkgPath, { throwIfNoEntry: false })
  if (!info) throw new Error('@movp/platform package.json missing')
  if (info.isSymbolicLink()) throw new Error('@movp/platform package.json is a symlink')
  if (!info.isFile()) throw new Error('@movp/platform package.json is not a regular file')
  if (info.size > MAX_MANIFEST_BYTES) throw new Error('@movp/platform package.json exceeds size bound')

  let pkg: unknown
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch {
    throw new Error('@movp/platform package.json is not valid JSON')
  }
  if (typeof pkg !== 'object' || pkg === null || Array.isArray(pkg)) {
    throw new Error('@movp/platform package.json is not an object')
  }
  const version = (pkg as { version?: unknown }).version
  if (typeof version !== 'string') throw new Error('@movp/platform package.json has no string version')
  return version
}

const manifest = buildPlatformArtifact({
  sourceMigrations: join(repoRoot, 'supabase', 'migrations'),
  outDir: join(packageDir, 'dist'),
  platformVersion: platformVersion(),
})
console.log(
  `@movp/platform: bundled ${manifest.files.length} migrations (platformVersion ${manifest.platformVersion})`,
)
