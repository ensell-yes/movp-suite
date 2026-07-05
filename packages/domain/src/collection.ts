import type { CollectionService, DomainCtx, ListArgs, Page } from './types.ts'

const DEFAULT_PAGE = 20
const MAX_PAGE = 100

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi)
const encodeCursor = (id: string) => btoa(id)
const decodeCursor = (cursor: string) => atob(cursor)

export function makeCollectionService<
  Row extends { id: string },
  Create,
  Update,
>(ctx: DomainCtx, config: { table: string; workspaceScoped?: boolean }): CollectionService<Row, Create, Update> {
  const table = config.table
  const workspaceScoped = config.workspaceScoped ?? true
  const fail = (op: string, code: string | undefined): never => {
    throw new Error(`domain.${table}.${op} failed [${code ?? 'unknown'}]`)
  }

  return {
    async create(input) {
      const { data, error } = await ctx.db.from(table).insert(input as Record<string, unknown>).select('*').single()
      if (error) fail('create', error.code)
      return data as Row
    },

    async get(id) {
      const { data, error } = await ctx.db.from(table).select('*').eq('id', id).maybeSingle()
      if (error) fail('get', error.code)
      return (data as Row | null) ?? null
    },

    async list(args: ListArgs): Promise<Page<Row>> {
      const first = clamp(args.first ?? DEFAULT_PAGE, 1, MAX_PAGE)
      let q = ctx.db
        .from(table)
        .select('*')
        .order('id', { ascending: true })
        .limit(first + 1)
      if (workspaceScoped) q = q.eq('workspace_id', args.workspaceId)
      if (args.after) q = q.gt('id', decodeCursor(args.after))

      const { data, error } = await q
      if (error) fail('list', error.code)
      const rows = (data ?? []) as Row[]
      const items = rows.length > first ? rows.slice(0, first) : rows
      const last = items.at(-1)
      return { items, nextCursor: rows.length > first && last ? encodeCursor(last.id) : null }
    },

    async update(id, patch) {
      const { data, error } = await ctx.db.from(table).update(patch as Record<string, unknown>).eq('id', id).select('*').single()
      if (error) fail('update', error.code)
      return data as Row
    },

    async delete(id) {
      const { error } = await ctx.db.from(table).delete().eq('id', id)
      if (error) fail('delete', error.code)
    },
  }
}
