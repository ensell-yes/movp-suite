import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decideAgentAccess, evaluateAgentAccess } from '../src/agent-access.ts'

function adminWith(results: Array<unknown | Error>): { admin: SupabaseClient; rpc: ReturnType<typeof vi.fn> } {
  let index = 0
  const rpc = vi.fn(async () => {
    const result = results[Math.min(index, results.length - 1)]
    index += 1
    if (result instanceof Error) throw result
    return result
  })
  return { admin: { rpc } as unknown as SupabaseClient, rpc }
}

describe('agent access decisions', () => {
  it('allows enabled MCP and PAT-backed CLI surfaces', () => {
    const preferences = { mcpEnabled: true, cliEnabled: true }
    expect(decideAgentAccess(preferences, 'mcp')).toEqual({ ok: true })
    expect(decideAgentAccess(preferences, 'cli')).toEqual({ ok: true })
  })

  it('returns the stable MCP denial', () => {
    expect(decideAgentAccess({ mcpEnabled: false, cliEnabled: true }, 'mcp')).toEqual({
      ok: false,
      code: 'mcp_access_disabled',
    })
  })

  it('returns the stable PAT CLI/API denial', () => {
    expect(decideAgentAccess({ mcpEnabled: true, cliEnabled: false }, 'cli')).toEqual({
      ok: false,
      code: 'cli_access_disabled',
    })
  })
})

describe('session preference evaluation', () => {
  it('evaluates the caller once through the service-only RPC', async () => {
    const { admin, rpc } = adminWith([{
      data: { mcp_enabled: false, cli_enabled: true },
      error: null,
      status: 200,
    }])

    await expect(evaluateAgentAccess('user-1', 'mcp', admin)).resolves.toMatchObject({
      decision: { ok: false, code: 'mcp_access_disabled' },
      attempt: 1,
    })
    expect(rpc).toHaveBeenCalledWith('evaluate_agent_access', { p_user_id: 'user-1' })
    expect(rpc).toHaveBeenCalledOnce()
  })

  it('retries one thrown transport failure and can recover', async () => {
    const { admin, rpc } = adminWith([
      new Error('transport failed'),
      { data: { mcp_enabled: true, cli_enabled: true }, error: null, status: 200 },
    ])

    await expect(evaluateAgentAccess('user-1', 'mcp', admin)).resolves.toMatchObject({
      decision: { ok: true },
      attempt: 2,
    })
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('retries one gateway failure then fails closed with attempt and latency', async () => {
    const { admin, rpc } = adminWith([
      { data: null, error: { code: 'gateway' }, status: 503 },
      { data: null, error: { code: 'gateway' }, status: 504 },
    ])

    await expect(evaluateAgentAccess('user-1', 'mcp', admin)).resolves.toMatchObject({
      decision: { ok: false, code: 'agent_access_check_failed' },
      attempt: 2,
      latencyMs: expect.any(Number),
    })
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('does not retry malformed responses or terminal 4xx failures', async () => {
    const malformed = adminWith([{ data: { mcp_enabled: 'yes' }, error: null, status: 200 }])
    const forbidden = adminWith([{ data: null, error: { code: '42501' }, status: 403 }])

    await expect(evaluateAgentAccess('user-1', 'mcp', malformed.admin)).resolves.toMatchObject({
      decision: { ok: false, code: 'agent_access_check_failed' },
      attempt: 1,
    })
    await expect(evaluateAgentAccess('user-1', 'mcp', forbidden.admin)).resolves.toMatchObject({
      decision: { ok: false, code: 'agent_access_check_failed' },
      attempt: 1,
    })
    expect(malformed.rpc).toHaveBeenCalledOnce()
    expect(forbidden.rpc).toHaveBeenCalledOnce()
  })
})
