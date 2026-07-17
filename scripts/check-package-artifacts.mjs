import { execFileSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const publishable = [
  'auth',
  'cli',
  'codegen',
  'core-schema',
  'create-movp',
  'domain',
  'editor-sdk',
  'flows',
  'graphql',
  'mcp',
  'notifications',
  'obs',
  'platform',
  'search',
]

const MAX_PACKAGE_MANIFEST_BYTES = 256 * 1024

function parseManifest(raw, label) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`package artifact check failed: ${label} is not valid JSON`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`package artifact check failed: ${label} is not an object`)
  }
  return parsed
}

function readManifest(path) {
  const info = lstatSync(path, { throwIfNoEntry: false })
  if (!info) throw new Error(`package artifact check failed: manifest missing: ${path}`)
  if (info.isSymbolicLink()) throw new Error(`package artifact check failed: manifest is a symlink: ${path}`)
  if (!info.isFile()) throw new Error(`package artifact check failed: manifest is not a regular file: ${path}`)
  if (info.size > MAX_PACKAGE_MANIFEST_BYTES) {
    throw new Error(`package artifact check failed: manifest exceeds size bound: ${path}`)
  }
  return parseManifest(readFileSync(path, 'utf8'), path)
}

execFileSync('pnpm', ['pack', '--help'], { stdio: 'pipe' })

for (const dirName of publishable) {
  const dir = join('packages', dirName)
  const pkg = readManifest(join(dir, 'package.json'))
  const collect = (value) => {
    const values = []
    if (!value) return values
    if (typeof value === 'string') {
      values.push(value)
      return values
    }
    if (Array.isArray(value)) {
      for (const item of value) values.push(...collect(item))
      return values
    }
    if (typeof value === 'object') {
      for (const item of Object.values(value)) values.push(...collect(item))
    }
    return values
  }
  const sourceEntrypoints = (manifest) => {
    const entryValues = [
      ...collect(manifest.main),
      ...collect(manifest.exports),
      ...collect(manifest.types),
      ...collect(manifest.bin),
    ]
    return entryValues.filter((value) => value.includes('/src/') || (value.endsWith('.ts') && !value.endsWith('.d.ts')))
  }

  const out = mkdtempSync(join(tmpdir(), `movp-pack-${dirName}-`))
  try {
    execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: dir, stdio: 'pipe' })
    const tgz = readdirSync(out).find((name) => name.endsWith('.tgz'))
    if (!tgz) throw new Error('missing tarball')
    const listing = execFileSync('tar', ['-tzf', join(out, tgz)], { encoding: 'utf8' })
    if (!listing.includes('package/dist/')) {
      console.error(`package artifact check failed: ${pkg.name} has no dist artifacts`)
      process.exit(1)
    }
    const packedManifest = parseManifest(
      execFileSync('tar', ['-xOzf', join(out, tgz), 'package/package.json'], { encoding: 'utf8' }),
      `${pkg.name ?? dirName} packed package.json`,
    )
    const packedSourceEntrypoints = sourceEntrypoints(packedManifest)
    if (packedSourceEntrypoints.length > 0) {
      console.error(`package artifact check failed: ${pkg.name} packed manifest points at source`)
      process.exit(1)
    }
    if (!collect(packedManifest.exports).some((value) => value.includes('/dist/'))) {
      console.error(`package artifact check failed: ${pkg.name} packed exports do not point at dist`)
      process.exit(1)
    }
    if (dirName === 'platform') {
      if (!listing.includes('package/dist/manifest.json')) {
        throw new Error('package artifact check failed: @movp/platform manifest is absent')
      }
      const platformManifest = parseManifest(
        execFileSync('tar', ['-xOzf', join(out, tgz), 'package/dist/manifest.json'], { encoding: 'utf8' }),
        '@movp/platform packed manifest.json',
      )
      if (!Array.isArray(platformManifest.files) || platformManifest.files.length === 0) {
        throw new Error('package artifact check failed: @movp/platform manifest has no migrations')
      }
      const packedFiles = new Set(listing.trim().split('\n'))
      for (const entry of platformManifest.files) {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry) || typeof entry.name !== 'string') {
          throw new Error('package artifact check failed: @movp/platform manifest migration is malformed')
        }
        if (!packedFiles.has(`package/dist/migrations/${entry.name}`)) {
          throw new Error(`package artifact check failed: @movp/platform migration is absent: ${entry.name}`)
        }
      }
      if (!collect(packedManifest.exports).includes('./dist/migrations/*')) {
        throw new Error('package artifact check failed: @movp/platform migration subpath export is absent')
      }
    }
    if (dirName === 'create-movp') {
      const bin = packedManifest.bin
      if (typeof bin !== 'object' || bin === null || typeof bin['create-movp'] !== 'string') {
        throw new Error('package artifact check failed: create-movp has no create-movp bin')
      }
      if (!bin['create-movp'].startsWith('./dist/')) {
        throw new Error('package artifact check failed: create-movp bin does not point at dist')
      }
      if (!listing.includes('package/dist/cli.js')) {
        throw new Error('package artifact check failed: create-movp bin artifact is absent')
      }
      if (!Array.isArray(packedManifest.files) || !packedManifest.files.includes('templates')) {
        throw new Error('package artifact check failed: create-movp files[] does not whitelist templates')
      }
    }
    if (dirName === 'search') {
      const gteSmallExport = packedManifest.exports?.['./gte-small']
      if (
        typeof gteSmallExport !== 'object' ||
        gteSmallExport === null ||
        gteSmallExport.types !== './dist/gte-small.d.ts' ||
        gteSmallExport.import !== './dist/gte-small.js'
      ) {
        throw new Error('package artifact check failed: @movp/search gte-small export is absent')
      }
      if (!listing.includes('package/dist/gte-small.js') || !listing.includes('package/dist/gte-small.d.ts')) {
        throw new Error('package artifact check failed: @movp/search gte-small artifact is absent')
      }
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}
