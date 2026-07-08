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
  const entryValues = []
  const collect = (value) => {
    if (!value) return
    if (typeof value === 'string') {
      entryValues.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item)
      return
    }
    if (typeof value === 'object') {
      for (const item of Object.values(value)) collect(item)
    }
  }
  collect(pkg.main)
  collect(pkg.exports)
  collect(pkg.types)
  collect(pkg.bin)

  const sourceEntrypoints = entryValues.filter((value) => {
    return value.includes('/src/') || (value.endsWith('.ts') && !value.endsWith('.d.ts'))
  })
  if (sourceEntrypoints.length > 0) {
    console.error(`package artifact check failed: ${pkg.name} points at source`)
    process.exit(1)
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
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}
