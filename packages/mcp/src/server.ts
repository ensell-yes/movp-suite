import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { CollectionDef, FieldDef, MovpSchema } from '@movp/core-schema'
import { createDomain, type CollectionService, type Domain, type EmbeddingProvider } from '@movp/domain'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface McpCtx {
  db: SupabaseClient
  userId: string
  embedder?: EmbeddingProvider
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

export function buildMcpServer(schema: MovpSchema, ctx: McpCtx): McpServer {
  const server = new McpServer({ name: 'movp', version: '0.1.0' })
  const domain = createDomain({ db: ctx.db, userId: ctx.userId }, { embedder: ctx.embedder })

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

  return server
}
