import SchemaBuilder from '@pothos/core'
import ComplexityPlugin from '@pothos/plugin-complexity'
import DataloaderPlugin from '@pothos/plugin-dataloader'
import type { GraphQLSchema } from 'graphql'
import type { CollectionDef, FieldDef, MovpSchema } from '@movp/core-schema'
import {
  createDomain,
  resolveShareLink,
  type CollectionService,
  type Domain,
  type InboxItem,
  type Page,
  type SearchHit,
  type TaskBoardColumn,
  type TaskRow,
} from '@movp/domain'
import { COMPLEXITY_BUDGET, DEPTH_LIMIT, clampPageSize } from './limits.ts'
import { loadEdgeTargets } from './relations.ts'
import type { GraphQLContext, Row } from './types.ts'

function pascal(s: string): string {
  return s.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')
}

function plural(s: string): string {
  return `${s}s`
}

function service(domain: Domain, name: string): CollectionService<Row, Record<string, unknown>, Record<string, unknown>> {
  const svc = (domain as unknown as Record<
    string,
    CollectionService<Row, Record<string, unknown>, Record<string, unknown>>
  >)[name]
  if (!svc || typeof svc.create !== 'function') {
    throw new Error(`no domain service for collection: ${name}`)
  }
  return svc
}

function domainFrom(ctx: GraphQLContext): Domain {
  return createDomain({
    db: ctx.db,
    userId: ctx.userId,
    accessToken: ctx.accessToken,
    assetsFnUrl: ctx.assetsFnUrl,
  }, { embedder: ctx.embedder })
}

function workflowAuditEvent(event: Record<string, unknown>): Record<string, unknown> {
  const payload = event.payload
  const payloadKeys = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? Object.keys(payload as Record<string, unknown>).sort()
    : []
  return {
    id: event.id,
    type: event.type,
    workspace_id: event.workspace_id,
    payload_keys: payloadKeys,
    trace_id: event.trace_id,
    created_at: event.created_at,
  }
}

export function buildSchema(schema: MovpSchema): GraphQLSchema {
  const builder = new SchemaBuilder<{ Context: GraphQLContext }>({
    plugins: [DataloaderPlugin, ComplexityPlugin],
    complexity: { limit: { complexity: COMPLEXITY_BUDGET, depth: DEPTH_LIMIT, breadth: 500 } },
  })

  const refs = new Map<string, any>()
  for (const c of schema.collections) refs.set(c.name, builder.objectRef<Row>(pascal(c.name)))

  const searchHit = builder.objectRef<SearchHit>('SearchHit').implement({
    fields: (t) => ({
      collection: t.exposeString('collection'),
      id: t.exposeID('id'),
      title: t.exposeString('title'),
      snippet: t.exposeString('snippet'),
      score: t.exposeFloat('score'),
    }),
  })

  const inboxItem = builder.objectRef<InboxItem>('InboxItem').implement({
    fields: (t) => ({
      kind: t.exposeString('kind'),
      entity_type: t.exposeString('entity_type'),
      entity_id: t.exposeID('entity_id'),
      ref_id: t.exposeID('ref_id'),
      created_at: t.exposeString('created_at'),
      payload: t.string({ resolve: (i) => JSON.stringify(i.payload) }),
    }),
  })
  const shareLinkToken = builder.objectRef<{ token: string }>('ShareLinkToken').implement({
    fields: (t) => ({ token: t.exposeString('token') }),
  })
  const webhookSecretRef = builder.objectRef<{ subscriptionId: string; secret: string }>('WebhookSecret').implement({
    fields: (t) => ({
      subscriptionId: t.exposeID('subscriptionId'),
      secret: t.exposeString('secret'),
    }),
  })
  const workflowReplayRef = builder.objectRef<{ replayed: number }>('WorkflowReplayResult').implement({
    fields: (t) => ({ replayed: t.exposeInt('replayed') }),
  })
  const resolvedShareLink = builder
    .objectRef<{ entity_type: string; entity_id: string; workspace_id: string }>('ResolvedShareLink')
    .implement({
      fields: (t) => ({
        entity_type: t.exposeString('entity_type'),
        entity_id: t.exposeID('entity_id'),
        workspace_id: t.exposeID('workspace_id'),
      }),
    })

  const pages = new Map<string, any>()
  const inputs = new Map<string, any>()

  for (const c of schema.collections as CollectionDef[]) {
    if (c.internal) continue
    const ref = refs.get(c.name)
    ref.implement({
      fields: (t: any) => {
        const fields: Record<string, any> = {
          id: t.exposeID('id', { complexity: 0 }),
          workspace_id: t.exposeString('workspace_id', { complexity: 0 }),
          created_at: t.exposeString('created_at', { complexity: 0 }),
          updated_at: t.exposeString('updated_at', { complexity: 0 }),
        }
        for (const [name, def] of Object.entries(c.fields) as [string, FieldDef][]) {
          if (def.type === 'relation') {
            if (!def.target) throw new Error(`relation field ${c.name}.${name} is missing target`)
            const target = refs.get(def.target)
            fields[name] = t.loadable({
              type: [target],
              nullable: false,
              complexity: 10,
              resolve: (row: Row) => row.id,
              load: (ids: string[], lctx: GraphQLContext) =>
                loadEdgeTargets(lctx.db, {
                  srcType: c.name,
                  rel: name,
                  dstType: def.target!,
                  srcIds: ids,
                }),
            })
          } else {
            fields[name] = t.string({
              nullable: true,
              complexity: 0,
              resolve: (row: Row) => {
                const v = row[name]
                return v == null ? null : String(v)
              },
            })
          }
        }
        return fields
      },
    })

    pages.set(
      c.name,
      builder.objectRef<{ items: Row[]; nextCursor: string | null }>(`${pascal(c.name)}Page`).implement({
        fields: (t: any) => ({
          items: t.field({ type: [ref], complexity: 0, resolve: (p: any) => p.items }),
          nextCursor: t.string({ nullable: true, complexity: 0, resolve: (p: any) => p.nextCursor }),
        }),
      }),
    )

    inputs.set(
      c.name,
      builder.inputRef<Record<string, unknown>>(`${pascal(c.name)}CreateInput`).implement({
        fields: (t: any) => {
          const f: Record<string, any> = { workspace_id: t.id({ required: true }) }
          for (const [name, def] of Object.entries(c.fields) as [string, FieldDef][]) {
            if (def.type === 'relation') continue
            f[name] = t.string({ required: !!def.required })
          }
          return f
        },
      }),
    )
  }

  builder.queryType({})
  builder.mutationType({})

  const parseJsonArg = (raw: string | null | undefined, fallback: unknown): unknown => {
    if (raw == null || raw.length === 0) return fallback
    try {
      return JSON.parse(raw)
    } catch {
      throw new Error('invalid_json')
    }
  }

  if (refs.has('event_type') && refs.has('automation_rule') && refs.has('webhook_subscription')) {
    const workflowEventTypeRef = refs.get('event_type')
    const workflowAutomationRuleRef = refs.get('automation_rule')
    const workflowEventTypesPage = builder.objectRef<Page<Row>>('WorkflowEventTypePage').implement({
      fields: (t: any) => ({
        items: t.field({ type: [workflowEventTypeRef], resolve: (p: Page<Row>) => p.items }),
        nextCursor: t.string({ nullable: true, resolve: (p: Page<Row>) => p.nextCursor ?? null }),
      }),
    })
    const workflowAutomationRulesPage = builder.objectRef<Page<Row>>('WorkflowAutomationRulePage').implement({
      fields: (t: any) => ({
        items: t.field({ type: [workflowAutomationRuleRef], resolve: (p: Page<Row>) => p.items }),
        nextCursor: t.string({ nullable: true, resolve: (p: Page<Row>) => p.nextCursor ?? null }),
      }),
    })

    builder.queryField('eventTypes', (t: any) =>
      t.field({
        type: workflowEventTypesPage,
        complexity: (args: any) => ({ field: 1, multiplier: clampPageSize(args.first) }),
        args: {
          first: t.arg.int({ required: false }),
          after: t.arg.string({ required: false }),
        },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          domainFrom(ctx).workflows.listEventTypes({
            first: clampPageSize(args.first),
            after: args.after ?? null,
          }),
      }),
    )

    builder.queryField('automationRules', (t: any) =>
      t.field({
        type: workflowAutomationRulesPage,
        complexity: (args: any) => ({ field: 1, multiplier: clampPageSize(args.first) }),
        args: {
          workspaceId: t.arg.id({ required: true }),
          first: t.arg.int({ required: false }),
          after: t.arg.string({ required: false }),
        },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          domainFrom(ctx).workflows.listRules({
            workspaceId: String(args.workspaceId),
            first: clampPageSize(args.first),
            after: args.after ?? null,
          }),
      }),
    )

    builder.queryField('workflowEvent', (t: any) =>
      t.field({
        type: 'String',
        nullable: true,
        complexity: 5,
        args: { workspaceId: t.arg.id({ required: true }), eventId: t.arg.id({ required: true }) },
        resolve: async (_r: unknown, args: any, ctx: GraphQLContext) => {
          const event = await domainFrom(ctx).workflows.getEvent({
            workspaceId: String(args.workspaceId),
            eventId: String(args.eventId),
          })
          return event == null ? null : JSON.stringify(workflowAuditEvent(event))
        },
      }),
    )

    builder.mutationField('upsertAutomationRule', (t: any) =>
      t.field({
        type: workflowAutomationRuleRef,
        complexity: 10,
        args: {
          workspaceId: t.arg.id({ required: true }),
          id: t.arg.id({ required: false }),
          triggerEventTypeId: t.arg.id({ required: true }),
          condition: t.arg.string({ required: false }),
          actionType: t.arg.string({ required: true }),
          actionConfig: t.arg.string({ required: true }),
          enabled: t.arg.boolean({ required: true }),
          priority: t.arg.int({ required: true }),
        },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          domainFrom(ctx).workflows.upsertRule({
            workspaceId: String(args.workspaceId),
            id: args.id ? String(args.id) : undefined,
            triggerEventTypeId: String(args.triggerEventTypeId),
            condition: parseJsonArg(args.condition, {}) as Record<string, unknown>,
            actionType: String(args.actionType) as any,
            actionConfig: parseJsonArg(args.actionConfig, {}) as Record<string, unknown>,
            enabled: Boolean(args.enabled),
            priority: Number(args.priority),
          }),
      }),
    )

    builder.mutationField('registerWebhookSubscription', (t: any) =>
      t.field({
        type: webhookSecretRef,
        complexity: 10,
        args: {
          workspaceId: t.arg.id({ required: true }),
          eventKey: t.arg.string({ required: true }),
          url: t.arg.string({ required: true }),
          filter: t.arg.string({ required: false }),
        },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          domainFrom(ctx).workflows.registerWebhook({
            workspaceId: String(args.workspaceId),
            eventKey: String(args.eventKey),
            url: String(args.url),
            filter: parseJsonArg(args.filter, undefined),
          }),
      }),
    )

    builder.mutationField('rotateWebhookSecret', (t: any) =>
      t.field({
        type: webhookSecretRef,
        complexity: 10,
        args: { workspaceId: t.arg.id({ required: true }), subscriptionId: t.arg.id({ required: true }) },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          domainFrom(ctx).workflows.rotateWebhook({
            workspaceId: String(args.workspaceId),
            subscriptionId: String(args.subscriptionId),
          }),
      }),
    )

    builder.mutationField('setWebhookActive', (t: any) =>
      t.field({
        type: refs.get('webhook_subscription'),
        complexity: 5,
        args: {
          workspaceId: t.arg.id({ required: true }),
          subscriptionId: t.arg.id({ required: true }),
          active: t.arg.boolean({ required: true }),
        },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          domainFrom(ctx).workflows.setWebhookActive({
            workspaceId: String(args.workspaceId),
            subscriptionId: String(args.subscriptionId),
            active: Boolean(args.active),
          }),
      }),
    )

    builder.mutationField('setWebhookFilter', (t: any) =>
      t.field({
        type: refs.get('webhook_subscription'),
        complexity: 5,
        args: {
          workspaceId: t.arg.id({ required: true }),
          subscriptionId: t.arg.id({ required: true }),
          filter: t.arg.string({ required: true }),
        },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          domainFrom(ctx).workflows.setWebhookFilter({
            workspaceId: String(args.workspaceId),
            subscriptionId: String(args.subscriptionId),
            filter: parseJsonArg(args.filter, {}),
          }),
      }),
    )

    builder.mutationField('replayDeadWorkflowJobs', (t: any) =>
      t.field({
        type: workflowReplayRef,
        complexity: 5,
        args: { workspaceId: t.arg.id({ required: true }) },
        resolve: async (_r: unknown, args: any, ctx: GraphQLContext) => {
          const { data, error } = await ctx.db.rpc('replay_workflow_jobs', {
            ws: String(args.workspaceId),
            only_dead: true,
          })
          if (error) throw new Error(`replay_dead_workflow_jobs_failed:${error.code ?? 'unknown'}`)
          return { replayed: Number(data ?? 0) }
        },
      }),
    )
  }

  for (const c of schema.collections as CollectionDef[]) {
    if (c.internal) continue
    const ref = refs.get(c.name)
    const page = pages.get(c.name)
    const input = inputs.get(c.name)

    builder.queryField(c.name, (t: any) =>
      t.field({
        type: ref,
        nullable: true,
        complexity: 1,
        args: { id: t.arg.id({ required: true }) },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) => service(domainFrom(ctx), c.name).get(String(args.id)),
      }),
    )

    builder.queryField(plural(c.name), (t: any) =>
      t.field({
        type: page,
        complexity: (args: any) => ({ field: 1, multiplier: clampPageSize(args.first) }),
        args: {
          workspaceId: t.arg.id({ required: true }),
          first: t.arg.int({ required: false }),
          after: t.arg.string({ required: false }),
        },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          service(domainFrom(ctx), c.name).list({
            workspaceId: String(args.workspaceId),
            first: clampPageSize(args.first),
            after: args.after ?? null,
          }),
      }),
    )

    builder.mutationField(`create${pascal(c.name)}`, (t: any) =>
      t.field({
        type: ref,
        complexity: 10,
        args: { input: t.arg({ type: input, required: true }) },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) => service(domainFrom(ctx), c.name).create(args.input),
      }),
    )
  }

  builder.queryField('search', (t: any) =>
    t.field({
      type: [searchHit],
      complexity: (args: any) => ({ field: 1, multiplier: clampPageSize(args.limit) }),
      args: {
        workspaceId: t.arg.id({ required: true }),
        query: t.arg.string({ required: true }),
        mode: t.arg.string({ required: false }),
        collection: t.arg.string({ required: false }),
        limit: t.arg.int({ required: false }),
      },
      resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
        domainFrom(ctx).search({
          workspaceId: String(args.workspaceId),
          query: args.query,
          mode: args.mode ?? (ctx.embedder ? 'hybrid' : undefined),
          collection: args.collection ?? undefined,
          limit: clampPageSize(args.limit),
        }),
    }),
  )

  if (refs.has('comment')) {
    const commentRef = refs.get('comment')
    commentRef.implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        workspace_id: t.exposeString('workspace_id', { complexity: 0 }),
        entity_type: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.entity_type == null ? null : String(r.entity_type)) }),
        entity_id: t.exposeID('entity_id', { complexity: 0 }),
        body: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.body == null ? null : String(r.body)) }),
        author_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.author_id == null ? null : String(r.author_id)) }),
        parent_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.parent_id == null ? null : String(r.parent_id)) }),
        created_at: t.exposeString('created_at', { complexity: 0 }),
        updated_at: t.exposeString('updated_at', { complexity: 0 }),
      }),
    })

    builder.queryField('inbox', (t: any) =>
      t.field({
        type: [inboxItem],
        complexity: (args: any) => ({ field: 1, multiplier: clampPageSize(args.first) }),
        args: {
          workspaceId: t.arg.id({ required: true }),
          tab: t.arg.string({ required: false }),
          first: t.arg.int({ required: false }),
        },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          domainFrom(ctx).collab.inbox({
            workspaceId: String(args.workspaceId),
            tab: (args.tab ?? 'all') as 'all' | 'mentions' | 'saved' | 'assigned',
            first: clampPageSize(args.first),
          }),
      }),
    )

    builder.mutationField('addComment', (t: any) =>
      t.field({
        type: commentRef,
        complexity: 10,
        args: {
          entityType: t.arg.string({ required: true }),
          entityId: t.arg.id({ required: true }),
          body: t.arg.string({ required: true }),
          parentId: t.arg.id({ required: false }),
          mentions: t.arg.stringList({ required: false }),
        },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          domainFrom(ctx).collab.comment.create({
            entityType: String(args.entityType),
            entityId: String(args.entityId),
            body: String(args.body),
            parentId: args.parentId ?? undefined,
            mentions: args.mentions ?? undefined,
          }),
      }),
    )

    builder.mutationField('toggleReaction', (t: any) =>
      t.field({
        type: 'Boolean',
        complexity: 5,
        args: {
          entityType: t.arg.string({ required: true }),
          entityId: t.arg.id({ required: true }),
          kind: t.arg.string({ required: true }),
          on: t.arg.boolean({ required: true }),
        },
        resolve: async (_r: unknown, args: any, ctx: GraphQLContext) => {
          const collab = domainFrom(ctx).collab
          const i = { entityType: String(args.entityType), entityId: String(args.entityId), kind: String(args.kind) as 'like' | 'dislike' }
          if (args.on) await collab.react(i)
          else await collab.unreact(i)
          return true
        },
      }),
    )

    builder.mutationField('toggleSave', (t: any) =>
      t.field({
        type: 'Boolean',
        complexity: 5,
        args: {
          entityType: t.arg.string({ required: true }),
          entityId: t.arg.id({ required: true }),
          on: t.arg.boolean({ required: true }),
        },
        resolve: async (_r: unknown, args: any, ctx: GraphQLContext) => {
          const collab = domainFrom(ctx).collab
          const i = { entityType: String(args.entityType), entityId: String(args.entityId) }
          if (args.on) await collab.save(i)
          else await collab.unsave(i)
          return true
        },
      }),
    )

    builder.mutationField('createShareLink', (t: any) =>
      t.field({
        type: shareLinkToken,
        complexity: 5,
        args: {
          entityType: t.arg.string({ required: true }),
          entityId: t.arg.id({ required: true }),
          expiresInHours: t.arg.int({ required: false }),
        },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          domainFrom(ctx).collab.createShareLink({
            entityType: String(args.entityType),
            entityId: String(args.entityId),
            expiresInHours: args.expiresInHours ?? undefined,
          }),
      }),
    )

    builder.mutationField('resolveShareLink', (t: any) =>
      t.field({
        type: resolvedShareLink,
        nullable: true,
        complexity: 1,
        args: { token: t.arg.string({ required: true }) },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          resolveShareLink({ db: ctx.db, userId: ctx.userId }, String(args.token)),
      }),
    )
  }

  if (refs.has('task')) {
    const taskRef = refs.get('task')
    const statusRef = refs.get('task_status_option')

    taskRef.implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        workspace_id: t.exposeString('workspace_id', { complexity: 0 }),
        title: t.exposeString('title', { complexity: 0 }),
        status_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.status_id == null ? null : String(r.status_id)) }),
        priority_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.priority_id == null ? null : String(r.priority_id)) }),
        parent_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.parent_id == null ? null : String(r.parent_id)) }),
        current_revision_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.current_revision_id == null ? null : String(r.current_revision_id)) }),
        start_date: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.start_date == null ? null : String(r.start_date)) }),
        due_date: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.due_date == null ? null : String(r.due_date)) }),
        completed_at: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.completed_at == null ? null : String(r.completed_at)) }),
        dependency_blocked: t.boolean({ complexity: 0, resolve: (r: Row) => Boolean(r.dependency_blocked) }),
        created_at: t.exposeString('created_at', { complexity: 0 }),
        updated_at: t.exposeString('updated_at', { complexity: 0 }),
        description: t.field({
          type: 'String',
          nullable: true,
          complexity: 5,
          resolve: async (r: Row, _a: unknown, ctx: GraphQLContext) => {
            if (r.current_revision_id == null) return null
            const { data } = await ctx.db.from('task_revision').select('body').eq('id', String(r.current_revision_id)).maybeSingle()
            return (data as { body?: string } | null)?.body ?? null
          },
        }),
      }),
    })

    const taskPage = builder.objectRef<Page<TaskRow>>('TaskPage').implement({
      fields: (t: any) => ({
        items: t.field({ type: [taskRef], resolve: (p: Page<TaskRow>) => p.items }),
        nextCursor: t.string({ nullable: true, resolve: (p: Page<TaskRow>) => p.nextCursor ?? null }),
      }),
    })
    const taskBoardColumn = builder.objectRef<TaskBoardColumn>('TaskBoardColumn').implement({
      fields: (t: any) => ({
        status: t.field({ type: statusRef, resolve: (c: TaskBoardColumn) => c.status }),
        tasks: t.field({ type: [taskRef], resolve: (c: TaskBoardColumn) => c.tasks }),
      }),
    })

    builder.queryField('task', (t: any) =>
      t.field({
        type: taskRef,
        nullable: true,
        complexity: 1,
        args: { id: t.arg.id({ required: true }) },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) => domainFrom(ctx).task.get(String(args.id)),
      }),
    )

    builder.queryField('tasks', (t: any) =>
      t.field({
        type: taskPage,
        complexity: (args: any) => ({ field: 1, multiplier: clampPageSize(args.first) }),
        args: {
          workspaceId: t.arg.id({ required: true }),
          statusId: t.arg.id({ required: false }),
          assigneeId: t.arg.id({ required: false }),
          parentId: t.arg.id({ required: false }),
          topLevel: t.arg.boolean({ required: false }),
          first: t.arg.int({ required: false }),
          after: t.arg.string({ required: false }),
        },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          domainFrom(ctx).task.list({
            workspaceId: String(args.workspaceId),
            statusId: args.statusId ? String(args.statusId) : undefined,
            assigneeId: args.assigneeId ? String(args.assigneeId) : undefined,
            parentId: args.topLevel ? null : (args.parentId ? String(args.parentId) : undefined),
            first: clampPageSize(args.first),
            after: args.after ?? undefined,
          }),
      }),
    )

    builder.queryField('taskBoard', (t: any) =>
      t.field({
        type: [taskBoardColumn],
        complexity: 10,
        args: { workspaceId: t.arg.id({ required: true }) },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          domainFrom(ctx).task.board({ workspaceId: String(args.workspaceId) }),
      }),
    )

    builder.mutationField('createTask', (t: any) =>
      t.field({
        type: taskRef,
        complexity: 10,
        args: {
          workspaceId: t.arg.id({ required: true }),
          title: t.arg.string({ required: true }),
          description: t.arg.string({ required: false }),
          statusId: t.arg.id({ required: false }),
          priorityId: t.arg.id({ required: false }),
          parentId: t.arg.id({ required: false }),
          startDate: t.arg.string({ required: false }),
          dueDate: t.arg.string({ required: false }),
        },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          domainFrom(ctx).task.create({
            workspaceId: String(args.workspaceId),
            title: String(args.title),
            description: args.description ?? undefined,
            statusId: args.statusId ? String(args.statusId) : undefined,
            priorityId: args.priorityId ? String(args.priorityId) : undefined,
            parentId: args.parentId ? String(args.parentId) : undefined,
            startDate: args.startDate ?? undefined,
            dueDate: args.dueDate ?? undefined,
          }),
      }),
    )

    builder.mutationField('transitionTask', (t: any) =>
      t.field({
        type: taskRef,
        complexity: 5,
        args: { taskId: t.arg.id({ required: true }), statusId: t.arg.id({ required: true }) },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          domainFrom(ctx).task.transition({ taskId: String(args.taskId), statusId: String(args.statusId) }),
      }),
    )

    builder.mutationField('updateTaskDescription', (t: any) =>
      t.field({
        type: taskRef,
        complexity: 10,
        args: { taskId: t.arg.id({ required: true }), body: t.arg.string({ required: true }) },
        resolve: (_r: unknown, args: any, ctx: GraphQLContext) =>
          domainFrom(ctx).task.updateDescription(String(args.taskId), String(args.body)),
      }),
    )

    builder.mutationField('assignTask', (t: any) =>
      t.field({
        type: 'Boolean',
        complexity: 5,
        args: { taskId: t.arg.id({ required: true }), userId: t.arg.id({ required: true }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext) => {
          await domainFrom(ctx).task.assign({ taskId: String(a.taskId), userId: String(a.userId) })
          return true
        },
      }),
    )
    builder.mutationField('unassignTask', (t: any) =>
      t.field({
        type: 'Boolean',
        complexity: 5,
        args: { taskId: t.arg.id({ required: true }), userId: t.arg.id({ required: true }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext) => {
          await domainFrom(ctx).task.unassign({ taskId: String(a.taskId), userId: String(a.userId) })
          return true
        },
      }),
    )
    builder.mutationField('addTaskObserver', (t: any) =>
      t.field({
        type: 'Boolean',
        complexity: 5,
        args: { taskId: t.arg.id({ required: true }), userId: t.arg.id({ required: true }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext) => {
          await domainFrom(ctx).task.addObserver({ taskId: String(a.taskId), userId: String(a.userId) })
          return true
        },
      }),
    )
    builder.mutationField('addTaskDependency', (t: any) =>
      t.field({
        type: 'Boolean',
        complexity: 5,
        args: { taskId: t.arg.id({ required: true }), blockerId: t.arg.id({ required: true }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext) => {
          await domainFrom(ctx).task.addDependency({ taskId: String(a.taskId), blockerId: String(a.blockerId) })
          return true
        },
      }),
    )
    builder.mutationField('attachTask', (t: any) =>
      t.field({
        type: 'Boolean',
        complexity: 5,
        args: {
          taskId: t.arg.id({ required: true }),
          r2Key: t.arg.string({ required: true }),
          filename: t.arg.string({ required: true }),
          contentType: t.arg.string({ required: false }),
          bytes: t.arg.int({ required: false }),
        },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext) => {
          await domainFrom(ctx).task.attach({
            taskId: String(a.taskId),
            r2Key: String(a.r2Key),
            filename: String(a.filename),
            contentType: a.contentType ?? undefined,
            bytes: a.bytes ?? undefined,
          })
          return true
        },
      }),
    )

    builder.queryField('comments', (t: any) =>
      t.field({
        type: [refs.get('comment')],
        complexity: 10,
        nullable: false,
        args: {
          workspaceId: t.arg.id({ required: true }),
          entityType: t.arg.string({ required: true }),
          entityId: t.arg.id({ required: true }),
          first: t.arg.int({ required: false }),
          after: t.arg.string({ required: false }),
        },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext) => {
          const page = await domainFrom(ctx).collab.comment.listByEntity({
            workspaceId: String(a.workspaceId),
            entityType: String(a.entityType),
            entityId: String(a.entityId),
            first: a.first ?? undefined,
            after: a.after ?? null,
          })
          return page.items
        },
      }),
    )
  }

  if (refs.has('content_item')) {
    const contentTypeRef = refs.get('content_type')
    const contentItemRef = refs.get('content_item')
    const contentRevisionRef = refs.get('content_revision')
    const contentApprovalRef = refs.get('content_approval')
    const contentScheduleRef = refs.get('content_schedule')
    const contentCollectionRef = refs.get('content_collection')

    contentTypeRef.implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        workspace_id: t.exposeString('workspace_id', { complexity: 0 }),
        key: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.key == null ? null : String(r.key)) }),
        label: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.label == null ? null : String(r.label)) }),
        field_schema: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.field_schema == null ? null : JSON.stringify(r.field_schema)) }),
        created_at: t.exposeString('created_at', { complexity: 0 }),
        updated_at: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.updated_at == null ? null : String(r.updated_at)) }),
      }),
    })

    contentItemRef.implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        workspace_id: t.exposeString('workspace_id', { complexity: 0 }),
        content_type_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.content_type_id == null ? null : String(r.content_type_id)) }),
        slug: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.slug == null ? null : String(r.slug)) }),
        status: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.status == null ? null : String(r.status)) }),
        search_text: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.search_text == null ? null : String(r.search_text)) }),
        data: t.string({
          nullable: true,
          complexity: 5,
          resolve: async (r: Row, _a: unknown, ctx: GraphQLContext) => {
            if (r.data != null) return JSON.stringify(r.data)
            if (r.current_revision_id == null) return null
            const { data } = await ctx.db.from('content_revision').select('data').eq('id', String(r.current_revision_id)).maybeSingle()
            const body = (data as { data?: unknown } | null)?.data
            return body == null ? null : JSON.stringify(body)
          },
        }),
        current_revision_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.current_revision_id == null ? null : String(r.current_revision_id)) }),
        approved_revision_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.approved_revision_id == null ? null : String(r.approved_revision_id)) }),
        published_revision_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.published_revision_id == null ? null : String(r.published_revision_id)) }),
        created_at: t.exposeString('created_at', { complexity: 0 }),
        updated_at: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.updated_at == null ? null : String(r.updated_at)) }),
        content_type: t.field({
          type: contentTypeRef,
          nullable: true,
          complexity: 5,
          resolve: async (r: Row, _a: unknown, ctx: GraphQLContext) => {
            if (r.content_type_id == null) return null
            const { data } = await ctx.db.from('content_type').select('*').eq('id', String(r.content_type_id)).maybeSingle()
            return (data as Row | null) ?? null
          },
        }),
      }),
    })

    contentRevisionRef.implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        workspace_id: t.exposeString('workspace_id', { complexity: 0 }),
        content_item_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.content_item_id == null ? null : String(r.content_item_id)) }),
        parent_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.parent_id == null ? null : String(r.parent_id)) }),
        revision_number: t.int({ nullable: true, complexity: 0, resolve: (r: Row) => (r.revision_number == null ? null : Number(r.revision_number)) }),
        data: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.data == null ? null : JSON.stringify(r.data)) }),
        content_hash: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.content_hash == null ? null : String(r.content_hash)) }),
        author_id: t.string({ nullable: true, complexity: 0, resolve: (r: Row) => (r.author_id == null ? null : String(r.author_id)) }),
        created_at: t.exposeString('created_at', { complexity: 0 }),
      }),
    })

    contentApprovalRef.implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        content_item_id: t.string({ nullable: true, resolve: (r: Row) => (r.content_item_id == null ? null : String(r.content_item_id)) }),
        state: t.string({ nullable: true, resolve: (r: Row) => (r.state == null ? null : String(r.state)) }),
        approved_revision_id: t.string({ nullable: true, resolve: (r: Row) => (r.approved_revision_id == null ? null : String(r.approved_revision_id)) }),
      }),
    })

    contentScheduleRef.implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        content_item_id: t.string({ nullable: true, resolve: (r: Row) => (r.content_item_id == null ? null : String(r.content_item_id)) }),
        action: t.string({ nullable: true, resolve: (r: Row) => (r.action == null ? null : String(r.action)) }),
        revision_id: t.string({ nullable: true, resolve: (r: Row) => (r.revision_id == null ? null : String(r.revision_id)) }),
        run_at: t.string({ nullable: true, resolve: (r: Row) => (r.run_at == null ? null : String(r.run_at)) }),
        state: t.string({ nullable: true, resolve: (r: Row) => (r.state == null ? null : String(r.state)) }),
      }),
    })

    contentCollectionRef.implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        workspace_id: t.string({ nullable: true, resolve: (r: Row) => (r.workspace_id == null ? null : String(r.workspace_id)) }),
        key: t.string({ nullable: true, resolve: (r: Row) => (r.key == null ? null : String(r.key)) }),
        label: t.string({ nullable: true, resolve: (r: Row) => (r.label == null ? null : String(r.label)) }),
        description: t.string({ nullable: true, resolve: (r: Row) => (r.description == null ? null : String(r.description)) }),
        created_at: t.string({ nullable: true, resolve: (r: Row) => (r.created_at == null ? null : String(r.created_at)) }),
      }),
    })

    const contentPage = builder.objectRef<Page<Row>>('ContentPage').implement({
      fields: (t: any) => ({
        items: t.field({ type: [contentItemRef], resolve: (p: Page<Row>) => p.items }),
        nextCursor: t.string({ nullable: true, resolve: (p: Page<Row>) => p.nextCursor ?? null }),
      }),
    })
    const publishedContent = builder.objectRef<{ item: Row; revision: Row }>('PublishedContent').implement({
      fields: (t: any) => ({
        item: t.field({ type: contentItemRef, resolve: (p: { item: Row }) => p.item }),
        revision: t.field({ type: contentRevisionRef, resolve: (p: { revision: Row }) => p.revision }),
      }),
    })
    const seoAudit = builder.objectRef<Row>('ContentSeoAudit').implement({
      fields: (t: any) => ({
        score: t.float({ nullable: true, resolve: (r: Row) => (r.score == null ? null : Number(r.score)) }),
        checklist: t.string({ nullable: true, resolve: (r: Row) => (r.checklist == null ? null : JSON.stringify(r.checklist)) }),
      }),
    })
    const assetUpload = builder.objectRef<{ uploadUrl: string; assetId: string; r2Key: string }>('ContentAssetUpload').implement({
      fields: (t: any) => ({
        uploadUrl: t.exposeString('uploadUrl'),
        assetId: t.exposeID('assetId'),
        r2Key: t.exposeString('r2Key'),
      }),
    })
    const contentAsset = builder.objectRef<Row>('ContentAsset').implement({
      fields: (t: any) => ({
        id: t.exposeID('id'),
        workspace_id: t.string({ nullable: true, resolve: (r: Row) => (r.workspace_id == null ? null : String(r.workspace_id)) }),
        r2_key: t.string({ nullable: true, resolve: (r: Row) => (r.r2_key == null ? null : String(r.r2_key)) }),
        filename: t.string({ nullable: true, resolve: (r: Row) => (r.filename == null ? null : String(r.filename)) }),
        mime: t.string({ nullable: true, resolve: (r: Row) => (r.mime == null ? null : String(r.mime)) }),
        size_bytes: t.int({ nullable: true, resolve: (r: Row) => (r.size_bytes == null ? null : Number(r.size_bytes)) }),
        created_at: t.string({ nullable: true, resolve: (r: Row) => (r.created_at == null ? null : String(r.created_at)) }),
      }),
    })

    builder.queryField('contentTypes', (t: any) =>
      t.field({
        type: [contentTypeRef],
        complexity: 5,
        args: { workspaceId: t.arg.id({ required: true }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext) =>
          (await domainFrom(ctx).content.listTypes({ workspaceId: String(a.workspaceId) })).items,
      }),
    )
    builder.queryField('content', (t: any) =>
      t.field({
        type: contentPage,
        complexity: (a: any) => ({ field: 1, multiplier: clampPageSize(a.first) }),
        args: {
          workspaceId: t.arg.id({ required: true }),
          contentTypeId: t.arg.id({ required: false }),
          status: t.arg.string({ required: false }),
          first: t.arg.int({ required: false }),
          after: t.arg.string({ required: false }),
        },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) =>
          domainFrom(ctx).content.list({
            workspaceId: String(a.workspaceId),
            contentTypeId: a.contentTypeId ? String(a.contentTypeId) : undefined,
            status: a.status ? String(a.status) : undefined,
            first: clampPageSize(a.first),
            after: a.after ?? undefined,
          }),
      }),
    )
    builder.queryField('contentItem', (t: any) =>
      t.field({
        type: contentItemRef,
        nullable: true,
        complexity: 1,
        args: { id: t.arg.id({ required: true }) },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) => domainFrom(ctx).content.get(String(a.id)),
      }),
    )
    builder.queryField('contentRevisions', (t: any) =>
      t.field({
        type: [contentRevisionRef],
        complexity: 10,
        args: { itemId: t.arg.id({ required: true }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext) =>
          (await domainFrom(ctx).content.listRevisions({ itemId: String(a.itemId) })).items,
      }),
    )
    builder.queryField('publishedContent', (t: any) =>
      t.field({
        type: publishedContent,
        nullable: true,
        complexity: 1,
        args: { id: t.arg.id({ required: true }) },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) => domainFrom(ctx).content.getPublished(String(a.id)),
      }),
    )
    builder.queryField('contentApprovals', (t: any) =>
      t.field({
        type: [contentApprovalRef],
        complexity: 5,
        args: {
          workspaceId: t.arg.id({ required: true }),
          itemId: t.arg.id({ required: false }),
          state: t.arg.string({ required: false }),
        },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext) =>
          (await domainFrom(ctx).content.listApprovals({
            workspaceId: String(a.workspaceId),
            itemId: a.itemId ? String(a.itemId) : undefined,
            state: a.state ? String(a.state) as 'pending' | 'approved' | 'rejected' | 'superseded' : undefined,
          })).items,
      }),
    )

    builder.mutationField('createContentType', (t: any) =>
      t.field({
        type: contentTypeRef,
        complexity: 10,
        args: {
          workspaceId: t.arg.id({ required: true }),
          key: t.arg.string({ required: true }),
          label: t.arg.string({ required: true }),
          fieldSchema: t.arg.string({ required: true }),
        },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) =>
          domainFrom(ctx).content.createType({
            workspaceId: String(a.workspaceId),
            key: String(a.key),
            label: String(a.label),
            fieldSchema: JSON.parse(String(a.fieldSchema)),
          }),
      }),
    )
    builder.mutationField('createContent', (t: any) =>
      t.field({
        type: contentItemRef,
        complexity: 10,
        args: {
          workspaceId: t.arg.id({ required: true }),
          contentTypeId: t.arg.id({ required: true }),
          slug: t.arg.string({ required: true }),
          data: t.arg.string({ required: true }),
        },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) =>
          domainFrom(ctx).content.create({
            workspaceId: String(a.workspaceId),
            contentTypeId: String(a.contentTypeId),
            slug: String(a.slug),
            data: JSON.parse(String(a.data)),
          }),
      }),
    )
    builder.mutationField('updateContent', (t: any) =>
      t.field({
        type: contentItemRef,
        complexity: 10,
        args: { id: t.arg.id({ required: true }), data: t.arg.string({ required: true }), expectedRevisionId: t.arg.id({ required: false }) },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) =>
          domainFrom(ctx).content.update({
            itemId: String(a.id),
            data: JSON.parse(String(a.data)),
            expectedRevisionId: a.expectedRevisionId ? String(a.expectedRevisionId) : undefined,
          }),
      }),
    )
    builder.mutationField('submitForApproval', (t: any) =>
      t.field({
        type: contentItemRef,
        complexity: 5,
        args: { itemId: t.arg.id({ required: true }) },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) => domainFrom(ctx).content.submitForApproval({ itemId: String(a.itemId) }),
      }),
    )
    builder.mutationField('decideApproval', (t: any) =>
      t.field({
        type: contentApprovalRef,
        complexity: 5,
        args: { approvalId: t.arg.id({ required: true }), vote: t.arg.string({ required: true }) },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) =>
          domainFrom(ctx).content.decideApproval({ approvalId: String(a.approvalId), vote: String(a.vote) as 'approve' | 'reject' }),
      }),
    )
    builder.mutationField('publishContent', (t: any) =>
      t.field({
        type: contentItemRef,
        complexity: 10,
        args: { itemId: t.arg.id({ required: true }) },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) => domainFrom(ctx).content.publish({ itemId: String(a.itemId) }),
      }),
    )
    builder.mutationField('unpublishContent', (t: any) =>
      t.field({
        type: contentItemRef,
        complexity: 10,
        args: { itemId: t.arg.id({ required: true }) },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) => domainFrom(ctx).content.unpublish({ itemId: String(a.itemId) }),
      }),
    )
    builder.mutationField('scheduleContent', (t: any) =>
      t.field({
        type: contentScheduleRef,
        complexity: 5,
        args: {
          itemId: t.arg.id({ required: true }),
          action: t.arg.string({ required: true }),
          revisionId: t.arg.id({ required: true }),
          runAt: t.arg.string({ required: true }),
        },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) =>
          domainFrom(ctx).content.schedule({
            itemId: String(a.itemId),
            action: String(a.action) as 'publish' | 'unpublish',
            revisionId: String(a.revisionId),
            runAt: String(a.runAt),
          }),
      }),
    )
    builder.mutationField('createContentCollection', (t: any) =>
      t.field({
        type: contentCollectionRef,
        complexity: 5,
        args: {
          workspaceId: t.arg.id({ required: true }),
          key: t.arg.string({ required: true }),
          label: t.arg.string({ required: true }),
          description: t.arg.string({ required: false }),
        },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) =>
          domainFrom(ctx).content.createCollection({
            workspaceId: String(a.workspaceId),
            key: String(a.key),
            label: String(a.label),
            description: a.description ?? undefined,
          }),
      }),
    )
    builder.mutationField('addToCollection', (t: any) =>
      t.field({
        type: 'Boolean',
        complexity: 5,
        args: { collectionId: t.arg.id({ required: true }), itemId: t.arg.id({ required: true }), position: t.arg.int({ required: false }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext) => {
          await domainFrom(ctx).content.addToCollection({ collectionId: String(a.collectionId), itemId: String(a.itemId), position: a.position ?? undefined })
          return true
        },
      }),
    )
    builder.mutationField('runSeoAudit', (t: any) =>
      t.field({
        type: seoAudit,
        complexity: 10,
        args: { itemId: t.arg.id({ required: true }) },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) =>
          domainFrom(ctx).content.runSeoAudit({ itemId: String(a.itemId) }) as unknown as Promise<Row>,
      }),
    )
    builder.mutationField('issueAssetUpload', (t: any) =>
      t.field({
        type: assetUpload,
        complexity: 5,
        args: {
          workspaceId: t.arg.id({ required: true }),
          filename: t.arg.string({ required: true }),
          mime: t.arg.string({ required: true }),
          sizeBytes: t.arg.int({ required: true }),
        },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) =>
          domainFrom(ctx).content.issueAssetUpload({
            workspaceId: String(a.workspaceId),
            filename: String(a.filename),
            mime: String(a.mime),
            sizeBytes: Number(a.sizeBytes),
          }),
      }),
    )
    builder.mutationField('finalizeAsset', (t: any) =>
      t.field({
        type: contentAsset,
        complexity: 5,
        args: {
          assetId: t.arg.id({ required: true }),
          checksum: t.arg.string({ required: true }),
          sizeBytes: t.arg.int({ required: true }),
          width: t.arg.int({ required: false }),
          height: t.arg.int({ required: false }),
        },
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) =>
          domainFrom(ctx).content.finalizeAsset({
            assetId: String(a.assetId),
            checksum: String(a.checksum),
            sizeBytes: Number(a.sizeBytes),
            width: a.width ?? undefined,
            height: a.height ?? undefined,
          }) as unknown as Promise<Row>,
      }),
    )
  }

  // ── Campaigns Part C — custom READ queries (only when the campaign collections exist) ──
  // Codegen owns the generic campaign create+read CRUD. These two reads bridge the generic
  // surface's limits: jsonb serialises to "[object Object]", relation FKs are not queryable
  // scalars, and the generic list has no per-field filter (see plan "Inputs consumed").
  if (refs.has('campaign_deliverable')) {
    // Local row shapes for the ctx.db reads (avoid `any` in resolver bodies; the Pothos
    // builder callbacks keep the file's existing `t: any` convention).
    type GoalMetric = { metric_key?: string; target_value?: number | string | null; unit?: string | null }
    type CampaignRowLite = {
      id: string; workspace_id: string; name: string | null; brief: string | null
      status: string | null; priority: string | null; rank: number | string | null
      start_date: string | null; end_date: string | null; owner_id: string | null
      marketing_plan_id: string | null; goal_metrics: unknown
    }

    const deliverableSchedule = builder
      .objectRef<{ taskId: string; startDate: string | null; dueDate: string | null }>('DeliverableSchedule')
      .implement({
        fields: (t: any) => ({
          taskId: t.exposeID('taskId', { complexity: 0 }),
          startDate: t.string({ nullable: true, complexity: 0, resolve: (r: { startDate: string | null }) => r.startDate }),
          dueDate: t.string({ nullable: true, complexity: 0, resolve: (r: { dueDate: string | null }) => r.dueDate }),
        }),
      })

    builder.queryField('deliverableSchedule', (t: any) =>
      t.field({
        type: deliverableSchedule, nullable: true, complexity: 5,
        args: { deliverableId: t.arg.id({ required: true }) },
        // The one custom DOMAIN read (Part B). Recovers the backing task's dates via the
        // implemented_by edge; null when unlinked/inaccessible under the caller's RLS.
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) =>
          domainFrom(ctx).campaign.deliverableSchedule(String(a.deliverableId)),
      }),
    )

    // ── deliverableSchedules: the BATCHED sibling (timeline/calendar use THIS, not the
    // singular one per deliverable). Part B's campaign.deliverableSchedules does ONE edges read
    // + ONE task read; each entry carries its deliverableId so the client maps back. ──
    const deliverableScheduleEntry = builder
      .objectRef<{ deliverableId: string; taskId: string; startDate: string | null; dueDate: string | null }>('DeliverableScheduleEntry')
      .implement({
        fields: (t: any) => ({
          deliverableId: t.exposeID('deliverableId', { complexity: 0 }),
          taskId: t.exposeID('taskId', { complexity: 0 }),
          startDate: t.string({ nullable: true, complexity: 0, resolve: (r: { startDate: string | null }) => r.startDate }),
          dueDate: t.string({ nullable: true, complexity: 0, resolve: (r: { dueDate: string | null }) => r.dueDate }),
        }),
      })

    const MAX_SCHEDULE_IDS = 100
    builder.queryField('deliverableSchedules', (t: any) =>
      t.field({
        // complexity scales with the requested batch so a large array cannot hide behind a
        // fixed cost; the resolver ALSO hard-rejects above MAX_SCHEDULE_IDS (F4).
        type: [deliverableScheduleEntry], nullable: false,
        complexity: (_args: any, _ctx: unknown) => 10 + Math.min(Number(_args?.deliverableIds?.length ?? 0), MAX_SCHEDULE_IDS),
        args: { deliverableIds: t.arg({ type: ['ID'], required: true }) },
        // Resolved at call time from ctx (workerd has no per-request module instance).
        resolve: (_r: unknown, a: any, ctx: GraphQLContext) => {
          const ids = (a.deliverableIds as unknown[]).map(String)
          if (ids.length > MAX_SCHEDULE_IDS) throw new Error('deliverable_schedules_too_many_ids')
          return domainFrom(ctx).campaign.deliverableSchedules(ids)
        },
      }),
    )

    // ── campaignDetail: the per-campaign BFF read (detail + board pages) ──
    const metricTarget = builder.objectRef<{ metricKey: string; targetValue: string | null; unit: string | null }>('MetricTarget').implement({
      fields: (t: any) => ({
        metricKey: t.exposeString('metricKey', { complexity: 0 }),
        targetValue: t.string({ nullable: true, complexity: 0, resolve: (r: { targetValue: string | null }) => r.targetValue }),
        unit: t.string({ nullable: true, complexity: 0, resolve: (r: { unit: string | null }) => r.unit }),
      }),
    })
    const metricActual = builder.objectRef<{ metricKey: string; total: number }>('MetricActual').implement({
      fields: (t: any) => ({
        metricKey: t.exposeString('metricKey', { complexity: 0 }),
        total: t.float({ complexity: 0, resolve: (r: { total: number }) => r.total }),
      }),
    })
    const deliverableBrief = builder.objectRef<{ id: string; name: string | null; taskId: string | null }>('CampaignDeliverableBrief').implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        name: t.string({ nullable: true, complexity: 0, resolve: (r: { name: string | null }) => r.name }),
        taskId: t.string({ nullable: true, complexity: 0, resolve: (r: { taskId: string | null }) => r.taskId }),
      }),
    })
    const channelBrief = builder.objectRef<{ id: string; channelType: string | null; name: string | null }>('CampaignChannelBrief').implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        channelType: t.string({ nullable: true, complexity: 0, resolve: (r: { channelType: string | null }) => r.channelType }),
        name: t.string({ nullable: true, complexity: 0, resolve: (r: { name: string | null }) => r.name }),
      }),
    })
    const stakeholders = builder.objectRef<{ ownerId: string | null; observerIds: string[] }>('CampaignStakeholders').implement({
      fields: (t: any) => ({
        ownerId: t.string({ nullable: true, complexity: 0, resolve: (r: { ownerId: string | null }) => r.ownerId }),
        observerIds: t.field({ type: ['ID'], complexity: 0, resolve: (r: { observerIds: string[] }) => r.observerIds }),
      }),
    })
    type CampaignDetailShape = {
      id: string; name: string | null; brief: string | null; status: string | null
      priority: string | null; rank: string | null; startDate: string | null; endDate: string | null
      ownerId: string | null; marketingPlanId: string | null
      goalMetrics: Array<{ metricKey: string; targetValue: string | null; unit: string | null }>
      actuals: Array<{ metricKey: string; total: number }>
      deliverables: Array<{ id: string; name: string | null; taskId: string | null }>
      channels: Array<{ id: string; channelType: string | null; name: string | null }>
      stakeholders: { ownerId: string | null; observerIds: string[] }
    }
    const campaignDetail = builder.objectRef<CampaignDetailShape>('CampaignDetail').implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        name: t.string({ nullable: true, complexity: 0, resolve: (r: CampaignDetailShape) => r.name }),
        brief: t.string({ nullable: true, complexity: 0, resolve: (r: CampaignDetailShape) => r.brief }),
        status: t.string({ nullable: true, complexity: 0, resolve: (r: CampaignDetailShape) => r.status }),
        priority: t.string({ nullable: true, complexity: 0, resolve: (r: CampaignDetailShape) => r.priority }),
        rank: t.string({ nullable: true, complexity: 0, resolve: (r: CampaignDetailShape) => r.rank }),
        startDate: t.string({ nullable: true, complexity: 0, resolve: (r: CampaignDetailShape) => r.startDate }),
        endDate: t.string({ nullable: true, complexity: 0, resolve: (r: CampaignDetailShape) => r.endDate }),
        ownerId: t.string({ nullable: true, complexity: 0, resolve: (r: CampaignDetailShape) => r.ownerId }),
        marketingPlanId: t.string({ nullable: true, complexity: 0, resolve: (r: CampaignDetailShape) => r.marketingPlanId }),
        goalMetrics: t.field({ type: [metricTarget], complexity: 0, resolve: (r: CampaignDetailShape) => r.goalMetrics }),
        actuals: t.field({ type: [metricActual], complexity: 0, resolve: (r: CampaignDetailShape) => r.actuals }),
        deliverables: t.field({ type: [deliverableBrief], complexity: 0, resolve: (r: CampaignDetailShape) => r.deliverables }),
        channels: t.field({ type: [channelBrief], complexity: 0, resolve: (r: CampaignDetailShape) => r.channels }),
        stakeholders: t.field({ type: stakeholders, complexity: 0, resolve: (r: CampaignDetailShape) => r.stakeholders }),
      }),
    })

    builder.queryField('campaignDetail', (t: any) =>
      t.field({
        type: campaignDetail, nullable: true, complexity: 15,
        args: { campaignId: t.arg.id({ required: true }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext): Promise<CampaignDetailShape | null> => {
          const campaignId = String(a.campaignId)
          // All reads run under the caller's RLS (member-scoped, non-internal tables). Every
          // child/edge read is ALSO explicitly scoped to the campaign's workspace_id (F2 defence-
          // in-depth): even if a cross-workspace child row existed it is never aggregated here.
          // Every read checks `error` and fails loud with a bounded code (F3) rather than silently
          // returning empty sections that look like "no data".
          const { data: c, error: cErr } = await ctx.db
            .from('campaign')
            .select('id, workspace_id, name, brief, status, priority, rank, start_date, end_date, owner_id, marketing_plan_id, goal_metrics')
            .eq('id', campaignId)
            .maybeSingle()
          if (cErr) throw new Error('campaign_detail_campaign_failed')
          if (!c) return null
          const camp = c as CampaignRowLite
          const ws = camp.workspace_id

          const { data: delivRows, error: delivErr } = await ctx.db
            .from('campaign_deliverable').select('id, name')
            .eq('campaign_id', campaignId).eq('workspace_id', ws).order('id', { ascending: true })
          if (delivErr) throw new Error('campaign_detail_deliverables_failed')
          const delivs = (delivRows ?? []) as Array<{ id: string; name: string | null }>

          // Batch the backing-task ids for ALL deliverables in ONE edges read (avoid N+1).
          const delivIds = delivs.map((d) => d.id)
          const edgeMap = new Map<string, string>()
          if (delivIds.length > 0) {
            const { data: edges, error: edgeErr } = await ctx.db
              .from('edges').select('src_id, dst_id')
              .eq('workspace_id', ws)
              .eq('rel', 'implemented_by').eq('src_type', 'campaign_deliverable').eq('dst_type', 'task')
              .in('src_id', delivIds)
            if (edgeErr) throw new Error('campaign_detail_edges_failed')
            for (const e of (edges ?? []) as Array<{ src_id: string; dst_id: string }>) edgeMap.set(e.src_id, e.dst_id)
          }

          const { data: chanRows, error: chanErr } = await ctx.db
            .from('campaign_channel').select('id, channel_type, name')
            .eq('campaign_id', campaignId).eq('workspace_id', ws).order('id', { ascending: true })
          if (chanErr) throw new Error('campaign_detail_channels_failed')
          const { data: metricRows, error: metricErr } = await ctx.db
            .from('campaign_metric').select('metric_key, value')
            .eq('campaign_id', campaignId).eq('workspace_id', ws)
          if (metricErr) throw new Error('campaign_detail_metrics_failed')

          // Roll up sum(value) by metric_key (the actuals side of target-vs-actual).
          const totals = new Map<string, number>()
          for (const m of (metricRows ?? []) as Array<{ metric_key: string | null; value: number | string | null }>) {
            const key = m.metric_key ?? ''
            const v = typeof m.value === 'string' ? Number(m.value) : (m.value ?? 0)
            totals.set(key, (totals.get(key) ?? 0) + (Number.isFinite(v) ? v : 0))
          }

          // Observers via the campaign→user observer edge (owner is the FK owner_id).
          const observers = await domainFrom(ctx).graph.traverse({
            workspaceId: camp.workspace_id, srcType: 'campaign', srcId: campaignId, rel: 'observer', depth: 1,
          })
          const observerIds = observers.filter((n) => n.type === 'user').map((n) => n.id)

          const goals: GoalMetric[] = Array.isArray(camp.goal_metrics) ? (camp.goal_metrics as GoalMetric[]) : []

          return {
            id: camp.id,
            name: camp.name,
            brief: camp.brief,
            status: camp.status,
            priority: camp.priority,
            rank: camp.rank == null ? null : String(camp.rank),
            startDate: camp.start_date,
            endDate: camp.end_date,
            ownerId: camp.owner_id,
            marketingPlanId: camp.marketing_plan_id,
            goalMetrics: goals.map((g) => ({
              metricKey: String(g.metric_key ?? ''),
              targetValue: g.target_value == null ? null : String(g.target_value),
              unit: g.unit ?? null,
            })),
            actuals: [...totals.entries()].map(([metricKey, total]) => ({ metricKey, total })),
            deliverables: delivs.map((d) => ({ id: d.id, name: d.name, taskId: edgeMap.get(d.id) ?? null })),
            channels: ((chanRows ?? []) as Array<{ id: string; channel_type: string | null; name: string | null }>)
              .map((ch) => ({ id: ch.id, channelType: ch.channel_type, name: ch.name })),
            stakeholders: { ownerId: camp.owner_id, observerIds },
          }
        },
      }),
    )
  }

  // ── Segmentation Part D — custom READ queries + the campaign audience seam ──
  // Codegen owns the generic segmentation create+read CRUD. These reads bridge the generic
  // surface's limits: jsonb serialises to "[object Object]", relation FKs are not queryable
  // scalars, and the generic list has no per-field filter (see plan "Inputs consumed").
  if (refs.has('segment_membership')) {
    const CAP = 500   // bounded arrays for diff/audience — full counts always returned

    // ── previewMatchingCount: bounded, injection-safe preview (Part C compiler via RPC) ──
    const previewCount = builder.objectRef<{ count: number }>('PreviewCount').implement({
      fields: (t: any) => ({ count: t.int({ complexity: 0, resolve: (r: { count: number }) => r.count }) }),
    })
    builder.queryField('previewMatchingCount', (t: any) =>
      t.field({
        type: previewCount, nullable: false, complexity: 20,
        args: { segmentId: t.arg.id({ required: true }), predicate: t.arg.string({ required: true }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext): Promise<{ count: number }> => {
          // Resolve ctx.db at call time (workerd has no per-request module instance).
          let parsed: unknown
          try { parsed = JSON.parse(String(a.predicate)) } catch { return { count: 0 } }
          // ctx.db.rpc runs under the caller; preview_segment_predicate is DEFINER + member-gated
          // and reuses Part C's SAME injection-safe compiler — never a new SQL-building path.
          const { data, error } = await ctx.db.rpc('preview_segment_predicate', {
            seg_id: String(a.segmentId), predicate: parsed,
          })
          // F6: a failed RPC must NOT masquerade as "0 matched" — throw a coded error the client can see.
          if (error) throw new Error('segment.read_failed: field=previewMatchingCount code=preview_failed')
          const n = typeof data === 'number' ? data : Number(data ?? 0)
          return { count: Number.isFinite(n) ? n : 0 }
        },
      }),
    )

    // ── segmentMembershipExplained: the per-member explanation (PII-disciplined) ──
    const evidenceEvent = builder.objectRef<{ eventId: string; eventType: string | null; occurredAt: string | null }>('EvidenceEvent').implement({
      fields: (t: any) => ({
        eventId: t.exposeID('eventId', { complexity: 0 }),
        eventType: t.string({ nullable: true, complexity: 0, resolve: (r: any) => r.eventType }),
        occurredAt: t.string({ nullable: true, complexity: 0, resolve: (r: any) => r.occurredAt }),
      }),
    })
    type ExplainShape = {
      subjectRef: string; subjectType: string | null; matchedRuleId: string | null
      matchedRuleVersion: number | null; firstMatchedAt: string | null; evaluatedAt: string | null
      evidence: Array<{ eventId: string; eventType: string | null; occurredAt: string | null }>
    }
    const explanation = builder.objectRef<ExplainShape>('MembershipExplanation').implement({
      fields: (t: any) => ({
        subjectRef: t.exposeString('subjectRef', { complexity: 0 }),
        subjectType: t.string({ nullable: true, complexity: 0, resolve: (r: ExplainShape) => r.subjectType }),
        matchedRuleId: t.string({ nullable: true, complexity: 0, resolve: (r: ExplainShape) => r.matchedRuleId }),
        matchedRuleVersion: t.int({ nullable: true, complexity: 0, resolve: (r: ExplainShape) => r.matchedRuleVersion }),
        firstMatchedAt: t.string({ nullable: true, complexity: 0, resolve: (r: ExplainShape) => r.firstMatchedAt }),
        evaluatedAt: t.string({ nullable: true, complexity: 0, resolve: (r: ExplainShape) => r.evaluatedAt }),
        evidence: t.field({ type: [evidenceEvent], complexity: 0, resolve: (r: ExplainShape) => r.evidence }),
      }),
    })
    builder.queryField('segmentMembershipExplained', (t: any) =>
      t.field({
        type: explanation, nullable: true, complexity: 15,
        args: { segmentId: t.arg.id({ required: true }), subjectRef: t.arg.string({ required: true }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext): Promise<ExplainShape | null> => {
          const { data: m, error: mErr } = await ctx.db
            .from('segment_membership')
            .select('id, segment_id, subject_type, subject_ref, matched_rule_id, first_matched_at, evaluated_at, evidence')
            .eq('segment_id', String(a.segmentId)).eq('subject_ref', String(a.subjectRef))
            .maybeSingle()
          if (mErr) throw new Error('segment.read_failed: field=segmentMembershipExplained code=membership')
          if (!m) return null
          const mem = m as { subject_type: string | null; matched_rule_id: string | null;
            first_matched_at: string | null; evaluated_at: string | null; evidence: unknown }
          let version: number | null = null
          if (mem.matched_rule_id) {
            const { data: rule, error: rErr } = await ctx.db
              .from('segment_rule').select('id, version').eq('id', mem.matched_rule_id).maybeSingle()
            if (rErr) throw new Error('segment.read_failed: field=segmentMembershipExplained code=rule')
            if (rule) version = Number((rule as { version: number | string }).version)
          }
          // evidence jsonb → event_ids array (Part B's shape; reconcile the key if different).
          const ev = mem.evidence as { event_ids?: unknown } | null
          const eventIds = Array.isArray(ev?.event_ids) ? (ev!.event_ids as unknown[]).map(String) : []
          let evidence: ExplainShape['evidence'] = []
          if (eventIds.length > 0) {
            // PII BOUNDARY: select ONLY typed dimensions — never `properties`.
            const { data: evs, error: eErr } = await ctx.db
              .from('platform_event').select('id, event_type, occurred_at').in('id', eventIds)
            if (eErr) throw new Error('segment.read_failed: field=segmentMembershipExplained code=evidence')
            evidence = ((evs ?? []) as Array<{ id: string; event_type: string | null; occurred_at: string | null }>)
              .map((e) => ({ eventId: e.id, eventType: e.event_type, occurredAt: e.occurred_at }))
          }
          return {
            subjectRef: String(a.subjectRef), subjectType: mem.subject_type,
            matchedRuleId: mem.matched_rule_id, matchedRuleVersion: version,
            firstMatchedAt: mem.first_matched_at, evaluatedAt: mem.evaluated_at, evidence,
          }
        },
      }),
    )

    // ── snapshotDiff: added/removed subject_refs between two snapshots ──
    type DiffShape = { added: string[]; removed: string[]; addedCount: number; removedCount: number }
    const snapshotDiff = builder.objectRef<DiffShape>('SnapshotDiff').implement({
      fields: (t: any) => ({
        added: t.field({ type: ['String'], complexity: 0, resolve: (r: DiffShape) => r.added }),
        removed: t.field({ type: ['String'], complexity: 0, resolve: (r: DiffShape) => r.removed }),
        addedCount: t.int({ complexity: 0, resolve: (r: DiffShape) => r.addedCount }),
        removedCount: t.int({ complexity: 0, resolve: (r: DiffShape) => r.removedCount }),
      }),
    })
    builder.queryField('snapshotDiff', (t: any) =>
      t.field({
        type: snapshotDiff, nullable: false, complexity: 20,
        args: { snapshotAId: t.arg.id({ required: true }), snapshotBId: t.arg.id({ required: true }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext): Promise<DiffShape> => {
          const load = async (snapId: string): Promise<Set<string>> => {
            // A correct diff needs BOTH full member sets — you cannot compute a true added/removed COUNT
            // from capped sets. This on-demand read is bounded by the snapshot's frozen size (≤ the segment
            // size at snapshot time), not an unbounded hot-path scan, so we load the full subject_ref set for
            // counting and cap only the RETURNED arrays below (full counts + bounded arrays; contract holds).
            const { data, error } = await ctx.db
              .from('segment_snapshot_member').select('subject_ref').eq('snapshot_id', snapId)
            if (error) throw new Error('segment.read_failed: field=snapshotDiff code=snapshot_member')
            return new Set(((data ?? []) as Array<{ subject_ref: string }>).map((r) => r.subject_ref))
          }
          const [A, B] = [await load(String(a.snapshotAId)), await load(String(a.snapshotBId))]
          const added = [...B].filter((s) => !A.has(s))     // in B (after), not in A (before)
          const removed = [...A].filter((s) => !B.has(s))   // in A (before), not in B (after)
          return { added: added.slice(0, CAP), removed: removed.slice(0, CAP),
                   addedCount: added.length, removedCount: removed.length }
        },
      }),
    )

    // ── campaignAudience: DEFERRED (Phase 7) ──
    // The campaign→segment/snapshot audience seam is deferred out of Part D: nothing writes the
    // targets_segment / targets_snapshot edges yet, so there is no producer/consumer to resolve (YAGNI).

    // ── enumeration bridges (limits 2+3: no per-segment generic filter) ──
    type SummaryShape = { id: string; name: string | null; active: boolean | null; mode: string | null
      ownerRef: string | null; memberCount: number; lastRecomputedAt: string | null }
    const summary = builder.objectRef<SummaryShape>('SegmentSummary').implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        name: t.string({ nullable: true, complexity: 0, resolve: (r: SummaryShape) => r.name }),
        active: t.boolean({ nullable: true, complexity: 0, resolve: (r: SummaryShape) => r.active }),
        mode: t.string({ nullable: true, complexity: 0, resolve: (r: SummaryShape) => r.mode }),
        ownerRef: t.string({ nullable: true, complexity: 0, resolve: (r: SummaryShape) => r.ownerRef }),
        memberCount: t.int({ complexity: 0, resolve: (r: SummaryShape) => r.memberCount }),
        lastRecomputedAt: t.string({ nullable: true, complexity: 0, resolve: (r: SummaryShape) => r.lastRecomputedAt }),
      }),
    })
    builder.queryField('segmentSummaries', (t: any) =>
      t.field({
        type: [summary], nullable: false, complexity: 25,
        args: { workspaceId: t.arg.id({ required: true }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext): Promise<SummaryShape[]> => {
          const ws = String(a.workspaceId)
          const { data: segs, error: sErr } = await ctx.db
            .from('segment').select('id, name, active, mode, owner_ref').eq('workspace_id', ws).order('name', { ascending: true })
          if (sErr) throw new Error('segment.read_failed: field=segmentSummaries code=segment')
          const rows = (segs ?? []) as Array<{ id: string; name: string | null; active: boolean | null; mode: string | null; owner_ref: string | null }>
          // F7: push aggregation into SQL — never fold every membership/run row in JS. Member counts via
          // PostgREST count() grouped by segment_id; last recompute via max(finished_at) grouped likewise.
          const { data: memRows, error: mErr } = await ctx.db
            .from('segment_membership').select('segment_id, member_count:count()').eq('workspace_id', ws)
          if (mErr) throw new Error('segment.read_failed: field=segmentSummaries code=membership')
          const counts = new Map<string, number>()
          for (const m of (memRows ?? []) as Array<{ segment_id: string; member_count: number | string }>) counts.set(m.segment_id, Number(m.member_count))
          const { data: runRows, error: rErr } = await ctx.db
            .from('segment_recompute_run').select('segment_id, last_finished_at:finished_at.max()').eq('workspace_id', ws)
          if (rErr) throw new Error('segment.read_failed: field=segmentSummaries code=run')
          const last = new Map<string, string>()
          for (const r of (runRows ?? []) as unknown as Array<{ segment_id: string; last_finished_at: string | null }>) {
            if (r.last_finished_at) last.set(r.segment_id, r.last_finished_at)
          }
          return rows.map((s) => ({ id: s.id, name: s.name, active: s.active, mode: s.mode, ownerRef: s.owner_ref,
            memberCount: counts.get(s.id) ?? 0, lastRecomputedAt: last.get(s.id) ?? null }))
        },
      }),
    )

    type MemberEntry = { subjectRef: string; subjectType: string | null; matchedRuleId: string | null; evaluatedAt: string | null }
    const memberEntry = builder.objectRef<MemberEntry>('SegmentMemberEntry').implement({
      fields: (t: any) => ({
        subjectRef: t.exposeString('subjectRef', { complexity: 0 }),
        subjectType: t.string({ nullable: true, complexity: 0, resolve: (r: MemberEntry) => r.subjectType }),
        matchedRuleId: t.string({ nullable: true, complexity: 0, resolve: (r: MemberEntry) => r.matchedRuleId }),
        evaluatedAt: t.string({ nullable: true, complexity: 0, resolve: (r: MemberEntry) => r.evaluatedAt }),
      }),
    })
    const memberPage = builder.objectRef<{ items: MemberEntry[]; nextCursor: string | null }>('SegmentMemberPage').implement({
      fields: (t: any) => ({
        items: t.field({ type: [memberEntry], complexity: 0, resolve: (r: any) => r.items }),
        nextCursor: t.string({ nullable: true, complexity: 0, resolve: (r: any) => r.nextCursor }),
      }),
    })
    builder.queryField('segmentMembers', (t: any) =>
      t.field({
        type: memberPage, nullable: false, complexity: 20,
        args: { segmentId: t.arg.id({ required: true }), first: t.arg.int(), after: t.arg.string() },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext) => {
          const limit = Math.min(Number(a.first ?? 50), 200)
          let q = ctx.db.from('segment_membership')
            .select('subject_ref, subject_type, matched_rule_id, evaluated_at')
            .eq('segment_id', String(a.segmentId)).order('subject_ref', { ascending: true })
          if (a.after) q = q.gt('subject_ref', String(a.after))   // keyset pagination on subject_ref
          const { data, error } = await q.limit(limit + 1)         // query bounded to limit+1 rows
          if (error) throw new Error('segment.read_failed: field=segmentMembers code=membership')
          const all = (data ?? []) as Array<{ subject_ref: string; subject_type: string | null; matched_rule_id: string | null; evaluated_at: string | null }>
          const items = all.slice(0, limit).map((m) => ({ subjectRef: m.subject_ref, subjectType: m.subject_type, matchedRuleId: m.matched_rule_id, evaluatedAt: m.evaluated_at }))
          const nextCursor = all.length > limit ? items[items.length - 1]?.subjectRef ?? null : null
          return { items, nextCursor }
        },
      }),
    )

    type SnapEntry = { id: string; takenAt: string | null; reason: string | null; memberCount: number | null }
    const snapEntry = builder.objectRef<SnapEntry>('SnapshotEntry').implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        takenAt: t.string({ nullable: true, complexity: 0, resolve: (r: SnapEntry) => r.takenAt }),
        reason: t.string({ nullable: true, complexity: 0, resolve: (r: SnapEntry) => r.reason }),
        memberCount: t.int({ nullable: true, complexity: 0, resolve: (r: SnapEntry) => r.memberCount }),
      }),
    })
    builder.queryField('segmentSnapshots', (t: any) =>
      t.field({
        type: [snapEntry], nullable: false, complexity: 15,
        args: { segmentId: t.arg.id({ required: true }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext): Promise<SnapEntry[]> => {
          const { data, error } = await ctx.db.from('segment_snapshot')
            .select('id, taken_at, reason, member_count').eq('segment_id', String(a.segmentId)).order('taken_at', { ascending: true })
          if (error) throw new Error('segment.read_failed: field=segmentSnapshots code=snapshot')
          return ((data ?? []) as Array<{ id: string; taken_at: string | null; reason: string | null; member_count: number | null }>)
            .map((s) => ({ id: s.id, takenAt: s.taken_at, reason: s.reason, memberCount: s.member_count }))
        },
      }),
    )

    // ── createSegmentRuleVersion: the ONE custom WRITE (the rule builder's Save) ──
    // The generic createSegmentRule input SKIPS the segment_id RELATION FK, so a rule can't be attached
    // to its segment through the generic surface. Version assignment lives in a DB RPC with a
    // per-segment advisory lock + unique(segment_id, version); never read max(version)+1 here.
    type RuleVersionShape = { id: string; version: number }
    const ruleVersion = builder.objectRef<RuleVersionShape>('SegmentRuleVersion').implement({
      fields: (t: any) => ({
        id: t.exposeID('id', { complexity: 0 }),
        version: t.int({ complexity: 0, resolve: (r: RuleVersionShape) => r.version }),
      }),
    })
    builder.mutationField('createSegmentRuleVersion', (t: any) =>
      t.field({
        type: ruleVersion, nullable: true, complexity: 15,
        args: { segmentId: t.arg.id({ required: true }), predicate: t.arg.string({ required: true }) },
        resolve: async (_r: unknown, a: any, ctx: GraphQLContext): Promise<RuleVersionShape | null> => {
          let predicate: unknown
          try { predicate = JSON.parse(String(a.predicate)) } catch { throw new Error('segment.write_failed: field=createSegmentRuleVersion code=invalid_predicate_json') }
          const { data, error } = await ctx.db.rpc('create_segment_rule_version', {
            seg_id: String(a.segmentId),
            predicate,
          })
          if (error) throw new Error('segment.write_failed: field=createSegmentRuleVersion code=insert')
          if (!data) return null
          const row = data as { id: string; version: number | string }
          return { id: row.id, version: Number(row.version) }
        },
      }),
    )
  }

  return builder.toSchema()
}
