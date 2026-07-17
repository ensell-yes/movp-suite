import { z } from 'zod'
import { docToPlainText, normalizeToCanonicalDoc } from '@movp/richtext'
import { validateAssetRequest } from './asset-bounds.ts'
import { makeGraphService } from './graph.ts'
import { auditSeo } from './seo-audit.ts'
import type {
  AssetRow,
  ContentApprovalRow,
  ContentCollectionRow,
  ContentItemRow,
  ContentRevisionRow,
  ContentScheduleRow,
  ContentSeoRow,
  ContentTypeRow,
} from './generated/types.ts'
import type { ContentService, DomainCtx } from './types.ts'

const DEFAULT_PAGE = 20
const MAX_PAGE = 100
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)
const encodeCursor = (v: string) => btoa(v)
const decodeCursor = (cursor: string) => atob(cursor)

type ContentDetailQueryRow = ContentItemRow & {
  type: ContentTypeRow | null
  current_revision: ContentRevisionRow | null
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const FIELD_TYPES = ['text', 'richtext', 'number', 'bool', 'date', 'enum', 'asset', 'reference', 'json'] as const
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
      case 'json':
        base = z.unknown()
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

  async function itemWorkspace(itemId: string): Promise<string> {
    const { data, error } = await ctx.db
      .from('content_item')
      .select('workspace_id')
      .eq('id', itemId)
      .maybeSingle()
    if (error) fail('resolveItemWorkspace', error.code)
    const id = (data as { workspace_id?: string } | null)?.workspace_id
    if (!id) throw new Error('domain.content: content item not found or inaccessible')
    return id
  }

  async function getContentItem(id: string): Promise<ContentItemRow | null> {
    const { data, error } = await ctx.db.from('content_item').select('*').eq('id', id).maybeSingle()
    if (error) fail('get', error.code)
    return (data as ContentItemRow | null) ?? null
  }

  async function prepare(
    fields: FieldDefShape[],
    data: Record<string, unknown>,
  ): Promise<{ canonical: Record<string, unknown>; hash: string; searchText: string; searchBody: string }> {
    const parsed = fieldSchemaToZod(fields).parse(data)
    // Normalize richtext to canonical doc-JSON BEFORE hashing so the canonical invariant holds for
    // every write surface (GraphQL/MCP/CLI/domain), not just the frontend endpoint (spec §3.3).
    for (const field of fields) {
      if (field.type === 'richtext' && parsed[field.name] != null) {
        parsed[field.name] = normalizeToCanonicalDoc(parsed[field.name])
      }
    }
    const canonicalJson = canonicalize(parsed)
    const hash = await sha256Hex(canonicalJson)
    const textParts: string[] = []
    const bodyParts: string[] = []
    for (const field of fields) {
      const value = parsed[field.name]
      if (value == null) continue
      if (field.type === 'richtext') bodyParts.push(docToPlainText(JSON.parse(value as string)))
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
      const args: Record<string, unknown> = {
        p_item_id: input.itemId,
        p_data: prepared.canonical,
        p_content_hash: prepared.hash,
        p_search_text: prepared.searchText,
        p_search_body: prepared.searchBody,
        p_expected_revision_id: input.expectedRevisionId ?? null,
      }
      const { data, error } = await ctx.db.rpc('update_content', args)
      if (error) fail('update', error.message?.includes('content_update_conflict') ? 'content_update_conflict' : error.code)
      return data as ContentItemRow
    },

    get: getContentItem,

    async getDetail(id) {
      const { data, error } = await ctx.db
        .from('content_item')
        .select(`
          *,
          type:content_type!content_item_content_type_id_fkey(*),
          current_revision:content_revision!content_item_current_revision_fk(*)
        `)
        .eq('id', id)
        .maybeSingle()
      if (error) fail('getDetail', error.code)
      if (!data) return null
      const row = data as ContentDetailQueryRow
      const { type, current_revision, ...item } = row
      return {
        item,
        type,
        currentRevision: current_revision,
      }
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

    async issueAssetUpload(input) {
      const assetsFnUrl = ctx.assetsFnUrl ?? fail('issueAssetUpload', 'asset_upload_not_configured')
      const accessToken = ctx.accessToken ?? fail('issueAssetUpload', 'asset_upload_not_configured')
      const validation = validateAssetRequest({ mime: input.mime, sizeBytes: input.sizeBytes })
      if (!validation.ok) fail('issueAssetUpload', validation.error)

      const res = await fetch(assetsFnUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'issue', ...input }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        fail('issueAssetUpload', body.error ?? String(res.status))
      }
      return await res.json() as { uploadUrl: string; r2Key: string; assetId: string }
    },

    async finalizeAsset(input) {
      const assetsFnUrl = ctx.assetsFnUrl ?? fail('finalizeAsset', 'asset_upload_not_configured')
      const accessToken = ctx.accessToken ?? fail('finalizeAsset', 'asset_upload_not_configured')

      const res = await fetch(assetsFnUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'finalize', ...input }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        fail('finalizeAsset', body.error ?? String(res.status))
      }
      return await res.json() as AssetRow
    },

    async createCollection(input) {
      const { data, error } = await ctx.db.from('content_collection').insert({
        workspace_id: input.workspaceId,
        key: input.key,
        label: input.label,
        description: input.description ?? null,
      }).select('*').single()
      if (error) fail('createCollection', error.code)
      return data as ContentCollectionRow
    },

    async addToCollection(input) {
      const { data: collection, error: collectionError } = await ctx.db
        .from('content_collection')
        .select('workspace_id')
        .eq('id', input.collectionId)
        .maybeSingle()
      if (collectionError) fail('addToCollection', collectionError.code)
      if (!collection) throw new Error('domain.content.addToCollection: collection_not_found')

      const { error } = await ctx.db.from('content_collection_entry').insert({
        workspace_id: (collection as { workspace_id: string }).workspace_id,
        collection_id: input.collectionId,
        content_item_id: input.itemId,
        position: input.position ?? 0,
      })
      if (error) fail('addToCollection', error.code)
    },

    async reorderCollection(input) {
      for (let position = 0; position < input.orderedItemIds.length; position++) {
        const { error } = await ctx.db
          .from('content_collection_entry')
          .update({ position })
          .eq('collection_id', input.collectionId)
          .eq('content_item_id', input.orderedItemIds[position])
          .select('id')
          .single()
        if (error) fail('reorderCollection', error.code)
      }
    },

    async runSeoAudit(input) {
      const { data: item, error: itemError } = await ctx.db
        .from('content_item')
        .select('workspace_id, current_revision_id')
        .eq('id', input.itemId)
        .maybeSingle()
      if (itemError) fail('runSeoAudit', itemError.code)
      if (!item) throw new Error('domain.content.runSeoAudit: item_not_found')

      const itemRow = item as { workspace_id: string; current_revision_id: string | null }
      const { data: revision, error: revisionError } = await ctx.db
        .from('content_revision')
        .select('data')
        .eq('id', itemRow.current_revision_id)
        .maybeSingle()
      if (revisionError) fail('runSeoAudit', revisionError.code)

      const { data: seoRow, error: seoError } = await ctx.db
        .from('content_seo')
        .select('meta, jsonld')
        .eq('content_item_id', input.itemId)
        .maybeSingle()
      if (seoError) fail('runSeoAudit', seoError.code)

      const { data: assetEdges, error: edgeError } = await ctx.db
        .from('edges')
        .select('dst_id')
        .eq('src_type', 'content_item')
        .eq('src_id', input.itemId)
        .eq('rel', 'references')
        .eq('dst_type', 'asset')
      if (edgeError) fail('runSeoAudit', edgeError.code)

      const assetIds = ((assetEdges ?? []) as Array<{ dst_id: string }>).map((edge) => edge.dst_id)
      let referencedAssets: Array<{ alt_text: string | null }> = []
      if (assetIds.length > 0) {
        const { data: assets, error: assetError } = await ctx.db.from('asset').select('alt_text').in('id', assetIds)
        if (assetError) fail('runSeoAudit', assetError.code)
        referencedAssets = (assets ?? []) as Array<{ alt_text: string | null }>
      }

      const result = auditSeo({
        data: ((revision as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>,
        meta: ((seoRow as { meta?: Record<string, unknown> | null } | null)?.meta ?? null) as Record<string, unknown> | null,
        jsonld: (seoRow as { jsonld?: unknown } | null)?.jsonld ?? null,
        referencedAssets,
      })

      const { data, error } = await ctx.db.from('content_seo').upsert({
        workspace_id: itemRow.workspace_id,
        content_item_id: input.itemId,
        score: result.score,
        checklist: result.checklist as unknown as Record<string, unknown>,
      }, { onConflict: 'content_item_id' }).select('*').single()
      if (error) fail('runSeoAudit', error.code)
      return data as ContentSeoRow
    },

    async linkAsset(input) {
      const workspaceId = await itemWorkspace(input.itemId)
      const graph = makeGraphService(ctx)
      await graph.link({
        workspaceId,
        srcType: 'content_item',
        srcId: input.itemId,
        rel: 'references',
        dstType: 'asset',
        dstId: input.assetId,
      })
    },

    async linkItem(input) {
      const workspaceId = await itemWorkspace(input.itemId)
      const graph = makeGraphService(ctx)
      await graph.link({
        workspaceId,
        srcType: 'content_item',
        srcId: input.itemId,
        rel: 'references',
        dstType: 'content_item',
        dstId: input.targetItemId,
      })
    },

    async linkEditorialTask(input) {
      const workspaceId = await itemWorkspace(input.itemId)
      const graph = makeGraphService(ctx)
      await graph.link({
        workspaceId,
        srcType: 'content_item',
        srcId: input.itemId,
        rel: 'editorial_task',
        dstType: 'task',
        dstId: input.taskId,
      })
    },
  }
}
