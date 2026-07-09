import type {
  AdminInviteResult,
  DeadJobRow,
  AdminService,
  DomainCtx,
  IngestKeyRow,
  IngestKeySecret,
  WorkspaceMemberRow,
  WorkspaceRow,
  WorkspaceSettings,
} from './types.ts'

export class AdminDomainError extends Error {
  readonly op: string
  readonly pgCode: string
  readonly reason: string

  constructor(op: string, pgCode: string, reason?: string) {
    const cleanReason = reason && reason.length > 0 ? reason : 'unknown'
    super(`domain.admin.${op} failed [${pgCode}]: ${cleanReason}`)
    this.name = 'AdminDomainError'
    this.op = op
    this.pgCode = pgCode
    this.reason = cleanReason
  }
}

function fail(op: string, code: string, reason?: string): never {
  throw new AdminDomainError(op, code, reason)
}

function requireObject<T>(op: string, value: unknown): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(op, 'empty_result')
  return value as T
}

function mapInvite(value: unknown): AdminInviteResult {
  const row = requireObject<Record<string, unknown>>('inviteMember', value)
  return {
    inviteId: String(row.invite_id ?? row.inviteId ?? ''),
    token: String(row.token ?? ''),
  }
}

function mapIngestSecret(op: string, value: unknown): IngestKeySecret {
  const row = requireObject<Record<string, unknown>>(op, value)
  return {
    keyId: String(row.key_id ?? row.keyId ?? ''),
    rawKey: String(row.raw_key ?? row.rawKey ?? ''),
  }
}

function mapSettings(value: unknown): WorkspaceSettings {
  const row = requireObject<Record<string, unknown>>('settings', value)
  return {
    workspace_id: String(row.workspace_id ?? ''),
    name: row.name == null ? null : String(row.name),
    member_count: Number(row.member_count ?? 0),
  }
}

export function makeAdminService(ctx: DomainCtx): AdminService {
  return {
    async createWorkspace({ name }) {
      const { data, error } = await ctx.db.rpc('create_workspace', { p_name: name })
      if (error) fail('createWorkspace', error.code ?? 'unknown', error.message)
      return requireObject<WorkspaceRow>('createWorkspace', data)
    },

    async inviteMember({ workspaceId, email, role }) {
      const { data, error } = await ctx.db.rpc('invite_member', {
        ws: workspaceId,
        invite_email: email,
        invite_role: role,
      })
      if (error) fail('inviteMember', error.code ?? 'unknown', error.message)
      return mapInvite(data)
    },

    async acceptInvite({ token }) {
      const { data, error } = await ctx.db.rpc('accept_invite', { invite_token: token })
      if (error) fail('acceptInvite', error.code ?? 'unknown', error.message)
      return requireObject<WorkspaceMemberRow>('acceptInvite', data)
    },

    async listMembers({ workspaceId }) {
      const { data, error } = await ctx.db.rpc('list_workspace_members', { ws: workspaceId })
      if (error) fail('listMembers', error.code ?? 'unknown', error.message)
      return Array.isArray(data) ? data as WorkspaceMemberRow[] : []
    },

    async setMemberRole({ workspaceId, userId, role }) {
      const { data, error } = await ctx.db.rpc('set_member_role', {
        ws: workspaceId,
        target_user: userId,
        new_role: role,
      })
      if (error) fail('setMemberRole', error.code ?? 'unknown', error.message)
      return requireObject<WorkspaceMemberRow>('setMemberRole', data)
    },

    async removeMember({ workspaceId, userId }) {
      const { error } = await ctx.db.rpc('remove_member', { ws: workspaceId, target_user: userId })
      if (error) fail('removeMember', error.code ?? 'unknown', error.message)
    },

    async createIngestKey({ workspaceId, label }) {
      const { data, error } = await ctx.db.rpc('create_ingest_key', { ws: workspaceId, label })
      if (error) fail('createIngestKey', error.code ?? 'unknown', error.message)
      return mapIngestSecret('createIngestKey', data)
    },

    async rotateIngestKey({ workspaceId, keyId }) {
      const { data, error } = await ctx.db.rpc('rotate_ingest_key', { key_id: keyId, ws: workspaceId })
      if (error) fail('rotateIngestKey', error.code ?? 'unknown', error.message)
      return mapIngestSecret('rotateIngestKey', data)
    },

    async revokeIngestKey({ workspaceId, keyId }) {
      const { error } = await ctx.db.rpc('revoke_ingest_key', { key_id: keyId, ws: workspaceId })
      if (error) fail('revokeIngestKey', error.code ?? 'unknown', error.message)
    },

    async listIngestKeys({ workspaceId }) {
      const { data, error } = await ctx.db.rpc('list_ingest_keys', { ws: workspaceId })
      if (error) fail('listIngestKeys', error.code ?? 'unknown', error.message)
      return Array.isArray(data) ? data as IngestKeyRow[] : []
    },

    async jobCounts({ workspaceId }) {
      const { data, error } = await ctx.db.rpc('workspace_job_counts', { ws: workspaceId })
      if (error) fail('jobCounts', error.code ?? 'unknown', error.message)
      return data && typeof data === 'object' && !Array.isArray(data)
        ? data as Record<string, number>
        : {}
    },

    async deadJobs({ workspaceId, first }) {
      const { data, error } = await ctx.db.rpc('workspace_dead_jobs', { ws: workspaceId, lim: first ?? 50 })
      if (error) fail('deadJobs', error.code ?? 'unknown', error.message)
      return Array.isArray(data) ? data as DeadJobRow[] : []
    },

    async replayDeadJobs({ workspaceId, kind }) {
      const { data, error } = await ctx.db.rpc('replay_dead_jobs', { ws: workspaceId, job_kind: kind ?? null })
      if (error) fail('replayDeadJobs', error.code ?? 'unknown', error.message)
      return Number(data ?? 0)
    },

    async settings({ workspaceId }) {
      const { data, error } = await ctx.db.rpc('workspace_settings', { ws: workspaceId })
      if (error) fail('settings', error.code ?? 'unknown', error.message)
      return mapSettings(data)
    },
  }
}
