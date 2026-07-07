#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const baselinePath = join(root, 'supabase', '.forward-only-migration-baseline')
const allowRewrite = process.env.MOVP_ALLOW_MERGED_MIGRATION_REWRITE === '1'

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function maybeGit(args) {
  try {
    return git(args)
  } catch {
    return ''
  }
}

if (!existsSync(baselinePath)) {
  console.error(`forward-only migrations: missing baseline at ${baselinePath}`)
  process.exit(1)
}

const frozen = new Set(
  readFileSync(baselinePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean),
)

const candidates = [
  process.env.MOVP_MIGRATION_BASE_REF,
  process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : '',
  'origin/main',
  'main',
].filter(Boolean)

let baseRef = ''
for (const candidate of candidates) {
  if (maybeGit(['rev-parse', '--verify', '--quiet', candidate])) {
    baseRef = candidate
    break
  }
}

if (!baseRef) {
  console.log('forward-only migrations: no base ref available; skipping diff check')
  process.exit(0)
}

const mergeBase = maybeGit(['merge-base', baseRef, 'HEAD'])
if (!mergeBase) {
  console.log(`forward-only migrations: no merge base with ${baseRef}; skipping diff check`)
  process.exit(0)
}

const mergedMigrations = maybeGit(['ls-tree', '-r', '--name-only', mergeBase, '--', 'supabase/migrations'])
for (const path of mergedMigrations.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
  frozen.add(path)
}

const diff = maybeGit(['diff', '--name-status', '--find-renames', mergeBase, '--', 'supabase/migrations'])
const violations = []

for (const line of diff.split(/\r?\n/).filter(Boolean)) {
  const parts = line.split(/\t+/)
  const status = parts[0] ?? ''
  const paths = parts.slice(1)
  const touchesFrozen = paths.some((path) => frozen.has(path))
  if (!touchesFrozen) continue

  if (status === 'A') continue
  violations.push(`${status} ${paths.join(' -> ')}`)
}

if (violations.length > 0 && !allowRewrite) {
  console.error('forward-only migrations: frozen migration(s) were modified, deleted, copied, or renamed:')
  for (const violation of violations) console.error(`  - ${violation}`)
  console.error('')
  console.error('Add a new timestamped migration instead. Do not edit 20260701000002_movp_generated.sql')
  console.error('or any merged hand migration after the freeze baseline. For pre-deploy emergency')
  console.error('rewrites only, set MOVP_ALLOW_MERGED_MIGRATION_REWRITE=1 explicitly.')
  process.exit(1)
}

if (violations.length > 0 && allowRewrite) {
  console.warn('forward-only migrations: rewrite override enabled for:')
  for (const violation of violations) console.warn(`  - ${violation}`)
}

console.log('forward-only migrations: ok')
