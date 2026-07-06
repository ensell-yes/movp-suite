import { Command } from 'commander'
import type { CollectionDef, FieldDef } from '@movp/core-schema'
import { schema } from '@movp/core-schema'
import { createDomain, type CollectionService, type Domain } from '@movp/domain'
import { resolveCliCtx, type CliCtx } from './client.ts'

export interface JobsHandlers {
  replay: (o: { kind?: string; dead?: boolean; workspaceId?: string }) => Promise<void>
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

function parseJsonFlag(value: string | undefined, fallback: unknown): unknown {
  if (value == null || value.length === 0) return fallback
  try {
    return JSON.parse(value)
  } catch {
    throw new Error('invalid_json')
  }
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

  const contentCmd = program.command('content').description('Manage CMS content')
  contentCmd
    .command('create-type')
    .requiredOption('--workspace <id>', 'workspace id')
    .requiredOption('--key <key>', 'content type key')
    .requiredOption('--label <label>', 'display label')
    .requiredOption('--field-schema <json>', 'field schema JSON')
    .action(async (o: { workspace: string; key: string; label: string; fieldSchema: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.content.createType({
        workspaceId: o.workspace,
        key: o.key,
        label: o.label,
        fieldSchema: JSON.parse(o.fieldSchema),
      })))
    })
  contentCmd
    .command('create')
    .requiredOption('--workspace <id>', 'workspace id')
    .requiredOption('--type <id>', 'content type id')
    .requiredOption('--slug <slug>', 'slug')
    .requiredOption('--data <json>', 'content data JSON')
    .action(async (o: { workspace: string; type: string; slug: string; data: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.content.create({
        workspaceId: o.workspace,
        contentTypeId: o.type,
        slug: o.slug,
        data: JSON.parse(o.data),
      })))
    })
  contentCmd
    .command('update')
    .requiredOption('--item <id>', 'content item id')
    .requiredOption('--data <json>', 'content data JSON')
    .action(async (o: { item: string; data: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.content.update({ itemId: o.item, data: JSON.parse(o.data) })))
    })
  contentCmd
    .command('list')
    .requiredOption('--workspace <id>', 'workspace id')
    .option('--type <id>', 'content type id')
    .option('--status <status>', 'status')
    .action(async (o: { workspace: string; type?: string; status?: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.content.list({ workspaceId: o.workspace, contentTypeId: o.type, status: o.status })))
    })
  contentCmd
    .command('approvals')
    .requiredOption('--workspace <id>', 'workspace id')
    .option('--item <id>', 'content item id')
    .option('--state <state>', 'approval state')
    .action(async (o: { workspace: string; item?: string; state?: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.content.listApprovals({
        workspaceId: o.workspace,
        itemId: o.item,
        state: o.state as 'pending' | 'approved' | 'rejected' | 'superseded' | undefined,
      })))
    })
  contentCmd
    .command('get')
    .requiredOption('--item <id>', 'content item id')
    .action(async (o: { item: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.content.get(o.item)))
    })
  contentCmd
    .command('submit')
    .requiredOption('--item <id>', 'content item id')
    .action(async (o: { item: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.content.submitForApproval({ itemId: o.item })))
    })
  contentCmd
    .command('decide')
    .requiredOption('--approval <id>', 'approval id')
    .requiredOption('--vote <approve|reject>', 'vote')
    .action(async (o: { approval: string; vote: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.content.decideApproval({
        approvalId: o.approval,
        vote: o.vote as 'approve' | 'reject',
      })))
    })
  contentCmd
    .command('publish')
    .requiredOption('--item <id>', 'content item id')
    .action(async (o: { item: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.content.publish({ itemId: o.item })))
    })
  contentCmd
    .command('unpublish')
    .requiredOption('--item <id>', 'content item id')
    .action(async (o: { item: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.content.unpublish({ itemId: o.item })))
    })
  contentCmd
    .command('schedule')
    .requiredOption('--item <id>', 'content item id')
    .requiredOption('--action <publish|unpublish>', 'schedule action')
    .requiredOption('--revision <id>', 'pinned revision id')
    .requiredOption('--run-at <iso>', 'run time')
    .action(async (o: { item: string; action: string; revision: string; runAt: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.content.schedule({
        itemId: o.item,
        action: o.action as 'publish' | 'unpublish',
        revisionId: o.revision,
        runAt: o.runAt,
      })))
    })
  contentCmd
    .command('seo-audit')
    .requiredOption('--item <id>', 'content item id')
    .action(async (o: { item: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.content.runSeoAudit({ itemId: o.item })))
    })
  contentCmd
    .command('asset-upload')
    .requiredOption('--workspace <id>', 'workspace id')
    .requiredOption('--filename <name>', 'file name')
    .requiredOption('--mime <mime>', 'MIME type')
    .requiredOption('--size-bytes <n>', 'declared byte size', (v) => parseInt(v, 10))
    .action(async (o: { workspace: string; filename: string; mime: string; sizeBytes: number }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.content.issueAssetUpload({
        workspaceId: o.workspace,
        filename: o.filename,
        mime: o.mime,
        sizeBytes: o.sizeBytes,
      })))
    })

  const workflowsCmd = program.command('workflows').description('Manage workflow automation and webhooks')
  workflowsCmd
    .command('events')
    .option('--first <n>', 'page size', (v) => parseInt(v, 10))
    .option('--after <cursor>', 'page cursor')
    .action(async (o: { first?: number; after?: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.workflows.listEventTypes({ first: o.first, after: o.after ?? null })))
    })

  const workflowRulesCmd = workflowsCmd.command('rules').description('Workflow automation rules')
  workflowRulesCmd
    .command('list')
    .requiredOption('--workspace <id>', 'workspace id')
    .option('--first <n>', 'page size', (v) => parseInt(v, 10))
    .option('--after <cursor>', 'page cursor')
    .action(async (o: { workspace: string; first?: number; after?: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.workflows.listRules({ workspaceId: o.workspace, first: o.first, after: o.after ?? null })))
    })
  workflowRulesCmd
    .command('upsert')
    .requiredOption('--workspace <id>', 'workspace id')
    .option('--id <id>', 'existing rule id')
    .requiredOption('--trigger-event-type <id>', 'event_type id')
    .option('--condition <json>', 'condition JSON')
    .requiredOption('--action-type <type>', 'action type')
    .requiredOption('--action-config <json>', 'action config JSON')
    .option('--enabled', 'enable the rule')
    .option('--disabled', 'disable the rule')
    .option('--priority <n>', 'rule priority', (v) => parseInt(v, 10), 100)
    .action(async (o: {
      workspace: string
      id?: string
      triggerEventType: string
      condition?: string
      actionType: string
      actionConfig: string
      enabled?: boolean
      disabled?: boolean
      priority: number
    }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.workflows.upsertRule({
        workspaceId: o.workspace,
        id: o.id,
        triggerEventTypeId: o.triggerEventType,
        condition: parseJsonFlag(o.condition, {}) as Record<string, unknown>,
        actionType: o.actionType as any,
        actionConfig: parseJsonFlag(o.actionConfig, {}) as Record<string, unknown>,
        enabled: o.disabled ? false : !!o.enabled,
        priority: o.priority,
      })))
    })

  workflowsCmd
    .command('runs')
    .requiredOption('--workspace <id>', 'workspace id')
    .option('--first <n>', 'page size', (v) => parseInt(v, 10))
    .option('--after <cursor>', 'page cursor')
    .action(async (o: { workspace: string; first?: number; after?: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.workflow_run.list({ workspaceId: o.workspace, first: o.first, after: o.after ?? null })))
    })

  const workflowWebhookCmd = workflowsCmd.command('webhooks').description('Workflow webhook subscriptions')
  workflowWebhookCmd
    .command('register')
    .requiredOption('--workspace <id>', 'workspace id')
    .requiredOption('--event <key>', 'event type key')
    .requiredOption('--url <url>', 'webhook URL')
    .option('--filter <json>', 'filter JSON')
    .action(async (o: { workspace: string; event: string; url: string; filter?: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.workflows.registerWebhook({
        workspaceId: o.workspace,
        eventKey: o.event,
        url: o.url,
        filter: parseJsonFlag(o.filter, undefined),
      })))
    })
  workflowWebhookCmd
    .command('rotate')
    .requiredOption('--workspace <id>', 'workspace id')
    .requiredOption('--subscription <id>', 'subscription id')
    .action(async (o: { workspace: string; subscription: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.workflows.rotateWebhook({ workspaceId: o.workspace, subscriptionId: o.subscription })))
    })
  workflowWebhookCmd
    .command('activate')
    .requiredOption('--workspace <id>', 'workspace id')
    .requiredOption('--subscription <id>', 'subscription id')
    .action(async (o: { workspace: string; subscription: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.workflows.setWebhookActive({ workspaceId: o.workspace, subscriptionId: o.subscription, active: true })))
    })
  workflowWebhookCmd
    .command('deactivate')
    .requiredOption('--workspace <id>', 'workspace id')
    .requiredOption('--subscription <id>', 'subscription id')
    .action(async (o: { workspace: string; subscription: string }) => {
      const domain = createDomain(resolveCtx())
      out(JSON.stringify(await domain.workflows.setWebhookActive({ workspaceId: o.workspace, subscriptionId: o.subscription, active: false })))
    })

  workflowsCmd
    .command('replay')
    .requiredOption('--workspace <id>', 'workspace id')
    .option('--dead', 'replay dead-lettered automate jobs')
    .action(async (o: { workspace: string; dead?: boolean }) => {
      await jobs.replay({ kind: 'automate', dead: !!o.dead, workspaceId: o.workspace })
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
