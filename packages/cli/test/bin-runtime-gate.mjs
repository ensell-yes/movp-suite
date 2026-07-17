import { lstat, readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url))
const info = await lstat(bin)
if (!info.isFile() || info.isSymbolicLink()) throw new Error('built_cli_bin_not_regular_file')
if (info.size > 2 * 1024 * 1024) throw new Error('built_cli_bin_too_large')

const firstLine = (await readFile(bin, 'utf8')).split('\n', 1)[0]
if (firstLine !== '#!/usr/bin/env node') {
  throw new Error(`built_cli_shebang_invalid: ${firstLine}`)
}

const result = spawnSync(bin, ['--help'], { encoding: 'utf8', timeout: 10_000 })
if (result.status !== 0 || !result.stdout.includes('MOVP Core CLI')) {
  throw new Error(`built_cli_help_failed: status=${result.status ?? 'unknown'}`)
}

console.log('built CLI executable gate: ok')
