import { describe, expect, it, vi } from 'vitest'
import { makeAgentAccessService } from '../src/agent-access.ts'
import type { DomainCtx } from '../src/types.ts'

function context(result: unknown, error: { code?: string; message?: string } | null = null): {
  ctx: DomainCtx
  rpc: ReturnType<typeof vi.fn>
} {
  const rpc = vi.fn(async () => ({ data: result, error }))
  return {
    ctx: { db: { rpc } as unknown as DomainCtx['db'], userId: 'user-1' },
    rpc,
  }
}

describe('agent access domain service', () => {
  it('reads caller-bound preferences and maps the persisted shape', async () => {
    const { ctx, rpc } = context({ mcp_enabled: false, cli_enabled: true })

    await expect(makeAgentAccessService(ctx).get()).resolves.toEqual({
      mcpEnabled: false,
      cliEnabled: true,
    })
    expect(rpc).toHaveBeenCalledWith('get_agent_access_preferences')
  })

  it('submits both booleans without a user id', async () => {
    const { ctx, rpc } = context({ mcp_enabled: true, cli_enabled: false })

    await expect(makeAgentAccessService(ctx).update(true, false)).resolves.toEqual({
      mcpEnabled: true,
      cliEnabled: false,
    })
    expect(rpc).toHaveBeenCalledWith('update_agent_access_preferences', {
      p_mcp_enabled: true,
      p_cli_enabled: false,
    })
  })

  it('maps read failures to the domain error boundary', async () => {
    const { ctx } = context(null, { code: '42501', message: 'private detail' })

    await expect(makeAgentAccessService(ctx).get()).rejects.toMatchObject({
      pgCode: '42501',
      reason: 'private detail',
    })
  })

  it('maps update failures to the domain error boundary', async () => {
    const { ctx } = context(null, { code: '57014', message: 'private detail' })

    await expect(makeAgentAccessService(ctx).update(false, false)).rejects.toMatchObject({
      pgCode: '57014',
      reason: 'private detail',
    })
  })

  it('rejects malformed read responses instead of coercing them', async () => {
    const { ctx } = context({ mcp_enabled: 'false', cli_enabled: true })

    await expect(makeAgentAccessService(ctx).get()).rejects.toMatchObject({
      pgCode: 'invalid_response',
    })
  })

  it('rejects malformed update responses instead of claiming success', async () => {
    const { ctx } = context({ mcp_enabled: true })

    await expect(makeAgentAccessService(ctx).update(true, true)).rejects.toMatchObject({
      pgCode: 'invalid_response',
    })
  })
})
