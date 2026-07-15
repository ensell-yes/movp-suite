import { spawnSync } from 'node:child_process'

const GENERATED_PATHS = [
  'docs-site/movp.schema.json',
  'docs-site/src/content/docs/reference',
]

const result = spawnSync(
  'git',
  ['status', '--porcelain=v1', '--untracked-files=all', '--', ...GENERATED_PATHS],
  { encoding: 'utf8' },
)

if (result.error) throw result.error
if (result.status !== 0) {
  console.error(`docs freshness FAILED: git status exited ${result.status ?? 'without a status'}`)
  process.exit(1)
}

const status = result.stdout.trimEnd()
if (status !== '') {
  console.error('docs freshness FAILED: regenerate and commit every generated artifact')
  console.error(status)
  process.exit(1)
}

console.log('docs freshness: OK')
