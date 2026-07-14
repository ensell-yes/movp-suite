import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runtimeFingerprint, type MovpSchema } from '@movp/core-schema'

export interface SpawnResult {
  status: number | null
  stdout: string
  stderr: string
}

export interface VerifySchemaRuntimeOpts {
  configPath: string
  denoConfigPath: string
  edgeSchemaSpecifier: string
  spawnDeno?: (args: string[]) => SpawnResult
  importConfig?: (path: string) => Promise<{ schema: MovpSchema }>
}

export interface VerifySchemaRuntimeResult {
  ok: boolean
  code?: 'schema_runtime_mismatch'
  nodeFingerprint: string
  denoFingerprint: string
}

function defaultSpawnDeno(args: string[]): SpawnResult {
  const result = spawnSync('deno', args, { encoding: 'utf8' })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

export async function runVerifySchemaRuntime(
  opts: VerifySchemaRuntimeOpts,
): Promise<VerifySchemaRuntimeResult> {
  const importConfig = opts.importConfig ?? (async (path: string) => {
    const url = pathToFileURL(resolve(path)).href
    return import(url) as Promise<{ schema: MovpSchema }>
  })
  const spawnDeno = opts.spawnDeno ?? defaultSpawnDeno
  const config = await importConfig(opts.configPath)
  const nodeFingerprint = runtimeFingerprint(config.schema)
  const scriptPath = fileURLToPath(new URL('./verify-schema-runtime.deno.ts', import.meta.url))
  const result = spawnDeno([
    'run',
    '--allow-read',
    '--config',
    opts.denoConfigPath,
    scriptPath,
    opts.edgeSchemaSpecifier,
  ])

  if (result.status !== 0) {
    throw new Error(`verify_schema_runtime_spawn_failed: deno exited ${result.status ?? 'null'}`)
  }

  const denoFingerprint = result.stdout.trim()
  if (!/^[0-9a-f]{64}$/.test(denoFingerprint)) {
    throw new Error('verify_schema_runtime_spawn_failed: deno produced a non-fingerprint output')
  }

  return denoFingerprint === nodeFingerprint
    ? { ok: true, nodeFingerprint, denoFingerprint }
    : { ok: false, code: 'schema_runtime_mismatch', nodeFingerprint, denoFingerprint }
}
