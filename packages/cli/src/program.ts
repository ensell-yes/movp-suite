import { Command } from 'commander'
import type { CollectionDef, FieldDef } from '@movp/core-schema'
import { schema } from '@movp/core-schema'
import { createDomain, type CollectionService, type Domain } from '@movp/domain'
import { resolveCliCtx, type CliCtx } from './client.ts'

export interface JobsHandlers {
  replay: (o: { kind?: string; dead?: boolean }) => Promise<void>
  reindex: (collection: string) => Promise<void>
}

export interface BuildProgramOpts {
  resolveCtx?: () => CliCtx
  runCodegen?: () => Promise<void>
  runMigratePush?: () => Promise<void>
  jobs?: JobsHandlers
  out?: (line: string) => void
}

type AnyService = CollectionService<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>

function service(domain: Domain, name: string): AnyService {
  const svc = (domain as unknown as Record<string, AnyService>)[name]
  if (!svc || typeof svc.create !== 'function') throw new Error(`no domain service for collection: ${name}`)
  return svc
}

export function buildProgram(opts: BuildProgramOpts = {}): Command {
  const out = opts.out ?? ((l: string) => console.log(l))
  const resolveCtx = opts.resolveCtx ?? (() => resolveCliCtx())

  const runCodegen =
    opts.runCodegen ??
    (async () => {
      const mod = await import('@movp/codegen')
      if (!mod.generate) throw new Error('@movp/codegen.generate() not found')
      await mod.generate()
    })

  const runMigratePush =
    opts.runMigratePush ??
    (async () => {
      const { spawnSync } = await import('node:child_process')
      const r = spawnSync('supabase', ['db', 'push'], { stdio: 'inherit' })
      if (r.status !== 0) throw new Error(`supabase db push failed (exit ${r.status ?? 'unknown'})`)
    })

  const jobs: JobsHandlers =
    opts.jobs ?? {
      replay: async (o) => {
        const { replayJobs } = await import('@movp/flows')
        await replayJobs(resolveCtx().db, o)
      },
      reindex: async (collection) => {
        const { reindexCollection } = await import('@movp/flows')
        await reindexCollection(resolveCtx().db, collection)
      },
    }

  const program = new Command('movp').description('MOVP Core CLI')

  for (const c of schema.collections as CollectionDef[]) {
    if (c.internal) continue
    const cmd = program.command(c.name).description(`Operate on ${c.labelPlural}`)

    const create = cmd.command('create').requiredOption('--workspace <id>', 'workspace id')
    for (const [name, def] of Object.entries(c.fields) as [string, FieldDef][]) {
      if (def.type === 'relation') continue
      const flag = `--${name} <value>`
      if (def.required) create.requiredOption(flag, def.label)
      else create.option(flag, def.label)
    }
    create.action(async (o: Record<string, string>) => {
      const domain = createDomain(resolveCtx())
      const input: Record<string, unknown> = { workspace_id: o.workspace }
      for (const [name, def] of Object.entries(c.fields) as [string, FieldDef][]) {
        if (def.type === 'relation') continue
        if (o[name] !== undefined) input[name] = o[name]
      }
      out(JSON.stringify(await service(domain, c.name).create(input)))
    })

    cmd
      .command('get')
      .requiredOption('--id <id>', 'record id')
      .action(async (o: { id: string }) => {
        const domain = createDomain(resolveCtx())
        out(JSON.stringify(await service(domain, c.name).get(o.id)))
      })

    cmd
      .command('list')
      .requiredOption('--workspace <id>', 'workspace id')
      .option('--first <n>', 'page size', (v) => parseInt(v, 10))
      .option('--after <cursor>', 'page cursor')
      .action(async (o: { workspace: string; first?: number; after?: string }) => {
        const domain = createDomain(resolveCtx())
        out(
          JSON.stringify(
            await service(domain, c.name).list({
              workspaceId: o.workspace,
              first: o.first,
              after: o.after ?? null,
            }),
          ),
        )
      })
  }

  program
    .command('inbox')
    .description('List the current user inbox feed')
    .requiredOption('--workspace <id>', 'workspace id')
    .option('--tab <tab>', 'all | mentions | saved | assigned', 'all')
    .option('--first <n>', 'max items', (v) => parseInt(v, 10))
    .action(async (o: { workspace: string; tab?: string; first?: number }) => {
      const domain = createDomain(resolveCtx())
      out(
        JSON.stringify(
          await domain.collab.inbox({
            workspaceId: o.workspace,
            tab: (o.tab ?? 'all') as 'all' | 'mentions' | 'saved' | 'assigned',
            first: o.first,
          }),
        ),
      )
    })

  const commentCmd = program.command('comment').description('Collaborate with comments')
  commentCmd
    .command('add')
    .requiredOption('--entity-type <type>', 'entity type, e.g. note')
    .requiredOption('--entity-id <id>', 'entity id')
    .requiredOption('--body <text>', 'comment body')
    .option('--parent <id>', 'parent comment id')
    .option('--mention <userId...>', 'user ids to mention')
    .action(async (o: { entityType: string; entityId: string; body: string; parent?: string; mention?: string[] }) => {
      const domain = createDomain(resolveCtx())
      out(
        JSON.stringify(
          await domain.collab.comment.create({
            entityType: o.entityType,
            entityId: o.entityId,
            body: o.body,
            parentId: o.parent,
            mentions: o.mention,
          }),
        ),
      )
    })

  const taskCmd = program.command('task').description('Manage tasks')
  taskCmd
    .command('create')
    .requiredOption('--workspace <id>', 'workspace id')
    .requiredOption('--title <text>', 'task title')
    .option('--description <text>', 'initial description')
    .option('--status <id>', 'status option id')
    .option('--priority <id>', 'priority option id')
    .option('--parent <id>', 'parent task id')
    .option('--start <date>', 'start date')
    .option('--due <date>', 'due date')
    .action(async (o: { workspace: string; title: string; description?: string; status?: string; priority?: string; parent?: string; start?: string; due?: string }) => {
      const domain = createDomain(resolveCtx())
      out(
        JSON.stringify(
          await domain.task.create({
            workspaceId: o.workspace,
            title: o.title,
            description: o.description,
            statusId: o.status,
            priorityId: o.priority,
            parentId: o.parent,
            startDate: o.start,
            dueDate: o.due,
          }),
        ),
      )
    })
  taskCmd
    .command('list')
    .requiredOption('--workspace <id>', 'workspace id')
    .option('--status <id>', 'filter by status option id')
    .option('--assignee <id>', 'filter by assignee user id')
    .action(async (o: { workspace: string; status?: string; assignee?: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.task.list({ workspaceId: o.workspace, statusId: o.status, assigneeId: o.assignee })))
    })
  taskCmd
    .command('board')
    .requiredOption('--workspace <id>', 'workspace id')
    .action(async (o: { workspace: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.task.board({ workspaceId: o.workspace })))
    })
  taskCmd
    .command('assign')
    .requiredOption('--task <id>', 'task id')
    .requiredOption('--user <id>', 'assignee user id')
    .action(async (o: { task: string; user: string }) => {
      const domain = createDomain(resolveCtx())
      await domain.task.assign({ taskId: o.task, userId: o.user })
      out(JSON.stringify({ ok: true }))
    })
  taskCmd
    .command('transition')
    .requiredOption('--task <id>', 'task id')
    .requiredOption('--status <id>', 'target status option id')
    .action(async (o: { task: string; status: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.task.transition({ taskId: o.task, statusId: o.status })))
    })
  taskCmd
    .command('depend')
    .requiredOption('--task <id>', 'blocked task id')
    .requiredOption('--blocker <id>', 'blocking task id')
    .action(async (o: { task: string; blocker: string }) => {
      const domain = createDomain(resolveCtx())
      await domain.task.addDependency({ taskId: o.task, blockerId: o.blocker })
      out(JSON.stringify({ ok: true }))
    })
  taskCmd
    .command('describe')
    .requiredOption('--task <id>', 'task id')
    .requiredOption('--body <text>', 'new description body')
    .action(async (o: { task: string; body: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.task.updateDescription(o.task, o.body)))
    })

  program
    .command('search <query>')
    .requiredOption('--workspace <id>', 'workspace id')
    .option('--mode <mode>', 'fts only in the direct Node CLI; use GraphQL/MCP for semantic/hybrid')
    .option('--collection <name>', 'restrict to a collection')
    .option('--limit <n>', 'max hits', (v) => parseInt(v, 10))
    .action(async (query: string, o: { workspace: string; mode?: string; collection?: string; limit?: number }) => {
      if (o.mode && o.mode !== 'fts') {
        throw new Error('CLI search supports fts only; use GraphQL/MCP for semantic/hybrid search')
      }
      const domain = createDomain(resolveCtx())
      out(
        JSON.stringify(
          await domain.search({
            workspaceId: o.workspace,
            query,
            mode: 'fts',
            collection: o.collection,
            limit: o.limit,
          }),
        ),
      )
    })

  program.command('codegen').description('Run the codegen pipeline (Plan 2)').action(async () => {
    await runCodegen()
  })

  program.command('migrate').description('Codegen then apply via supabase db push').action(async () => {
    await runCodegen()
    await runMigratePush()
  })

  const jobsCmd = program.command('jobs').description('Async job operations (Plan 5)')
  jobsCmd
    .command('replay')
    .option('--kind <k>', 'embed | webhook | notify')
    .option('--dead', 'replay dead-lettered jobs')
    .action(async (o: { kind?: string; dead?: boolean }) => {
      await jobs.replay({ kind: o.kind, dead: !!o.dead })
    })
  jobsCmd.command('reindex <collection>').action(async (collection: string) => {
    await jobs.reindex(collection)
  })

  return program
}
