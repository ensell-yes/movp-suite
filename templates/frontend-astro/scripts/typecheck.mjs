import { existsSync, renameSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const config = new URL('../wrangler.jsonc', import.meta.url)
const hidden = new URL('../wrangler.jsonc.typecheck-hidden', import.meta.url)
let moved = false
let status = 0

try {
  if (existsSync(config)) {
    renameSync(config, hidden)
    moved = true
  }

  const astro = spawnSync('astro', ['check'], { stdio: 'inherit', shell: process.platform === 'win32' })
  status = astro.status ?? 1

  if (status === 0) {
    const tsc = spawnSync('tsc', ['--noEmit'], { stdio: 'inherit', shell: process.platform === 'win32' })
    status = tsc.status ?? 1
  }
} finally {
  if (moved && existsSync(hidden)) renameSync(hidden, config)
}

if (status !== 0) process.exit(status)
