import SchemaBuilder from '@pothos/core'
import ComplexityPlugin from '@pothos/plugin-complexity'
import DataloaderPlugin from '@pothos/plugin-dataloader'
import type { GraphQLSchema } from 'graphql'
import type { CollectionDef, FieldDef, MovpSchema } from '@movp/core-schema'
import { createDomain, type CollectionService, type Domain, type SearchHit } from '@movp/domain'
import { COMPLEXITY_BUDGET, DEPTH_LIMIT, clampPageSize } from './limits.ts'
import { loadEdgeTargets } from './relations.ts'
import type { GraphQLContext, Row } from './types.ts'

function pascal(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
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

  const pages = new Map<string, any>()
  const inputs = new Map<string, any>()

  for (const c of schema.collections as CollectionDef[]) {
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

  return builder.toSchema()
}
