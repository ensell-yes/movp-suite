#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const db = process.env.VS_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
const sqlFile = join(root, 'scripts', 'vector-scale.sql')
const pre = process.env.VS_FORCE_SEQSCAN ? '-c "set enable_indexscan=off;" -c "set enable_bitmapscan=off;"' : ''

let out
try {
  out = execSync(`psql "${db}" ${pre} -X -f "${sqlFile}" 2>&1`, { encoding: 'utf8' })
} catch (e) {
  console.error('vector-scale: psql failed\n' + (e.stdout ?? '') + (e.stderr ?? ''))
  process.exit(1)
}

function section(name) {
  const m = out.match(new RegExp(`=== ${name} BEGIN ===([\\s\\S]*?)=== ${name} END ===`))
  return m ? m[1] : ''
}

const explain = section('EXPLAIN')
const crosstenant = section('CROSSTENANT')
const errors = []
if (!/search_chunk_hnsw/.test(explain)) errors.push('plan does not use search_chunk_hnsw')
if (/Seq Scan/i.test(explain)) errors.push('plan contains a Seq Scan')
if (!/\b0\b/.test(crosstenant)) errors.push('match_chunks returned cross-tenant rows')

if (errors.length > 0) {
  console.error('VECTOR-SCALE VIOLATION:\n  - ' + errors.join('\n  - '))
  console.error('--- EXPLAIN ---\n' + explain)
  process.exit(1)
}

console.log('vector-scale: HNSW plan OK, no Seq Scan, no cross-tenant rows')
