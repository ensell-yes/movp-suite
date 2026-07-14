import type { MovpSchema } from '@movp/core-schema'
import { loadDeltaRegistry, saveDeltaRegistry } from './deltas-registry.ts'
import { emitProjectDeltaSql } from './emit-sql.ts'
import { atomicWriteFile } from './safe-write.ts'

const TIMESTAMP = /^\d{14}$/
const NAME = /^[a-z][a-z0-9_]*$/
const MAX_MIGRATION_BYTES = 10 * 1024 * 1024
const COLLECTION_DDL = /create table if not exists public\.([a-z][a-z0-9_]*)\s*\(/g

export interface NewDeltaOptions {
  schema: MovpSchema
  name: string
  registryPath: string
  migrationsDir: string
  timestamp?: string
}

function utcTimestamp(): string {
  const date = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
}

async function existingMigrationCollections(migrationsDir: string): Promise<Set<string>> {
  const fs = await import('node:fs/promises')
  const collections = new Set<string>()
  for (const file of await fs.readdir(migrationsDir)) {
    if (!/^\d{14}_[a-z0-9_]+\.sql$/.test(file)) continue
    const path = `${migrationsDir}/${file}`.replace(/\/+/g, '/')
    const info = await fs.lstat(path)
    if (info.isSymbolicLink()) throw new Error(`new_delta_migration_symlink_rejected: ${path}`)
    if (!info.isFile()) throw new Error(`new_delta_migration_not_regular_file: ${path}`)
    if (info.size > MAX_MIGRATION_BYTES) throw new Error(`new_delta_migration_too_large: ${path}`)
    const sql = await fs.readFile(path, 'utf8')
    for (const match of sql.matchAll(COLLECTION_DDL)) {
      if (match[1]) collections.add(match[1])
    }
  }
  return collections
}

export async function newDelta(
  options: NewDeltaOptions,
): Promise<{ file: string; collections: string[]; events: string[] }> {
  if (!NAME.test(options.name)) throw new Error(`invalid delta name: ${options.name}`)
  const timestamp = options.timestamp ?? utcTimestamp()
  if (!TIMESTAMP.test(timestamp)) throw new Error(`invalid delta timestamp: ${timestamp}`)
  const registry = await loadDeltaRegistry(options.registryPath)
  const owned = new Set(registry.deltas.flatMap((delta) => delta.collections))
  for (const collection of await existingMigrationCollections(options.migrationsDir)) owned.add(collection)
  const collections = options.schema.projectCollections
    .map((collection) => collection.name)
    .filter((name) => !owned.has(name))
    .sort()
  if (collections.length === 0) {
    throw new Error(`nothing_to_allocate: no unowned project collection for delta "${options.name}"`)
  }
  const file = `${timestamp}_movp_generated_${options.name}.sql`
  if (registry.deltas.some((delta) => delta.file === file)) {
    throw new Error(`delta file already registered: ${file}`)
  }
  const events: string[] = []
  const body = emitProjectDeltaSql(options.schema, { collections, events })
  await saveDeltaRegistry(options.registryPath, {
    deltas: [...registry.deltas, { file, collections, events }],
  })
  await atomicWriteFile(`${options.migrationsDir}/${file}`.replace(/\/+/g, '/'), body)
  return { file, collections, events }
}
