import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const publishable = [
  'auth',
  'cli',
  'codegen',
  'core-schema',
  'domain',
  'flows',
  'graphql',
  'mcp',
  'notifications',
  'obs',
  'search',
]

execFileSync('pnpm', ['pack', '--help'], { stdio: 'pipe' })

for (const dirName of publishable) {
  const dir = join('packages', dirName)
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
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
    const packedManifest = JSON.parse(execFileSync('tar', ['-xOzf', join(out, tgz), 'package/package.json'], { encoding: 'utf8' }))
    const packedSourceEntrypoints = sourceEntrypoints(packedManifest)
    if (packedSourceEntrypoints.length > 0) {
      console.error(`package artifact check failed: ${pkg.name} packed manifest points at source`)
      process.exit(1)
    }
    if (!collect(packedManifest.exports).some((value) => value.includes('/dist/'))) {
      console.error(`package artifact check failed: ${pkg.name} packed exports do not point at dist`)
      process.exit(1)
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}
