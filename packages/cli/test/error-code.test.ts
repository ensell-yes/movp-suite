import { describe, expect, it } from 'vitest'
import { cliErrorCode } from '../src/error-code.ts'

describe('cliErrorCode', () => {
  it.each([
    ['schema_runtime_mismatch: node=one deno=two', 'schema_runtime_mismatch'],
    ['verify_schema_runtime_spawn_failed: deno spawn ENOENT', 'verify_schema_runtime_spawn_failed'],
    ['delta_registry_update_failed: migration is intact', 'delta_registry_update_failed'],
    ['project_codegen_use_project_bin: use npm run codegen', 'project_codegen_use_project_bin'],
    ['invalid_token', 'invalid_token'],
  ])('preserves a bounded stable code from %s', (message, expected) => {
    expect(cliErrorCode(new Error(message))).toBe(expected)
  })

  it('collapses unknown and non-error values without exposing their contents', () => {
    expect(cliErrorCode(new Error('aws_secret_access_key: SUPERSECRET'))).toBe('cli_error')
    expect(cliErrorCode({ message: 'schema_runtime_mismatch: forged' })).toBe('cli_error')
  })
})
