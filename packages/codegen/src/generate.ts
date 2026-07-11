import { schema } from '@movp/core-schema'
import type { MovpSchema } from '@movp/core-schema'
import { emitSqlMigration } from './emit-sql.ts'
import { emitTypes } from './emit-types.ts'

export interface GeneratedDelta {
  file: string
  emit: (schema: MovpSchema) => string
}

// Post-freeze generated objects ship as immutable, timestamped delta migrations.
// Once an entry merges, never remove or rename it; changed output gets a new entry.
export const GENERATED_DELTAS: readonly GeneratedDelta[] = []

export interface GenerateOptions {
  root?: string
  migrationName?: string
  migrationsDir?: string
  typesPath?: string
  deltas?: readonly GeneratedDelta[]
}

const MAX_GENERATED_FILE_BYTES = 10 * 1024 * 1024

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

export async function generate(
  options: GenerateOptions = {},
): Promise<{ migrationPath: string; typesPath: string; deltaPaths: string[] }> {
  const root = options.root ?? defaultRoot()
  const migrationName = options.migrationName ?? '20260701000002_movp_generated.sql'
  const migrationsDir = options.migrationsDir ?? joinPath(root, 'supabase', 'migrations')
  const migrationPath = joinPath(migrationsDir, migrationName)
  const typesPath = options.typesPath ?? joinPath(root, 'packages', 'domain', 'src', 'generated', 'types.ts')
  const deltas = options.deltas ?? GENERATED_DELTAS
  const f = await fs()

  await f.mkdir(migrationsDir, { recursive: true })
  await f.mkdir(dirname(typesPath), { recursive: true })

  const keep = new Set([migrationName, ...deltas.map((delta) => delta.file)])
  for (const file of await f.readdir(migrationsDir)) {
    if (file.endsWith('_movp_generated.sql') && !keep.has(file)) {
      await f.rm(joinPath(migrationsDir, file))
    }
  }

  const baselineSql = emitSqlMigration(schema)
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
    await f.writeFile(deltaPath, delta.emit(schema))
    deltaPaths.push(deltaPath)
  }

  await f.writeFile(typesPath, emitTypes(schema))

  return { migrationPath, typesPath, deltaPaths }
}
