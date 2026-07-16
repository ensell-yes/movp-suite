#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { assertSafeDirectory, readJsonBounded } from './lib/safe-io.mjs'

const distDir = process.argv[2]
if (!distDir) { console.error('module-graph:E_USAGE'); process.exit(2) }
try { assertSafeDirectory(distDir) } catch (error) {
  console.error(error instanceof Error ? error.message : 'module-graph:E_DIRECTORY')
  process.exit(1)
}
const file = join(distDir, 'module-ids.json')
if (!existsSync(file)) { console.error(`module-graph:E_MISSING path=${file}`); process.exit(1) }
let ids
try { ids = readJsonBounded(file) } catch (error) {
  console.error(error instanceof Error ? error.message : 'module-graph:E_READ')
  process.exit(1)
}
if (!Array.isArray(ids) || ids.length === 0 || !ids.every((value) => typeof value === 'string' && value.length > 0)) {
  console.error(`module-graph:E_MALFORMED path=${file}`)
  process.exit(1)
}
const FORBIDDEN = ['@movp/domain', '@movp/auth', '@supabase', '/packages/domain/', '@spike/oracle', '/oracle/src/']
const hits = ids.filter((id) => FORBIDDEN.some((forbidden) => id.includes(forbidden)))
if (hits.length) { console.error(`module-graph:E_FORBIDDEN path=${file} count=${hits.length}`); process.exit(1) }
console.log(`module-graph:clean count=${ids.length}`)
