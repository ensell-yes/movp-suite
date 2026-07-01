import type { CommentRow } from './generated/types.ts'
import type { CollabService, DomainCtx, InboxItem } from './types.ts'

const DEFAULT_PAGE = 20
const MAX_PAGE = 100
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)
const encodeCursor = (id: string) => btoa(id)
const decodeCursor = (cursor: string) => atob(cursor)

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function resolveShareLink(
  ctx: DomainCtx,
  token: string,
): Promise<{ entity_type: string; entity_id: string; workspace_id: string } | null> {
  const { data, error } = await ctx.db.rpc('resolve_share_link', { p_token_hash: await sha256Hex(token) })
  if (error) throw new Error(`domain.collab.resolveShareLink failed [${error.code ?? 'unknown'}]`)
  return (data as { entity_type: string; entity_id: string; workspace_id: string } | null) ?? null
}

export function makeCollabService(ctx: DomainCtx): CollabService {
  const fail = (op: string, code: string | undefined): never => {
    throw new Error(`domain.collab.${op} failed [${code ?? 'unknown'}]`)
  }

  async function workspaceOf(entityType: string, entityId: string): Promise<string> {
    const { data, error } = await ctx.db.from(entityType).select('workspace_id').eq('id', entityId).maybeSingle()
    if (error) fail('resolveEntity', error.code)
    const ws = (data as { workspace_id?: string } | null)?.workspace_id
    if (!ws) throw new Error('domain.collab: entity not found or inaccessible')
    return ws
  }

  return {
    comment: {
      async create(input) {
        const ws = await workspaceOf(input.entityType, input.entityId)
        const mentions = [...new Set(input.mentions ?? [])]
        const { data, error } = await ctx.db.rpc('create_comment_with_mentions', {
          ws,
          p_entity_type: input.entityType,
          p_entity_id: input.entityId,
          p_body: input.body,
          p_parent_id: input.parentId ?? null,
          p_mentions: mentions,
        })
        if (error) fail('comment.create', error.code)
        return data as CommentRow
      },

      async listByEntity(a) {
        const first = clamp(a.first ?? DEFAULT_PAGE, 1, MAX_PAGE)
        let q = ctx.db
          .from('comment')
          .select('*')
          .eq('workspace_id', a.workspaceId)
          .eq('entity_type', a.entityType)
          .eq('entity_id', a.entityId)
          .order('id', { ascending: true })
          .limit(first + 1)
        if (a.after) q = q.gt('id', decodeCursor(a.after))
        const { data, error } = await q
        if (error) fail('comment.listByEntity', error.code)
        const rows = (data ?? []) as CommentRow[]
        const items = rows.length > first ? rows.slice(0, first) : rows
        const last = items.at(-1)
        return { items, nextCursor: rows.length > first && last ? encodeCursor(last.id) : null }
      },
    },

    async react(i) {
      const ws = await workspaceOf(i.entityType, i.entityId)
      const { error } = await ctx.db
        .from('reaction')
        .upsert(
          {
            workspace_id: ws,
            user_id: ctx.userId,
            entity_type: i.entityType,
            entity_id: i.entityId,
            kind: i.kind,
          },
          { onConflict: 'workspace_id,user_id,entity_type,entity_id,kind', ignoreDuplicates: true },
        )
      if (error) fail('react', error.code)
    },

    async unreact(i) {
      const { error } = await ctx.db
        .from('reaction')
        .delete()
        .eq('user_id', ctx.userId)
        .eq('entity_type', i.entityType)
        .eq('entity_id', i.entityId)
        .eq('kind', i.kind)
      if (error) fail('unreact', error.code)
    },

    async save(i) {
      const ws = await workspaceOf(i.entityType, i.entityId)
      const { error } = await ctx.db
        .from('saved_item')
        .upsert(
          {
            workspace_id: ws,
            user_id: ctx.userId,
            entity_type: i.entityType,
            entity_id: i.entityId,
          },
          { onConflict: 'workspace_id,user_id,entity_type,entity_id', ignoreDuplicates: true },
        )
      if (error) fail('save', error.code)
    },

    async unsave(i) {
      const { error } = await ctx.db
        .from('saved_item')
        .delete()
        .eq('user_id', ctx.userId)
        .eq('entity_type', i.entityType)
        .eq('entity_id', i.entityId)
      if (error) fail('unsave', error.code)
    },

    async createShareLink(i) {
      const ws = await workspaceOf(i.entityType, i.entityId)
      const token = crypto.randomUUID()
      const expiresAt = i.expiresInHours ? new Date(Date.now() + i.expiresInHours * 3_600_000).toISOString() : null
      const { error } = await ctx.db.from('share_link').insert({
        workspace_id: ws,
        entity_type: i.entityType,
        entity_id: i.entityId,
        token_hash: await sha256Hex(token),
        scope: 'view',
        created_by: ctx.userId,
        expires_at: expiresAt,
      })
      if (error) fail('createShareLink', error.code)
      return { token }
    },

    async inbox(a) {
      const { data, error } = await ctx.db.rpc('inbox_feed', {
        ws: a.workspaceId,
        tab: a.tab,
        lim: clamp(a.first ?? DEFAULT_PAGE, 1, MAX_PAGE),
      })
      if (error) fail('inbox', error.code)
      return (data ?? []) as InboxItem[]
    },
  }
}
