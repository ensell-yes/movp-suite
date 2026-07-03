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
  return createDomain({ db: ctx.db, userId: ctx.userId }, { embedder: ctx.embedder })
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

  return builder.toSchema()
}
