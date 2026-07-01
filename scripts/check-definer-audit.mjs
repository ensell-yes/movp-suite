#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'supabase', 'migrations')

let files = []
try {
  files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((f) => join(dir, f))
} catch {
  console.error(`definer-audit: no migrations dir at ${dir}`)
  process.exit(1)
}

const sql = files.map((f) => readFileSync(f, 'utf8')).join('\n').toLowerCase()
const blocks = sql.split(/create\s+(?:or\s+replace\s+)?function/g).slice(1)
const violations = []

for (const raw of blocks) {
  const block = raw.split('$$;')[0]
  if (!/\bsecurity\s+definer\b/.test(block)) continue
  if (!/\bset\s+search_path\s*=/.test(block)) {
    const name = (raw.match(/^\s*([a-z0-9_."]+)\s*\(/) ?? [])[1] ?? '<unknown>'
    violations.push(name)
  }
}

if (violations.length > 0) {
  console.error('DEFINER-AUDIT VIOLATION: security definer fn(s) missing pinned search_path:')
  for (const v of violations) console.error(`  - ${v}`)
  process.exit(1)
}

console.log(`definer-audit: ${blocks.length} function block(s) scanned, all definers pinned`)
