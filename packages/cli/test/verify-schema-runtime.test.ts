import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defineSchema, schemaFingerprint, type MovpSchema } from '@movp/core-schema'
import { describe, expect, it } from 'vitest'
import { runVerifySchemaRuntime } from '../src/verify-schema-runtime.ts'

const collection: MovpSchema['collections'][number] = {
  name: 'n',
  label: 'N',
  labelPlural: 'Ns',
  workspaceScoped: true,
  layer: 'platform',
  fields: {},
}
const nodeSchema = defineSchema({ collections: [collection] })
const nodeFingerprint = schemaFingerprint(nodeSchema)

const baseOpts = {
  configPath: '/virtual/movp.config.mjs',
  denoConfigPath: '/virtual/deno.json',
  edgeSchemaSpecifier: './schema.ts',
  importConfig: async () => ({ schema: nodeSchema }),
}

describe('runVerifySchemaRuntime (C6b.5)', () => {
  it('returns ok when Node and Deno fingerprints match', async () => {
    const result = await runVerifySchemaRuntime({
      ...baseOpts,
      spawnDeno: () => ({ status: 0, stdout: `${nodeFingerprint}\n`, stderr: '' }),
    })
    expect(result).toEqual({
      ok: true,
      nodeFingerprint,
      denoFingerprint: nodeFingerprint,
    })
  })

  it('flags a schema runtime mismatch when Deno diverges', async () => {
    const denoFingerprint = 'f'.repeat(64)
    const result = await runVerifySchemaRuntime({
      ...baseOpts,
      spawnDeno: () => ({ status: 0, stdout: `${denoFingerprint}\n`, stderr: '' }),
    })
    expect(result).toEqual({
      ok: false,
      code: 'schema_runtime_mismatch',
      nodeFingerprint,
      denoFingerprint,
    })
  })

  it('classifies a Deno failure as operational, not a mismatch', async () => {
    await expect(runVerifySchemaRuntime({
      ...baseOpts,
      spawnDeno: () => ({ status: 1, stdout: '', stderr: 'sensitive diagnostic' }),
    })).rejects.toThrow(/^verify_schema_runtime_spawn_failed: deno exited 1$/)
  })
})

const hasDeno = spawnSync('deno', ['--version'], { encoding: 'utf8' }).status === 0
const fixture = fileURLToPath(new URL('./fixtures/verify-schema-runtime/', import.meta.url))

describe.skipIf(!hasDeno)('verify-schema-runtime real Deno gate', () => {
  it('matches identical Node and Deno schemas', async () => {
    const result = await runVerifySchemaRuntime({
      configPath: `${fixture}movp.config.mjs`,
      denoConfigPath: `${fixture}deno.json`,
      edgeSchemaSpecifier: `${fixture}schema.match.mjs`,
    })
    expect(result.ok).toBe(true)
    expect(result.nodeFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(result.denoFingerprint).toBe(result.nodeFingerprint)
  })

  it('detects a Deno-only schema divergence', async () => {
    const result = await runVerifySchemaRuntime({
      configPath: `${fixture}movp.config.mjs`,
      denoConfigPath: `${fixture}deno.json`,
      edgeSchemaSpecifier: `${fixture}schema.diverge.mjs`,
    })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('schema_runtime_mismatch')
  })
})
