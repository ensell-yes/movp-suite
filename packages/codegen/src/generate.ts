import { schema } from '@movp/core-schema'
import type { MovpSchema } from '@movp/core-schema'
import { emitReportingSql } from './emit-reporting.ts'
import { emitDeltaSql, emitSqlMigration } from './emit-sql.ts'
import { emitTypes } from './emit-types.ts'

export interface GeneratedDelta {
  file: string
  emit: (schema: MovpSchema) => string
  collections?: readonly string[]
  events?: readonly string[]
}

function deltaOwnedCollections(deltas: readonly GeneratedDelta[]): string[] {
  return deltas.flatMap((delta) => delta.collections ?? [])
}

function deltaOwnedEvents(deltas: readonly GeneratedDelta[]): string[] {
  return deltas.flatMap((delta) => delta.events ?? [])
}

// Post-freeze generated objects ship as immutable, timestamped delta migrations.
// Once an entry merges, never remove or rename it; changed output gets a new entry.
export const GENERATED_DELTAS: readonly GeneratedDelta[] = [
  { file: '20260711000001_movp_generated_reporting.sql', emit: emitReportingSql },
  {
    file: '20260712000001_movp_generated_external_record.sql',
    emit: (schema) => emitDeltaSql(schema, {
      collections: ['external_record'],
      events: ['external.record.upserted'],
    }),
    collections: ['external_record'],
    events: ['external.record.upserted'],
  },
]

export interface GenerateOptions {
  root?: string
  migrationName?: string
  migrationsDir?: string
  typesPath?: string
  deltas?: readonly GeneratedDelta[]
}

const MAX_GENERATED_FILE_BYTES = 10 * 1024 * 1024
const MIGRATION_FILE = /^\d{14}_[a-z0-9_]+\.sql$/

function migrationFileName(file: string, label: string): string {
  if (!MIGRATION_FILE.test(file)) throw new Error(`invalid ${label} filename: ${file}`)
  return file
}

function defaultRoot(): string {
  return decodeURIComponent(new URL('../../../', import.meta.url).pathname).replace(/\/$/, '')
}

function joinPath(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/')
}

function dirname(path: string): string {
  return path.replace(/\/[^/]*$/, '') || '/'
}

async function fs() {
  return (await import('node:fs/promises')) as {
    lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean; size: number }>
    mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
    readdir(path: string): Promise<string[]>
    readFile(path: string, encoding: 'utf8'): Promise<string>
    rm(path: string): Promise<void>
    writeFile(path: string, contents: string): Promise<void>
  }
}

type Fs = Awaited<ReturnType<typeof fs>>

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

async function readIfPresent(f: Fs, path: string): Promise<string | null> {
  let info: Awaited<ReturnType<Fs['lstat']>>
  try {
    info = await f.lstat(path)
  } catch (error: unknown) {
    if (isMissing(error)) return null
    throw error
  }
  if (info.isSymbolicLink()) throw new Error(`generated baseline is a symlink: ${path}`)
  if (!info.isFile()) throw new Error(`generated baseline is not a regular file: ${path}`)
  if (info.size > MAX_GENERATED_FILE_BYTES) {
    throw new Error(`generated baseline exceeds ${MAX_GENERATED_FILE_BYTES} bytes: ${path}`)
  }
  return f.readFile(path, 'utf8')
}

async function assertSafeWriteTarget(f: Fs, path: string, label: string): Promise<void> {
  let info: Awaited<ReturnType<Fs['lstat']>>
  try {
    info = await f.lstat(path)
  } catch (error: unknown) {
    if (isMissing(error)) return
    throw error
  }
  if (info.isSymbolicLink()) throw new Error(`${label} is a symlink: ${path}`)
  if (!info.isFile()) throw new Error(`${label} is not a regular file: ${path}`)
}

export async function generate(
  options: GenerateOptions = {},
): Promise<{ migrationPath: string; typesPath: string; deltaPaths: string[] }> {
  const root = options.root ?? defaultRoot()
  const migrationName = migrationFileName(
    options.migrationName ?? '20260701000002_movp_generated.sql',
    'generated baseline',
  )
  const migrationsDir = options.migrationsDir ?? joinPath(root, 'supabase', 'migrations')
  const migrationPath = joinPath(migrationsDir, migrationName)
  const typesPath = options.typesPath ?? joinPath(root, 'packages', 'domain', 'src', 'generated', 'types.ts')
  const deltas = options.deltas ?? GENERATED_DELTAS
  const deltaFiles = deltas.map((delta) => migrationFileName(delta.file, 'generated delta'))
  if (new Set(deltaFiles).size !== deltaFiles.length) {
    throw new Error('duplicate generated delta filename')
  }
  const f = await fs()

  await f.mkdir(migrationsDir, { recursive: true })
  await f.mkdir(dirname(typesPath), { recursive: true })

  const keep = new Set([migrationName, ...deltaFiles])
  for (const file of await f.readdir(migrationsDir)) {
    if (file.endsWith('_movp_generated.sql') && !keep.has(file)) {
      await f.rm(joinPath(migrationsDir, file))
    }
  }

  const baselineSql = emitSqlMigration(schema, {
    excludeCollections: deltaOwnedCollections(deltas),
    excludeEvents: deltaOwnedEvents(deltas),
  })
  const existing = await readIfPresent(f, migrationPath)
  if (existing !== null && existing !== baselineSql) {
    throw new Error(
      `generated baseline drift: ${migrationName} is frozen but the current schema emits different SQL. ` +
        'Post-freeze schema/emitter changes must ship as a GENERATED_DELTAS entry with a new timestamped migration.',
    )
  }
  if (existing === null) await f.writeFile(migrationPath, baselineSql)

  const deltaPaths: string[] = []
  for (const delta of deltas) {
    const deltaPath = joinPath(migrationsDir, delta.file)
    await assertSafeWriteTarget(f, deltaPath, 'generated delta')
    await f.writeFile(deltaPath, delta.emit(schema))
    deltaPaths.push(deltaPath)
  }

  await assertSafeWriteTarget(f, typesPath, 'generated types output')
  await f.writeFile(typesPath, emitTypes(schema))

  return { migrationPath, typesPath, deltaPaths }
}
