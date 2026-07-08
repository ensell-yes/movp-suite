import { existsSync, readFileSync } from 'node:fs'

const docs = ['README.md', 'docs/quickstart.md']
const missing = docs.filter((file) => !existsSync(file))
if (missing.length > 0) {
  console.error(`quickstart docs missing: ${missing.join(', ')}`)
  process.exit(1)
}

const rootPkg = JSON.parse(readFileSync('package.json', 'utf8'))
const scripts = rootPkg.scripts ?? {}
const text = docs.map((file) => readFileSync(file, 'utf8')).join('\n')

for (const name of ['bootstrap', 'seed:demo', 'check:docs', 'check:packages']) {
  if (!scripts[name]) {
    console.error(`quickstart references required missing script: ${name}`)
    process.exit(1)
  }
}

const forbidden = [/pnpm\s+pack\s+--dry-run/, /npm\s+org\s+ls\s+@movp/]
for (const pattern of forbidden) {
  if (pattern.test(text)) {
    console.error(`quickstart docs contain stale command: ${pattern}`)
    process.exit(1)
  }
}

if (!text.includes('pnpm bootstrap')) {
  console.error('quickstart docs must include pnpm bootstrap')
  process.exit(1)
}

if (!text.includes('64322')) {
  console.error('quickstart docs must document the local Supabase port strategy')
  process.exit(1)
}
