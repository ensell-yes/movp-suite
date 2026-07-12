#!/usr/bin/env node
import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const templatesDir = 'templates/integrations'
const maxBytes = 256 * 1024
const secretPatterns = [
  /\bmovp_pat_[0-9a-f]{64}\b/i,
  /eyJ[A-Za-z0-9_-]{20,}\./,
  /sk-[A-Za-z0-9]{20,}/,
]

function strings(value) {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}

let files
try {
  files = readdirSync(templatesDir).filter((file) => file.endsWith('.json')).sort()
} catch {
  files = []
}
if (files.length === 0) {
  console.error('integration templates: no JSON templates found')
  process.exit(1)
}

for (const file of files) {
  const path = join(templatesDir, file)
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isFile() || info.size > maxBytes) {
    console.error(`integration templates: unsafe template file ${file}`)
    process.exit(1)
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    console.error(`integration templates: invalid JSON in ${file}`)
    process.exit(1)
  }
  const values = strings(parsed)
  const serialized = JSON.stringify(parsed)
  if (!serialized.includes('<MOVP_API_URL>') || !serialized.includes('<MOVP_PAT_SESSION_JWT>')) {
    console.error(`integration templates: missing required placeholders in ${file}`)
    process.exit(1)
  }
  if (serialized.includes('Bearer <MOVP_PAT>')) {
    console.error(`integration templates: raw PAT cannot authenticate a PostgREST request in ${file}`)
    process.exit(1)
  }
  if (values.some((value) => secretPatterns.some((pattern) => pattern.test(value)))) {
    console.error(`integration templates: secret-shaped value in ${file}`)
    process.exit(1)
  }
}

console.log('integration-templates: PASS')
