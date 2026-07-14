import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { defineSchema, runtimeFingerprint, type MovpSchema } from '@movp/core-schema'
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
const nodeFingerprint = runtimeFingerprint(nodeSchema)

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

  it('forwards a minimum dependency age only when explicitly requested', async () => {
    const calls: string[][] = []
    const spawnDeno = (args: string[]) => {
      calls.push(args)
      return { status: 0, stdout: `${nodeFingerprint}\n`, stderr: '' }
    }
    await runVerifySchemaRuntime({ ...baseOpts, spawnDeno })
    await runVerifySchemaRuntime({
      ...baseOpts,
      denoMinimumDependencyAge: '0',
      spawnDeno,
    })
    expect(calls[0]).not.toContain('--minimum-dependency-age')
    expect(calls[1]).toContain('--minimum-dependency-age')
    expect(calls[1][calls[1].indexOf('--minimum-dependency-age') + 1]).toBe('0')
    expect(calls[1].at(-1)).toBe(pathToFileURL(resolve('./schema.ts')).href)
  })

  it('reports spawn and allowlisted Deno diagnostics without leaking arbitrary stderr', async () => {
    await expect(runVerifySchemaRuntime({
      ...baseOpts,
      spawnDeno: () => ({ status: null, stdout: '', stderr: '', errorCode: 'ENOENT' }),
    })).rejects.toThrow(/^verify_schema_runtime_spawn_failed: deno spawn ENOENT$/)
    await expect(runVerifySchemaRuntime({
      ...baseOpts,
      spawnDeno: () => ({
        status: 3,
        stdout: '',
        stderr: 'Download http://registry.invalid/pkg\nverify_schema_runtime_edge_import_failed\n',
      }),
    })).rejects.toThrow(/deno exited 3 \(verify_schema_runtime_edge_import_failed\)$/)
    await expect(runVerifySchemaRuntime({
      ...baseOpts,
      spawnDeno: () => ({ status: 1, stdout: '', stderr: 'SUPERSECRET' }),
    })).rejects.not.toThrow(/SUPERSECRET/)
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

  it('detects a Deno-only internal exposure change', async () => {
    const result = await runVerifySchemaRuntime({
      configPath: `${fixture}movp.config.mjs`,
      denoConfigPath: `${fixture}deno.json`,
      edgeSchemaSpecifier: `${fixture}schema.internal.mjs`,
    })
    expect(result.ok).toBe(false)
    expect(result.code).toBe('schema_runtime_mismatch')
  })
})
