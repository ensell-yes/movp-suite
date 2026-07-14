import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runVerifySchemaRuntime } from '../dist/index.js'

const runtimeScript = fileURLToPath(new URL('../dist/verify-schema-runtime.deno.ts', import.meta.url))
if (!existsSync(runtimeScript)) throw new Error('built_runtime_script_missing')

const fixture = fileURLToPath(new URL('./fixtures/verify-schema-runtime/', import.meta.url))
const common = {
  configPath: `${fixture}movp.config.mjs`,
  denoConfigPath: `${fixture}deno.json`,
}

const matching = await runVerifySchemaRuntime({
  ...common,
  edgeSchemaSpecifier: `${fixture}schema.match.mjs`,
})
if (!matching.ok) throw new Error('built_runtime_match_failed')

const divergent = await runVerifySchemaRuntime({
  ...common,
  edgeSchemaSpecifier: `${fixture}schema.diverge.mjs`,
})
if (divergent.ok || divergent.code !== 'schema_runtime_mismatch') {
  throw new Error('built_runtime_mismatch_failed')
}

console.log('built schema runtime gate: ok')
