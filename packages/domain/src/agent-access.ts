import { AdminDomainError } from './admin.ts'
import type { AgentAccessPreferences, AgentAccessService, DomainCtx } from './types.ts'

function fail(operation: string, code: string, reason?: string): never {
  throw new AdminDomainError(operation, code, reason)
}

function parsePreferences(operation: string, value: unknown): AgentAccessPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(operation, 'invalid_response')
  }
  const row = value as Record<string, unknown>
  if (typeof row.mcp_enabled !== 'boolean' || typeof row.cli_enabled !== 'boolean') {
    fail(operation, 'invalid_response')
  }
  return { mcpEnabled: row.mcp_enabled, cliEnabled: row.cli_enabled }
}

export function makeAgentAccessService(ctx: DomainCtx): AgentAccessService {
  return {
    async get() {
      const { data, error } = await ctx.db.rpc('get_agent_access_preferences')
      if (error) fail('agentAccessPreferences', error.code ?? 'unknown', error.message)
      return parsePreferences('agentAccessPreferences', data)
    },

    async update(mcpEnabled, cliEnabled) {
      const { data, error } = await ctx.db.rpc('update_agent_access_preferences', {
        p_mcp_enabled: mcpEnabled,
        p_cli_enabled: cliEnabled,
      })
      if (error) fail('updateAgentAccessPreferences', error.code ?? 'unknown', error.message)
      return parsePreferences('updateAgentAccessPreferences', data)
    },
  }
}
