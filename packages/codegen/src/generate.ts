import { schema } from '@movp/core-schema'
import { emitSqlMigration } from './emit-sql.ts'
import { emitTypes } from './emit-types.ts'

export interface GenerateOptions {
  root?: string
  migrationName?: string
  migrationsDir?: string
  typesPath?: string
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
    mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
    readdir(path: string): Promise<string[]>
    rm(path: string): Promise<void>
    writeFile(path: string, contents: string): Promise<void>
  }
}

export async function generate(options: GenerateOptions = {}): Promise<{ migrationPath: string; typesPath: string }> {
  const root = options.root ?? defaultRoot()
  const migrationName = options.migrationName ?? '20260701000002_movp_generated.sql'
  const migrationsDir = options.migrationsDir ?? joinPath(root, 'supabase', 'migrations')
  const migrationPath = joinPath(migrationsDir, migrationName)
  const typesPath = options.typesPath ?? joinPath(root, 'packages', 'domain', 'src', 'generated', 'types.ts')
  const f = await fs()

  await f.mkdir(migrationsDir, { recursive: true })
  await f.mkdir(dirname(typesPath), { recursive: true })

  for (const file of await f.readdir(migrationsDir)) {
    if (file.endsWith('_movp_generated.sql') && file !== migrationName) {
      await f.rm(joinPath(migrationsDir, file))
    }
  }

  await f.writeFile(migrationPath, emitSqlMigration(schema))
  await f.writeFile(typesPath, emitTypes(schema))

  return { migrationPath, typesPath }
}
