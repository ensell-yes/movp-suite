import type { MovpSchema } from '@movp/core-schema'
import { loadDeltaRegistry, saveDeltaRegistry } from './deltas-registry.ts'
import { emitProjectDeltaSql } from './emit-sql.ts'
import { atomicCreateFile } from './safe-write.ts'

const TIMESTAMP = /^\d{14}$/
const NAME = /^[a-z][a-z0-9_]*$/
const MAX_MIGRATION_BYTES = 10 * 1024 * 1024
const COLLECTION_DDL = /create table if not exists public\.([a-z][a-z0-9_]*)\s*\(/g
const PROJECT_COLLECTION_MARKER = /^-- movp-project-collection: ([a-z][a-z0-9_]*)$/gm
const PROJECT_EVENT_MARKER = /^-- movp-project-event: ([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)$/gm
const GENERATED_DELTA_FILE = /^\d{14}_movp_generated_[a-z][a-z0-9_]*\.sql$/

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

async function existingMigrationOwnership(migrationsDir: string): Promise<{
  collections: Set<string>
  events: Set<string>
  projectCollections: Set<string>
  generatedDeltas: Array<{ file: string; collections: string[]; events: string[]; body: string }>
}> {
  const fs = await import('node:fs/promises')
  const collections = new Set<string>()
  const events = new Set<string>()
  const projectCollections = new Set<string>()
  const generatedDeltas: Array<{ file: string; collections: string[]; events: string[]; body: string }> = []
  const root = await fs.lstat(migrationsDir)
  if (root.isSymbolicLink()) throw new Error(`new_delta_migrations_dir_symlink_rejected: ${migrationsDir}`)
  if (!root.isDirectory()) throw new Error(`new_delta_migrations_dir_not_directory: ${migrationsDir}`)
  for (const file of await fs.readdir(migrationsDir)) {
    if (!/^\d{14}_[a-z0-9_]+\.sql$/.test(file)) continue
    const path = `${migrationsDir}/${file}`.replace(/\/+/g, '/')
    const info = await fs.lstat(path)
    if (info.isSymbolicLink()) throw new Error(`new_delta_migration_symlink_rejected: ${path}`)
    if (!info.isFile()) throw new Error(`new_delta_migration_not_regular_file: ${path}`)
    if (info.size > MAX_MIGRATION_BYTES) throw new Error(`new_delta_migration_too_large: ${path}`)
    const sql = await fs.readFile(path, 'utf8')
    const fileCollections: string[] = []
    const fileEvents: string[] = []
    for (const match of sql.matchAll(COLLECTION_DDL)) {
      if (match[1]) collections.add(match[1])
    }
    for (const match of sql.matchAll(PROJECT_COLLECTION_MARKER)) {
      if (match[1]) {
        collections.add(match[1])
        projectCollections.add(match[1])
        fileCollections.push(match[1])
      }
    }
    for (const match of sql.matchAll(PROJECT_EVENT_MARKER)) {
      if (match[1]) {
        events.add(match[1])
        fileEvents.push(match[1])
      }
    }
    if (GENERATED_DELTA_FILE.test(file) && (fileCollections.length > 0 || fileEvents.length > 0)) {
      generatedDeltas.push({
        file,
        collections: [...new Set(fileCollections)].sort(),
        events: [...new Set(fileEvents)].sort(),
        body: sql,
      })
    }
  }
  return { collections, events, projectCollections, generatedDeltas }
}

async function assertNewMigrationTarget(path: string): Promise<void> {
  const fs = await import('node:fs/promises')
  try {
    await fs.lstat(path)
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  throw new Error(`delta_file_exists: ${path}`)
}

export async function newDelta(
  options: NewDeltaOptions,
): Promise<{ file: string; collections: string[]; events: string[] }> {
  if (!NAME.test(options.name)) throw new Error(`invalid delta name: ${options.name}`)
  const timestamp = options.timestamp ?? utcTimestamp()
  if (!TIMESTAMP.test(timestamp)) throw new Error(`invalid delta timestamp: ${timestamp}`)
  const registry = await loadDeltaRegistry(options.registryPath)
  const existing = await existingMigrationOwnership(options.migrationsDir)
  const currentCollections = new Set(options.schema.projectCollections.map((collection) => collection.name))
  const currentEvents = new Set(options.schema.projectEvents.map((event) => event.key))
  const removedCollections = [...existing.projectCollections].filter((name) => !currentCollections.has(name)).sort()
  const removedEvents = [...existing.events].filter((key) => !currentEvents.has(key)).sort()
  if (removedCollections.length > 0 || removedEvents.length > 0) {
    throw new Error(
      `project_schema_removal_unsupported: restore removed collections [${removedCollections.join(', ')}] and events [${removedEvents.join(', ')}]; v1 project migrations are additive-only`,
    )
  }
  const registeredFiles = new Set(registry.deltas.map((delta) => delta.file))
  const recoverable = existing.generatedDeltas.filter((delta) => !registeredFiles.has(delta.file))
  if (recoverable.length > 0) {
    for (const delta of recoverable) {
      const expected = emitProjectDeltaSql(options.schema, delta)
      if (delta.body !== expected) {
        throw new Error(`unregistered_generated_delta_mismatch: ${delta.file}`)
      }
    }
    await saveDeltaRegistry(options.registryPath, {
      deltas: [
        ...registry.deltas,
        ...recoverable.map(({ file, collections, events }) => ({ file, collections, events })),
      ],
    })
    const recovered = recoverable.find((delta) => delta.file.endsWith(`_${options.name}.sql`))
    if (recovered) {
      return { file: recovered.file, collections: recovered.collections, events: recovered.events }
    }
  }
  const ownedCollections = new Set(registry.deltas.flatMap((delta) => delta.collections))
  const ownedEvents = new Set(registry.deltas.flatMap((delta) => delta.events))
  for (const collection of existing.collections) ownedCollections.add(collection)
  for (const event of existing.events) ownedEvents.add(event)
  const collections = options.schema.projectCollections
    .map((collection) => collection.name)
    .filter((name) => !ownedCollections.has(name))
    .sort()
  const events = options.schema.projectEvents
    .map((event) => event.key)
    .filter((key) => !ownedEvents.has(key))
    .sort()
  if (collections.length === 0 && events.length === 0) {
    throw new Error(
      `nothing_to_allocate: no unowned project collection or event for delta "${options.name}"; v1 cannot allocate field mutations`,
    )
  }
  const file = `${timestamp}_movp_generated_${options.name}.sql`
  if (registry.deltas.some((delta) => delta.file === file)) {
    throw new Error(`delta file already registered: ${file}`)
  }
  const body = emitProjectDeltaSql(options.schema, { collections, events })
  const migrationPath = `${options.migrationsDir}/${file}`.replace(/\/+/g, '/')
  await assertNewMigrationTarget(migrationPath)
  await atomicCreateFile(migrationPath, body)
  try {
    await saveDeltaRegistry(options.registryPath, {
      deltas: [...registry.deltas, { file, collections, events }],
    })
  } catch (error: unknown) {
    throw new Error(
      `delta_registry_update_failed: ${file} is intact; rerun "movp new-delta ${options.name}" to reconcile`,
      { cause: error },
    )
  }
  return { file, collections, events }
}
