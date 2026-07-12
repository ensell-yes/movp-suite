import { existsSync, lstatSync, readlinkSync } from 'node:fs'

const required = [
  'LICENSE',
  'README.md',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CLAUDE.md',
  'docs/rest.md',
]
const missing = required.filter((file) => !existsSync(file))
if (missing.length > 0) {
  console.error(`missing required docs: ${missing.join(', ')}`)
  process.exit(1)
}

let stat
try {
  stat = lstatSync('AGENTS.md')
} catch {
  console.error('AGENTS.md must be a relative symlink to CLAUDE.md')
  process.exit(1)
}

if (!stat.isSymbolicLink() || readlinkSync('AGENTS.md') !== 'CLAUDE.md') {
  console.error('AGENTS.md must be a relative symlink to CLAUDE.md')
  process.exit(1)
}
