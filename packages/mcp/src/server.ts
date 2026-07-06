import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { CollectionDef, FieldDef, MovpSchema } from '@movp/core-schema'
import { createDomain, type CollectionService, type Domain, type EmbeddingProvider } from '@movp/domain'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface McpCtx {
  db: SupabaseClient
  userId: string
  embedder?: EmbeddingProvider
  accessToken?: string
  assetsFnUrl?: string
}

type AnyService = CollectionService<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>

function service(domain: Domain, name: string): AnyService {
  const svc = (domain as unknown as Record<string, AnyService>)[name]
  if (!svc || typeof svc.create !== 'function') throw new Error(`no domain service for collection: ${name}`)
  return svc
}

function createShape(c: CollectionDef): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = { workspace_id: z.string() }
  for (const [name, def] of Object.entries(c.fields) as [string, FieldDef][]) {
    if (def.type === 'relation') continue
    shape[name] = def.required ? z.string() : z.string().optional()
  }
  return shape
}

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
}

function parseJson(value: string | undefined, fallback: unknown): unknown {
  if (value == null || value.length === 0) return fallback
  try {
    return JSON.parse(value)
  } catch {
    throw new Error('invalid_json')
  }
}

export function buildMcpServer(schema: MovpSchema, ctx: McpCtx): McpServer {
  const server = new McpServer({ name: 'movp', version: '0.1.0' })
  const domain = createDomain({
    db: ctx.db,
    userId: ctx.userId,
    accessToken: ctx.accessToken,
    assetsFnUrl: ctx.assetsFnUrl,
  }, { embedder: ctx.embedder })

  for (const c of schema.collections) {
    if (c.internal) continue
    const svc = service(domain, c.name)

    server.registerTool(
      `${c.name}.create`,
      { title: `Create ${c.label}`, description: `Create a ${c.label}`, inputSchema: createShape(c) },
      async (args: Record<string, unknown>) => text(await svc.create(args)),
    )

    server.registerTool(
      `${c.name}.get`,
      { title: `Get ${c.label}`, description: `Get a ${c.label} by id`, inputSchema: { id: z.string() } },
      async ({ id }) => text(await svc.get(id)),
    )

    server.registerTool(
      `${c.name}.list`,
      {
        title: `List ${c.labelPlural}`,
        description: `List ${c.labelPlural} in a workspace`,
        inputSchema: { workspaceId: z.string(), first: z.number().optional(), after: z.string().optional() },
      },
      async ({ workspaceId, first, after }) => text(await svc.list({ workspaceId, first, after: after ?? null })),
    )

    server.registerTool(
      `${c.name}.search`,
      {
        title: `Search ${c.labelPlural}`,
        description: `Search within ${c.labelPlural}`,
        inputSchema: {
          workspaceId: z.string(),
          query: z.string(),
          mode: z.enum(['fts', 'semantic', 'hybrid']).optional(),
          limit: z.number().optional(),
        },
      },
      async ({ workspaceId, query, mode, limit }) =>
        text(
          await domain.search({
            workspaceId,
            query,
            mode: mode ?? (ctx.embedder ? 'hybrid' : 'fts'),
            collection: c.name,
            limit,
          }),
        ),
    )

    server.registerTool(
      `${c.name}.link`,
      {
        title: `Link ${c.label}`,
        description: `Create a graph edge from this ${c.label} to another record`,
        inputSchema: {
          workspaceId: z.string(),
          srcId: z.string(),
          rel: z.string(),
          dstType: z.string(),
          dstId: z.string(),
        },
      },
      async (args: Record<string, unknown>) =>
        text(await (domain.graph as { link: (a: unknown) => Promise<unknown> }).link({ srcType: c.name, ...args })),
    )
  }

  server.registerTool(
    'inbox.list',
    {
      title: 'List inbox',
      description: 'List the current user inbox feed for a workspace',
      inputSchema: {
        workspaceId: z.string(),
        tab: z.enum(['all', 'mentions', 'saved', 'assigned']).optional(),
        first: z.number().optional(),
      },
    },
    async ({ workspaceId, tab, first }) => text(await domain.collab.inbox({ workspaceId, tab: tab ?? 'all', first })),
  )

  server.registerTool(
    'comment.add',
    {
      title: 'Add comment',
      description: 'Add a comment to an entity, optionally mentioning users',
      inputSchema: {
        entityType: z.string(),
        entityId: z.string(),
        body: z.string(),
        parentId: z.string().optional(),
        mentions: z.array(z.string()).optional(),
      },
    },
    async ({ entityType, entityId, body, parentId, mentions }) =>
      text(await domain.collab.comment.create({ entityType, entityId, body, parentId, mentions })),
  )

  server.registerTool(
    'reaction.toggle',
    {
      title: 'Toggle reaction',
      description: 'Add or remove a like/dislike on an entity',
      inputSchema: { entityType: z.string(), entityId: z.string(), kind: z.enum(['like', 'dislike']), on: z.boolean() },
    },
    async ({ entityType, entityId, kind, on }) => {
      if (on) await domain.collab.react({ entityType, entityId, kind })
      else await domain.collab.unreact({ entityType, entityId, kind })
      return text({ ok: true })
    },
  )

  server.registerTool(
    'save.toggle',
    {
      title: 'Toggle save',
      description: 'Save or unsave an entity for the current user',
      inputSchema: { entityType: z.string(), entityId: z.string(), on: z.boolean() },
    },
    async ({ entityType, entityId, on }) => {
      if (on) await domain.collab.save({ entityType, entityId })
      else await domain.collab.unsave({ entityType, entityId })
      return text({ ok: true })
    },
  )

  server.registerTool(
    'share.create',
    {
      title: 'Create share link',
      description: 'Mint a share link token for an entity (returned once)',
      inputSchema: { entityType: z.string(), entityId: z.string(), expiresInHours: z.number().optional() },
    },
    async ({ entityType, entityId, expiresInHours }) =>
      text(await domain.collab.createShareLink({ entityType, entityId, expiresInHours })),
  )

  server.registerTool(
    'task.create',
    {
      title: 'Create task',
      description: 'Create a task with workspace default status/priority when omitted',
      inputSchema: {
        workspaceId: z.string(),
        title: z.string(),
        description: z.string().optional(),
        statusId: z.string().optional(),
        priorityId: z.string().optional(),
        parentId: z.string().optional(),
        startDate: z.string().optional(),
        dueDate: z.string().optional(),
      },
    },
    async ({ workspaceId, title, description, statusId, priorityId, parentId, startDate, dueDate }) =>
      text(await domain.task.create({ workspaceId, title, description, statusId, priorityId, parentId, startDate, dueDate })),
  )

  server.registerTool(
    'task.get',
    { title: 'Get task', description: 'Fetch a task by id', inputSchema: { id: z.string() } },
    async ({ id }) => text(await domain.task.get(id)),
  )

  server.registerTool(
    'task.list',
    {
      title: 'List tasks',
      description: 'List tasks in a workspace',
      inputSchema: {
        workspaceId: z.string(),
        statusId: z.string().optional(),
        assigneeId: z.string().optional(),
        parentId: z.string().optional(),
        first: z.number().optional(),
      },
    },
    async ({ workspaceId, statusId, assigneeId, parentId, first }) =>
      text(await domain.task.list({ workspaceId, statusId, assigneeId, parentId, first })),
  )

  server.registerTool(
    'task.board',
    {
      title: 'Task board',
      description: 'Kanban columns with active statuses and their tasks',
      inputSchema: { workspaceId: z.string() },
    },
    async ({ workspaceId }) => text(await domain.task.board({ workspaceId })),
  )

  server.registerTool(
    'task.assign',
    {
      title: 'Assign task',
      description: 'Assign a user to a task idempotently',
      inputSchema: { taskId: z.string(), userId: z.string() },
    },
    async ({ taskId, userId }) => {
      await domain.task.assign({ taskId, userId })
      return text({ ok: true })
    },
  )

  server.registerTool(
    'task.transition',
    {
      title: 'Transition task',
      description: 'Move a task to a status',
      inputSchema: { taskId: z.string(), statusId: z.string() },
    },
    async ({ taskId, statusId }) => text(await domain.task.transition({ taskId, statusId })),
  )

  server.registerTool(
    'task.add_dependency',
    {
      title: 'Add task dependency',
      description: 'Mark a task as blocked by another task idempotently',
      inputSchema: { taskId: z.string(), blockerId: z.string() },
    },
    async ({ taskId, blockerId }) => {
      await domain.task.addDependency({ taskId, blockerId })
      return text({ ok: true })
    },
  )

  server.registerTool(
    'task.update_description',
    {
      title: 'Update task description',
      description: 'Replace a task description, deduping identical bodies',
      inputSchema: { taskId: z.string(), body: z.string() },
    },
    async ({ taskId, body }) => text(await domain.task.updateDescription(taskId, body)),
  )

  server.registerTool(
    'content.create_type',
    {
      title: 'Create content type',
      description: 'Define a content type with a JSON field schema',
      inputSchema: { workspaceId: z.string(), key: z.string(), label: z.string(), fieldSchema: z.string() },
    },
    async ({ workspaceId, key, label, fieldSchema }) =>
      text(await domain.content.createType({ workspaceId, key, label, fieldSchema: JSON.parse(fieldSchema) })),
  )

  server.registerTool(
    'content.create',
    {
      title: 'Create content',
      description: 'Create a content item with JSON data',
      inputSchema: { workspaceId: z.string(), contentTypeId: z.string(), slug: z.string(), data: z.string() },
    },
    async ({ workspaceId, contentTypeId, slug, data }) =>
      text(await domain.content.create({ workspaceId, contentTypeId, slug, data: JSON.parse(data) })),
  )

  server.registerTool(
    'content.update',
    {
      title: 'Update content',
      description: 'Update a content item with JSON data',
      inputSchema: { id: z.string(), data: z.string() },
    },
    async ({ id, data }) => text(await domain.content.update({ itemId: id, data: JSON.parse(data) })),
  )

  server.registerTool(
    'content.get',
    { title: 'Get content', description: 'Fetch a content item by id', inputSchema: { id: z.string() } },
    async ({ id }) => text(await domain.content.get(id)),
  )

  server.registerTool(
    'content.list',
    {
      title: 'List content',
      description: 'List content items',
      inputSchema: {
        workspaceId: z.string(),
        contentTypeId: z.string().optional(),
        status: z.string().optional(),
        first: z.number().optional(),
      },
    },
    async ({ workspaceId, contentTypeId, status, first }) =>
      text(await domain.content.list({ workspaceId, contentTypeId, status, first })),
  )

  server.registerTool(
    'content.submit_for_approval',
    {
      title: 'Submit content for approval',
      description: 'Submit a content item for approval',
      inputSchema: { itemId: z.string() },
    },
    async ({ itemId }) => text(await domain.content.submitForApproval({ itemId })),
  )

  server.registerTool(
    'content.decide_approval',
    {
      title: 'Decide content approval',
      description: 'Approve or reject a pending content approval',
      inputSchema: { approvalId: z.string(), vote: z.enum(['approve', 'reject']) },
    },
    async ({ approvalId, vote }) => text(await domain.content.decideApproval({ approvalId, vote })),
  )

  server.registerTool(
    'content.publish',
    { title: 'Publish content', description: 'Publish content', inputSchema: { itemId: z.string() } },
    async ({ itemId }) => text(await domain.content.publish({ itemId })),
  )

  server.registerTool(
    'content.unpublish',
    { title: 'Unpublish content', description: 'Unpublish content', inputSchema: { itemId: z.string() } },
    async ({ itemId }) => text(await domain.content.unpublish({ itemId })),
  )

  server.registerTool(
    'content.schedule',
    {
      title: 'Schedule content',
      description: 'Schedule a pinned content revision for publish or unpublish',
      inputSchema: {
        itemId: z.string(),
        action: z.enum(['publish', 'unpublish']),
        revisionId: z.string(),
        runAt: z.string(),
      },
    },
    async ({ itemId, action, revisionId, runAt }) =>
      text(await domain.content.schedule({ itemId, action, revisionId, runAt })),
  )

  server.registerTool(
    'content.run_seo_audit',
    { title: 'Run content SEO audit', description: 'Run advisory SEO audit', inputSchema: { itemId: z.string() } },
    async ({ itemId }) => text(await domain.content.runSeoAudit({ itemId })),
  )

  server.registerTool(
    'content.issue_asset_upload',
    {
      title: 'Issue content asset upload',
      description: 'Create a bounded presigned asset upload URL',
      inputSchema: { workspaceId: z.string(), filename: z.string(), mime: z.string(), sizeBytes: z.number() },
    },
    async ({ workspaceId, filename, mime, sizeBytes }) =>
      text(await domain.content.issueAssetUpload({ workspaceId, filename, mime, sizeBytes })),
  )

  server.registerTool(
    'content.list_approvals',
    {
      title: 'List content approvals',
      description: 'List content approvals',
      inputSchema: {
        workspaceId: z.string(),
        itemId: z.string().optional(),
        state: z.enum(['pending', 'approved', 'rejected', 'superseded']).optional(),
      },
    },
    async ({ workspaceId, itemId, state }) => text(await domain.content.listApprovals({ workspaceId, itemId, state })),
  )

  server.registerTool(
    'workflow.event_types',
    {
      title: 'List workflow event types',
      description: 'List the global workflow event catalog',
      inputSchema: { first: z.number().optional(), after: z.string().optional() },
    },
    async ({ first, after }) => text(await domain.workflows.listEventTypes({ first, after: after ?? null })),
  )

  server.registerTool(
    'workflow.rules.list',
    {
      title: 'List workflow rules',
      description: 'List workflow automation rules in a workspace',
      inputSchema: { workspaceId: z.string(), first: z.number().optional(), after: z.string().optional() },
    },
    async ({ workspaceId, first, after }) => text(await domain.workflows.listRules({ workspaceId, first, after: after ?? null })),
  )

  server.registerTool(
    'workflow.rules.upsert',
    {
      title: 'Upsert workflow rule',
      description: 'Create or update a workflow automation rule',
      inputSchema: {
        workspaceId: z.string(),
        id: z.string().optional(),
        triggerEventTypeId: z.string(),
        condition: z.string().optional(),
        actionType: z.string(),
        actionConfig: z.string(),
        enabled: z.boolean(),
        priority: z.number(),
      },
    },
    async ({ workspaceId, id, triggerEventTypeId, condition, actionType, actionConfig, enabled, priority }) =>
      text(await domain.workflows.upsertRule({
        workspaceId,
        id,
        triggerEventTypeId,
        condition: parseJson(condition, {}) as Record<string, unknown>,
        actionType: actionType as any,
        actionConfig: parseJson(actionConfig, {}) as Record<string, unknown>,
        enabled,
        priority,
      })),
  )

  server.registerTool(
    'workflow.runs.list',
    {
      title: 'List workflow runs',
      description: 'List workflow run audit rows in a workspace',
      inputSchema: { workspaceId: z.string(), first: z.number().optional(), after: z.string().optional() },
    },
    async ({ workspaceId, first, after }) => text(await domain.workflow_run.list({ workspaceId, first, after: after ?? null })),
  )

  server.registerTool(
    'workflow.webhook.register',
    {
      title: 'Register workflow webhook',
      description: 'Register a workflow webhook subscription and return its one-time secret',
      inputSchema: { workspaceId: z.string(), eventKey: z.string(), url: z.string(), filter: z.string().optional() },
    },
    async ({ workspaceId, eventKey, url, filter }) =>
      text(await domain.workflows.registerWebhook({ workspaceId, eventKey, url, filter: parseJson(filter, undefined) })),
  )

  server.registerTool(
    'workflow.webhook.rotate',
    {
      title: 'Rotate workflow webhook secret',
      description: 'Rotate a workflow webhook secret and return it once',
      inputSchema: { workspaceId: z.string(), subscriptionId: z.string() },
    },
    async ({ workspaceId, subscriptionId }) => text(await domain.workflows.rotateWebhook({ workspaceId, subscriptionId })),
  )

  server.registerTool(
    'workflow.webhook.active',
    {
      title: 'Set workflow webhook active',
      description: 'Activate or deactivate a workflow webhook subscription',
      inputSchema: { workspaceId: z.string(), subscriptionId: z.string(), active: z.boolean() },
    },
    async ({ workspaceId, subscriptionId, active }) =>
      text(await domain.workflows.setWebhookActive({ workspaceId, subscriptionId, active })),
  )

  server.registerTool(
    'workflow.jobs.replay_dead',
    {
      title: 'Replay dead workflow jobs',
      description: 'Replay dead-lettered automate jobs in a workspace',
      inputSchema: { workspaceId: z.string() },
    },
    async ({ workspaceId }) => {
      const { data, error } = await ctx.db.rpc('replay_workflow_jobs', { ws: workspaceId, only_dead: true })
      if (error) throw new Error(`replay_dead_workflow_jobs_failed:${error.code ?? 'unknown'}`)
      return text({ replayed: Number(data ?? 0) })
    },
  )

  return server
}
