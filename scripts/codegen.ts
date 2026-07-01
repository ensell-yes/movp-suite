import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emitSqlMigration, emitTypes } from '@movp/codegen'
import { schema } from '@movp/core-schema'

const root = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const migrationsDir = join(root, 'supabase', 'migrations')
const migrationPath = join(migrationsDir, '20260701000002_movp_generated.sql')
const typesPath = join(root, 'packages', 'domain', 'src', 'generated', 'types.ts')

await mkdir(migrationsDir, { recursive: true })
await mkdir(dirname(typesPath), { recursive: true })

for (const file of await readdir(migrationsDir)) {
  if (file.endsWith('_movp_generated.sql') && file !== '20260701000002_movp_generated.sql') {
    await rm(join(migrationsDir, file))
  }
}

await writeFile(migrationPath, emitSqlMigration(schema))
await writeFile(typesPath, emitTypes(schema))

console.log(`wrote ${migrationPath}`)
console.log(`wrote ${typesPath}`)
