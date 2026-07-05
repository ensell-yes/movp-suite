#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const registryPath = join(root, 'packages', 'core-schema', 'src', 'events.ts')
const scanRoots = [
  join(root, 'supabase', 'migrations'),
  join(root, 'packages', 'domain', 'src'),
  join(root, 'packages', 'flows', 'src'),
  join(root, 'supabase', 'functions'),
]
const sourceExts = new Set(['.sql', '.ts'])
const eventLiteral = /'([a-z][a-z_]*(?:\.[a-z][a-z_]+)+)'/g

function walk(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(path))
    else if (sourceExts.has(extname(entry.name))) out.push(path)
  }
  return out
}

function literalsIn(text) {
  return [...text.matchAll(eventLiteral)].map((match) => match[1])
}

function registryKeys() {
  const src = readFileSync(registryPath, 'utf8')
  return new Set([...src.matchAll(/event\('([^']+)'/g)].map((match) => match[1]))
}

function callsiteKeys(files) {
  const keys = new Set()
  for (const file of files) {
    const src = readFileSync(file, 'utf8')

    for (const match of src.matchAll(/(?:public\.)?emit_event\s*\(/g)) {
      const start = match.index ?? 0
      const end = src.indexOf(');', start)
      const window = src.slice(start, end > start ? end + 2 : start + 1200)
      for (const key of literalsIn(window)) keys.add(key)
    }

    for (const match of src.matchAll(/emitEvent\s*\([^)]*type\s*:\s*'([^']+)'/g)) {
      keys.add(match[1])
    }
  }
  return keys
}

const catalog = registryKeys()
const callsites = callsiteKeys(scanRoots.flatMap(walk))
const missingFromCatalog = [...callsites].filter((key) => !catalog.has(key)).sort()
const unusedCatalogKeys = [...catalog].filter((key) => !callsites.has(key)).sort()

if (missingFromCatalog.length || unusedCatalogKeys.length) {
  if (missingFromCatalog.length) {
    console.error('event catalog coverage: callsite(s) missing from catalog:')
    for (const key of missingFromCatalog) console.error(`  - ${key}`)
  }
  if (unusedCatalogKeys.length) {
    console.error('event catalog coverage: catalog key(s) missing callsites:')
    for (const key of unusedCatalogKeys) console.error(`  - ${key}`)
  }
  process.exit(1)
}

console.log('event catalog coverage: ok')
