#!/usr/bin/env -S npx tsx
// Project-mode codegen: emits ONLY the project baseline + registered deltas + movp.schema.json,
// keyed on deltasRegistryPath (06c). Never touches the platform migration bundle.
import { generate } from '@movp/codegen'
import { schema } from '../movp.config.mjs'

const cwd = process.cwd()
await generate({
  schema,
  migrationsDir: `${cwd}/supabase/migrations`,
  migrationName: '20260715000000_movp_generated.sql',
  deltasRegistryPath: `${cwd}/movp.deltas.json`,
  manifestPath: `${cwd}/movp.schema.json`,
})
console.log('codegen: project baseline + manifest written')
