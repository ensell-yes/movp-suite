import { existsSync, renameSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const config = new URL('../wrangler.jsonc', import.meta.url)
const hidden = new URL('../wrangler.jsonc.build-hidden', import.meta.url)
let moved = false

try {
  if (existsSync(config)) {
    renameSync(config, hidden)
    moved = true
  }
  const result = spawnSync('astro', ['build'], { stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) process.exit(result.status ?? 1)
} finally {
  if (moved && existsSync(hidden)) renameSync(hidden, config)
}
