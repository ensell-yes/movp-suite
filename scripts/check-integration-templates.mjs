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

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasObjectPayload(file, parsed) {
  if (file === 'zapier-inbound.json') {
    return isObject(parsed) && isObject(parsed.action) && isObject(parsed.action.body) && isObject(parsed.action.body.payload)
  }
  if (file === 'n8n-inbound.json') {
    if (!isObject(parsed) || !Array.isArray(parsed.nodes)) return false
    const upsert = parsed.nodes.find((node) => isObject(node) && node.name === 'MOVP Upsert')
    return isObject(upsert) && isObject(upsert.parameters) && isObject(upsert.parameters.body) && isObject(upsert.parameters.body.payload)
  }
  return true
}

let files
try {
  const directory = lstatSync(templatesDir)
  if (directory.isSymbolicLink() || !directory.isDirectory()) throw new Error('unsafe templates directory')
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
  if (!hasObjectPayload(file, parsed)) {
    console.error(`integration templates: payload must be a JSON object in ${file}`)
    process.exit(1)
  }
  if (values.some((value) => secretPatterns.some((pattern) => pattern.test(value)))) {
    console.error(`integration templates: secret-shaped value in ${file}`)
    process.exit(1)
  }
}

console.log('integration-templates: PASS')
