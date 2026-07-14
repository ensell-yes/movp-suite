import { runtimeFingerprint } from '@movp/core-schema'
import type { MovpSchema } from '@movp/core-schema'

type RuntimeSchema = Pick<MovpSchema, 'collections' | 'events'>

function isRuntimeSchema(value: unknown): value is RuntimeSchema {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { collections?: unknown; events?: unknown }
  return Array.isArray(candidate.collections) && Array.isArray(candidate.events)
}

const specifier = Deno.args[0]
if (!specifier) {
  console.error('verify_schema_runtime_missing_specifier')
  Deno.exit(2)
}

let module: { schema?: unknown }
try {
  module = await import(specifier)
} catch {
  console.error('verify_schema_runtime_edge_import_failed')
  Deno.exit(3)
}

try {
  if (!isRuntimeSchema(module.schema)) throw new Error('invalid schema shape')
  console.log(runtimeFingerprint(module.schema))
} catch {
  console.error('verify_schema_runtime_edge_schema_invalid')
  Deno.exit(4)
}
