import { AdminDomainError } from './admin.ts'
import type { CreatedPat, DomainCtx, PatService, PatTokenRow } from './types.ts'

function fail(op: string, code: string, reason?: string): never {
  throw new AdminDomainError(op, code, reason)
}

export function makePatService(ctx: DomainCtx): PatService {
  return {
    async createToken({ defaultWorkspaceId, name, ttlDays }) {
      const { data, error } = await ctx.db.rpc('create_personal_access_token', {
        default_ws: defaultWorkspaceId,
        name,
        ttl_days: ttlDays ?? null,
      })
      if (error) fail('createToken', error.code ?? 'unknown', error.message)
      const row = (data ?? {}) as Record<string, unknown>
      return { tokenId: String(row.token_id ?? ''), token: String(row.token ?? '') }
    },

    async listTokens() {
      const { data, error } = await ctx.db.rpc('list_personal_access_tokens')
      if (error) fail('listTokens', error.code ?? 'unknown', error.message)
      return Array.isArray(data) ? (data as PatTokenRow[]) : []
    },

    async revokeToken({ tokenId }) {
      const { error } = await ctx.db.rpc('revoke_personal_access_token', { token_id: tokenId })
      if (error) fail('revokeToken', error.code ?? 'unknown', error.message)
    },
  }
}
