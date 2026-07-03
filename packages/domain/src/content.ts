import { z } from 'zod'
import type { ContentApprovalRow, ContentItemRow, ContentRevisionRow, ContentScheduleRow, ContentTypeRow } from './generated/types.ts'
import type { ContentService, DomainCtx } from './types.ts'

const DEFAULT_PAGE = 20
const MAX_PAGE = 100
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)
const encodeCursor = (v: string) => btoa(v)
const decodeCursor = (cursor: string) => atob(cursor)

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const FIELD_TYPES = ['text', 'richtext', 'number', 'bool', 'date', 'enum', 'asset', 'reference'] as const
type FieldType = (typeof FIELD_TYPES)[number]

interface FieldDefShape {
  name: string
  type: FieldType
  required?: boolean
  values?: string[]
}

function isValidFieldSchema(schema: unknown): schema is FieldDefShape[] {
  if (!Array.isArray(schema)) return false
  const seen = new Set<string>()
  for (const field of schema) {
    if (typeof field !== 'object' || field === null) return false
    const row = field as Record<string, unknown>
    if (typeof row.name !== 'string' || row.name.length === 0) return false
    if (seen.has(row.name)) return false
    seen.add(row.name)
    if (typeof row.type !== 'string' || !FIELD_TYPES.includes(row.type as FieldType)) return false
    if ('required' in row && typeof row.required !== 'boolean') return false
    if (row.type === 'enum') {
      if (!Array.isArray(row.values) || row.values.length === 0 || !row.values.every((v) => typeof v === 'string')) {
        return false
      }
    }
  }
  return true
}

function fieldSchemaToZod(fields: FieldDefShape[]): z.ZodType<Record<string, unknown>> {
  const shape: z.ZodRawShape = {}
  for (const field of fields) {
    let base: z.ZodTypeAny
    switch (field.type) {
      case 'text':
      case 'richtext':
      case 'asset':
      case 'date':
        base = z.string()
        break
      case 'reference':
        base = z.string().uuid()
        break
      case 'number':
        base = z.number()
        break
      case 'bool':
        base = z.boolean()
        break
      case 'enum':
        base = z.enum((field.values ?? ['']) as [string, ...string[]])
        break
    }
    shape[field.name] = field.required ? base : base.optional()
  }
  return z.object(shape) as z.ZodType<Record<string, unknown>>
}

function canonicalize(data: Record<string, unknown>): string {
  const sortValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sortValue)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = sortValue((value as Record<string, unknown>)[key])
      }
      return out
    }
    return value
  }
  return JSON.stringify(sortValue(data))
}

export function makeContentService(ctx: DomainCtx): ContentService {
  const fail = (op: string, code: string | undefined): never => {
    throw new Error(`domain.content.${op} failed [${code ?? 'unknown'}]`)
  }

  async function loadType(contentTypeId: string): Promise<FieldDefShape[]> {
    const { data, error } = await ctx.db
      .from('content_type')
      .select('field_schema')
      .eq('id', contentTypeId)
      .maybeSingle()
    if (error) fail('loadType', error.code)
    const raw = (data as { field_schema?: unknown } | null)?.field_schema
    if (raw == null) throw new Error('domain.content: content_type not found or inaccessible')
    if (!isValidFieldSchema(raw)) throw new Error('domain.content: stored field_schema is malformed')
    return raw
  }

  async function itemTypeId(itemId: string): Promise<string> {
    const { data, error } = await ctx.db
      .from('content_item')
      .select('content_type_id')
      .eq('id', itemId)
      .maybeSingle()
    if (error) fail('resolveItem', error.code)
    const id = (data as { content_type_id?: string } | null)?.content_type_id
    if (!id) throw new Error('domain.content: content item not found or inaccessible')
    return id
  }

  async function prepare(
    fields: FieldDefShape[],
    data: Record<string, unknown>,
  ): Promise<{ canonical: Record<string, unknown>; hash: string; searchText: string; searchBody: string }> {
    const parsed = fieldSchemaToZod(fields).parse(data)
    const canonicalJson = canonicalize(parsed)
    const hash = await sha256Hex(canonicalJson)
    const textParts: string[] = []
    const bodyParts: string[] = []
    for (const field of fields) {
      const value = parsed[field.name]
      if (value == null) continue
      if (field.type === 'richtext') bodyParts.push(String(value))
      else if (field.type === 'text' || field.type === 'enum') textParts.push(String(value))
    }
    return { canonical: parsed, hash, searchText: textParts.join(' '), searchBody: bodyParts.join(' ') }
  }

  return {
    async createType(input) {
      if (!isValidFieldSchema(input.fieldSchema)) {
        throw new Error('domain.content.createType: invalid field_schema (expected array of {name,type,required?})')
      }
      const { data, error } = await ctx.db.from('content_type').insert({
        workspace_id: input.workspaceId,
        key: input.key,
        label: input.label,
        field_schema: input.fieldSchema,
        moderation_policy: input.moderationPolicy ?? 'none',
        approval_policy: input.approvalPolicy ?? 'none',
      }).select('*').single()
      if (error) fail('createType', error.code)
      return data as ContentTypeRow
    },

    async listTypes(args) {
      const first = clamp(args.first ?? DEFAULT_PAGE, 1, MAX_PAGE)
      let query = ctx.db.from('content_type').select('*')
        .eq('workspace_id', args.workspaceId)
        .order('id', { ascending: true })
        .limit(first + 1)
      if (args.after) query = query.gt('id', decodeCursor(args.after))
      const { data, error } = await query
      if (error) fail('listTypes', error.code)
      const rows = (data ?? []) as ContentTypeRow[]
      const items = rows.length > first ? rows.slice(0, first) : rows
      const last = items.at(-1)
      return { items, nextCursor: rows.length > first && last ? encodeCursor(last.id) : null }
    },

    async create(input) {
      const fields = await loadType(input.contentTypeId)
      const prepared = await prepare(fields, input.data)
      const { data, error } = await ctx.db.rpc('create_content_with_revision', {
        ws: input.workspaceId,
        p_content_type_id: input.contentTypeId,
        p_slug: input.slug,
        p_data: prepared.canonical,
        p_content_hash: prepared.hash,
        p_search_text: prepared.searchText,
        p_search_body: prepared.searchBody,
      })
      if (error) fail('create', error.code)
      return data as ContentItemRow
    },

    async update(input) {
      const typeId = await itemTypeId(input.itemId)
      const fields = await loadType(typeId)
      const prepared = await prepare(fields, input.data)
      const { data, error } = await ctx.db.rpc('update_content', {
        p_item_id: input.itemId,
        p_data: prepared.canonical,
        p_content_hash: prepared.hash,
        p_search_text: prepared.searchText,
        p_search_body: prepared.searchBody,
      })
      if (error) fail('update', error.code)
      return data as ContentItemRow
    },

    async get(id) {
      const { data, error } = await ctx.db.from('content_item').select('*').eq('id', id).maybeSingle()
      if (error) fail('get', error.code)
      return (data as ContentItemRow | null) ?? null
    },

    async list(args) {
      const first = clamp(args.first ?? DEFAULT_PAGE, 1, MAX_PAGE)
      let query = ctx.db.from('content_item').select('*').eq('workspace_id', args.workspaceId)
      if (args.contentTypeId) query = query.eq('content_type_id', args.contentTypeId)
      if (args.status) query = query.eq('status', args.status)
      query = query.order('id', { ascending: true }).limit(first + 1)
      if (args.after) query = query.gt('id', decodeCursor(args.after))
      const { data, error } = await query
      if (error) fail('list', error.code)
      const rows = (data ?? []) as ContentItemRow[]
      const items = rows.length > first ? rows.slice(0, first) : rows
      const last = items.at(-1)
      return { items, nextCursor: rows.length > first && last ? encodeCursor(last.id) : null }
    },

    async listRevisions(args) {
      const first = clamp(args.first ?? DEFAULT_PAGE, 1, MAX_PAGE)
      let query = ctx.db.from('content_revision').select('*')
        .eq('content_item_id', args.itemId)
        .order('revision_number', { ascending: true })
        .limit(first + 1)
      if (args.after) query = query.gt('revision_number', Number(decodeCursor(args.after)))
      const { data, error } = await query
      if (error) fail('listRevisions', error.code)
      const rows = (data ?? []) as ContentRevisionRow[]
      const items = rows.length > first ? rows.slice(0, first) : rows
      const last = items.at(-1)
      return {
        items,
        nextCursor: rows.length > first && last ? encodeCursor(String(last.revision_number)) : null,
      }
    },

    async submitForApproval(input) {
      const { data, error } = await ctx.db.rpc('submit_for_approval', {
        p_item_id: input.itemId,
        p_policy: input.policy ?? 'single',
        p_approvals_required: input.approvalsRequired ?? 1,
      })
      if (error) fail('submitForApproval', error.code)
      return data as ContentItemRow
    },

    async decideApproval(input) {
      const { data, error } = await ctx.db.rpc('decide_approval', {
        p_approval_id: input.approvalId,
        p_vote: input.vote,
      })
      if (error) fail('decideApproval', error.code)
      return data as ContentApprovalRow
    },

    async publish(input) {
      const { data, error } = await ctx.db.rpc('publish_content', { p_item_id: input.itemId })
      if (error) fail('publish', error.code)
      return data as ContentItemRow
    },

    async unpublish(input) {
      const { data, error } = await ctx.db.rpc('unpublish_content', { p_item_id: input.itemId })
      if (error) fail('unpublish', error.code)
      return data as ContentItemRow
    },

    async getPublished(id) {
      const { data: item, error: itemError } = await ctx.db
        .from('content_item')
        .select('*')
        .eq('id', id)
        .maybeSingle()
      if (itemError) fail('getPublished', itemError.code)
      const row = item as ContentItemRow | null
      if (!row?.published_revision_id) return null

      const { data: revision, error: revisionError } = await ctx.db
        .from('content_revision')
        .select('*')
        .eq('id', row.published_revision_id)
        .maybeSingle()
      if (revisionError) fail('getPublished', revisionError.code)
      if (!revision) return null
      return { item: row, revision: revision as ContentRevisionRow }
    },

    async listApprovals(args) {
      const first = clamp(args.first ?? DEFAULT_PAGE, 1, MAX_PAGE)
      let query = ctx.db.from('content_approval').select('*').eq('workspace_id', args.workspaceId)
      if (args.itemId) query = query.eq('content_item_id', args.itemId)
      if (args.state) query = query.eq('state', args.state)
      query = query.order('id', { ascending: true }).limit(first + 1)
      if (args.after) query = query.gt('id', decodeCursor(args.after))
      const { data, error } = await query
      if (error) fail('listApprovals', error.code)
      const rows = (data ?? []) as ContentApprovalRow[]
      const items = rows.length > first ? rows.slice(0, first) : rows
      const last = items.at(-1)
      return { items, nextCursor: rows.length > first && last ? encodeCursor(last.id) : null }
    },

    async schedule(input) {
      const { data: item, error: itemError } = await ctx.db
        .from('content_item')
        .select('workspace_id')
        .eq('id', input.itemId)
        .single()
      if (itemError) fail('schedule', itemError.code)
      if (!item) throw new Error('domain.content.schedule: item_not_found')

      const { data, error } = await ctx.db.from('content_schedule').insert({
        workspace_id: (item as { workspace_id: string }).workspace_id,
        content_item_id: input.itemId,
        action: input.action,
        revision_id: input.revisionId,
        run_at: input.runAt,
        scheduled_by: ctx.userId,
      }).select('*').single()
      if (error) fail('schedule', error.code)
      return data as ContentScheduleRow
    },
  }
}
