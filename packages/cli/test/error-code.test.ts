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

  it('preserves cli_access_disabled', () => {
    expect(cliErrorCode(new Error('cli_access_disabled'))).toBe('cli_access_disabled')
  })

  it('preserves agent_access_check_failed', () => {
    expect(cliErrorCode(new Error('agent_access_check_failed'))).toBe('agent_access_check_failed')
  })

  it('preserves agent_session_ttl_out_of_bounds', () => {
    expect(cliErrorCode(new Error('agent_session_ttl_out_of_bounds'))).toBe('agent_session_ttl_out_of_bounds')
  })
})
