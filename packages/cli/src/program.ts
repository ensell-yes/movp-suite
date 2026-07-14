import { Command, InvalidArgumentError, Option } from 'commander'
import type { CollectionDef, FieldDef } from '@movp/core-schema'
import { schema } from '@movp/core-schema'
import { createDomain, type CollectionService, type Domain } from '@movp/domain'
import { resolveCliCtx, exchangePat, type CliCtx } from './client.ts'
import { writeCliConfig, loadCliConfig } from './config.ts'
import { selectSecureStore } from './secure-store.ts'
import { searchViaGraphql } from './graphql-client.ts'

export interface JobsHandlers {
  replay: (o: { kind?: string; dead?: boolean; workspaceId?: string }) => Promise<void>
  reindex: (collection: string) => Promise<void>
}

export interface BuildProgramOpts {
  resolveCtx?: () => CliCtx | Promise<CliCtx>
  runCodegen?: () => Promise<void>
  runMigratePush?: () => Promise<void>
  jobs?: JobsHandlers
  out?: (line: string) => void
  readLoginToken?: () => Promise<string>
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

function parseInteger(value: string, minimum: number): number {
  if (!/^\d+$/.test(value)) throw new InvalidArgumentError(`expected an integer greater than or equal to ${minimum}`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new InvalidArgumentError(`expected an integer greater than or equal to ${minimum}`)
  }
  return parsed
}

const parsePositiveInteger = (value: string) => parseInteger(value, 1)
const parseNonNegativeInteger = (value: string) => parseInteger(value, 0)

async function readTokenFromStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8').trim()
}

export function buildProgram(opts: BuildProgramOpts = {}): Command {
  const out = opts.out ?? ((l: string) => console.log(l))
  const resolveCtx = opts.resolveCtx ?? (() => resolveCliCtx())
  const readLoginToken = opts.readLoginToken ?? readTokenFromStdin

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
        await replayJobs((await resolveCtx()).db, o)
      },
      reindex: async (collection) => {
        const { reindexCollection } = await import('@movp/flows')
        await reindexCollection((await resolveCtx()).db, collection)
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
      const domain = createDomain(await resolveCtx())
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
        const domain = createDomain(await resolveCtx())
        out(JSON.stringify(await service(domain, c.name).get(o.id)))
      })

    cmd
      .command('list')
      .requiredOption('--workspace <id>', 'workspace id')
      .option('--first <n>', 'page size', parsePositiveInteger)
      .option('--after <cursor>', 'page cursor')
      .action(async (o: { workspace: string; first?: number; after?: string }) => {
        const domain = createDomain(await resolveCtx())
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
    .option('--first <n>', 'max items', parsePositiveInteger)
    .action(async (o: { workspace: string; tab?: string; first?: number }) => {
      const domain = createDomain(await resolveCtx())
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
      const domain = createDomain(await resolveCtx())
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
    .option('--idempotency-key <key>', 'stable key for retry-safe creation')
    .action(async (o: { workspace: string; title: string; description?: string; status?: string; priority?: string; parent?: string; start?: string; due?: string; idempotencyKey?: string }) => {
      const domain = createDomain(await resolveCtx())
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
            idempotencyKey: o.idempotencyKey,
          }),
        ),
      )
    })
  taskCmd
    .command('get')
    .requiredOption('--task <id>', 'task id')
    .action(async (o: { task: string }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.task.getDetail(o.task)))
    })
  taskCmd
    .command('list')
    .requiredOption('--workspace <id>', 'workspace id')
    .option('--status <id>', 'filter by status option id')
    .option('--assignee <id>', 'filter by assignee user id')
    .option('--parent <id>', 'filter by parent task id')
    .option('--top-level', 'list only tasks without a parent')
    .option('--first <n>', 'page size', parsePositiveInteger)
    .option('--after <cursor>', 'page cursor')
    .action(async (o: { workspace: string; status?: string; assignee?: string; parent?: string; topLevel?: boolean; first?: number; after?: string }) => {
      if (o.topLevel && o.parent) throw new InvalidArgumentError('--top-level cannot be combined with --parent')
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.task.list({
        workspaceId: o.workspace,
        statusId: o.status,
        assigneeId: o.assignee,
        parentId: o.topLevel ? null : o.parent,
        first: o.first,
        after: o.after ?? null,
      })))
    })
  taskCmd
    .command('board')
    .requiredOption('--workspace <id>', 'workspace id')
    .action(async (o: { workspace: string }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.task.board({ workspaceId: o.workspace })))
    })
  taskCmd
    .command('assign')
    .requiredOption('--task <id>', 'task id')
    .requiredOption('--user <id>', 'assignee user id')
    .action(async (o: { task: string; user: string }) => {
      const domain = createDomain(await resolveCtx())
      await domain.task.assign({ taskId: o.task, userId: o.user })
      out(JSON.stringify({ ok: true }))
    })
  taskCmd
    .command('unassign')
    .requiredOption('--task <id>', 'task id')
    .requiredOption('--user <id>', 'assignee user id')
    .action(async (o: { task: string; user: string }) => {
      const domain = createDomain(await resolveCtx())
      await domain.task.unassign({ taskId: o.task, userId: o.user })
      out(JSON.stringify({ ok: true }))
    })
  taskCmd
    .command('observe')
    .requiredOption('--task <id>', 'task id')
    .requiredOption('--user <id>', 'observer user id')
    .action(async (o: { task: string; user: string }) => {
      const domain = createDomain(await resolveCtx())
      await domain.task.addObserver({ taskId: o.task, userId: o.user })
      out(JSON.stringify({ ok: true }))
    })
  taskCmd
    .command('unobserve')
    .requiredOption('--task <id>', 'task id')
    .requiredOption('--user <id>', 'observer user id')
    .action(async (o: { task: string; user: string }) => {
      const domain = createDomain(await resolveCtx())
      await domain.task.removeObserver({ taskId: o.task, userId: o.user })
      out(JSON.stringify({ ok: true }))
    })
  taskCmd
    .command('transition')
    .requiredOption('--task <id>', 'task id')
    .requiredOption('--status <id>', 'target status option id')
    .action(async (o: { task: string; status: string }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.task.transition({ taskId: o.task, statusId: o.status })))
    })
  taskCmd
    .command('depend')
    .requiredOption('--task <id>', 'blocked task id')
    .requiredOption('--blocker <id>', 'blocking task id')
    .action(async (o: { task: string; blocker: string }) => {
      const domain = createDomain(await resolveCtx())
      await domain.task.addDependency({ taskId: o.task, blockerId: o.blocker })
      out(JSON.stringify({ ok: true }))
    })
  taskCmd
    .command('undepend')
    .requiredOption('--task <id>', 'blocked task id')
    .requiredOption('--blocker <id>', 'blocking task id')
    .action(async (o: { task: string; blocker: string }) => {
      const domain = createDomain(await resolveCtx())
      await domain.task.removeDependency({ taskId: o.task, blockerId: o.blocker })
      out(JSON.stringify({ ok: true }))
    })
  taskCmd
    .command('describe')
    .requiredOption('--task <id>', 'task id')
    .requiredOption('--body <text>', 'new description body')
    .action(async (o: { task: string; body: string }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.task.updateDescription(o.task, o.body)))
    })
  taskCmd
    .command('attach')
    .requiredOption('--task <id>', 'task id')
    .requiredOption('--r2-key <key>', 'uploaded R2 object key')
    .requiredOption('--filename <name>', 'file name')
    .option('--content-type <mime>', 'MIME type')
    .option('--bytes <n>', 'byte size', parseNonNegativeInteger)
    .action(async (o: { task: string; r2Key: string; filename: string; contentType?: string; bytes?: number }) => {
      const domain = createDomain(await resolveCtx())
      await domain.task.attach({
        taskId: o.task,
        r2Key: o.r2Key,
        filename: o.filename,
        contentType: o.contentType,
        bytes: o.bytes,
      })
      out(JSON.stringify({ ok: true }))
    })

  const contentCmd = program.command('content').description('Manage CMS content')
  contentCmd
    .command('create-type')
    .requiredOption('--workspace <id>', 'workspace id')
    .requiredOption('--key <key>', 'content type key')
    .requiredOption('--label <label>', 'display label')
    .requiredOption('--field-schema <json>', 'field schema JSON')
    .addOption(new Option('--moderation-policy <policy>', 'moderation policy').choices(['none', 'pre', 'post']))
    .addOption(new Option('--approval-policy <policy>', 'approval policy').choices(['none', 'single', 'multi']))
    .action(async (o: { workspace: string; key: string; label: string; fieldSchema: string; moderationPolicy?: string; approvalPolicy?: string }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.content.createType({
        workspaceId: o.workspace,
        key: o.key,
        label: o.label,
        fieldSchema: JSON.parse(o.fieldSchema),
        moderationPolicy: o.moderationPolicy,
        approvalPolicy: o.approvalPolicy,
      })))
    })
  contentCmd
    .command('types')
    .requiredOption('--workspace <id>', 'workspace id')
    .option('--first <n>', 'page size', parsePositiveInteger)
    .option('--after <cursor>', 'page cursor')
    .action(async (o: { workspace: string; first?: number; after?: string }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.content.listTypes({ workspaceId: o.workspace, first: o.first, after: o.after ?? null })))
    })
  contentCmd
    .command('create')
    .requiredOption('--workspace <id>', 'workspace id')
    .requiredOption('--type <id>', 'content type id')
    .requiredOption('--slug <slug>', 'slug')
    .requiredOption('--data <json>', 'content data JSON')
    .action(async (o: { workspace: string; type: string; slug: string; data: string }) => {
      const domain = createDomain(await resolveCtx())
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
    .option('--expected-revision <id>', 'revision id read before editing')
    .action(async (o: { item: string; data: string; expectedRevision?: string }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.content.update({
        itemId: o.item,
        data: JSON.parse(o.data),
        expectedRevisionId: o.expectedRevision,
      })))
    })
  contentCmd
    .command('list')
    .requiredOption('--workspace <id>', 'workspace id')
    .option('--type <id>', 'content type id')
    .option('--status <status>', 'status')
    .option('--first <n>', 'page size', parsePositiveInteger)
    .option('--after <cursor>', 'page cursor')
    .action(async (o: { workspace: string; type?: string; status?: string; first?: number; after?: string }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.content.list({
        workspaceId: o.workspace,
        contentTypeId: o.type,
        status: o.status,
        first: o.first,
        after: o.after ?? null,
      })))
    })
  contentCmd
    .command('approvals')
    .requiredOption('--workspace <id>', 'workspace id')
    .option('--item <id>', 'content item id')
    .option('--state <state>', 'approval state')
    .option('--first <n>', 'page size', parsePositiveInteger)
    .option('--after <cursor>', 'page cursor')
    .action(async (o: { workspace: string; item?: string; state?: string; first?: number; after?: string }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.content.listApprovals({
        workspaceId: o.workspace,
        itemId: o.item,
        state: o.state as 'pending' | 'approved' | 'rejected' | 'superseded' | undefined,
        first: o.first,
        after: o.after ?? null,
      })))
    })
  contentCmd
    .command('get')
    .requiredOption('--item <id>', 'content item id')
    .action(async (o: { item: string }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.content.getDetail(o.item)))
    })
  contentCmd
    .command('revisions')
    .requiredOption('--item <id>', 'content item id')
    .option('--first <n>', 'page size', parsePositiveInteger)
    .option('--after <cursor>', 'page cursor')
    .action(async (o: { item: string; first?: number; after?: string }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.content.listRevisions({ itemId: o.item, first: o.first, after: o.after ?? null })))
    })
  contentCmd
    .command('published')
    .requiredOption('--item <id>', 'content item id')
    .action(async (o: { item: string }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.content.getPublished(o.item)))
    })
  contentCmd
    .command('submit')
    .requiredOption('--item <id>', 'content item id')
    .action(async (o: { item: string }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.content.submitForApproval({ itemId: o.item })))
    })
  contentCmd
    .command('decide')
    .requiredOption('--approval <id>', 'approval id')
    .requiredOption('--vote <approve|reject>', 'vote')
    .action(async (o: { approval: string; vote: string }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.content.decideApproval({
        approvalId: o.approval,
        vote: o.vote as 'approve' | 'reject',
      })))
    })
  contentCmd
    .command('publish')
    .requiredOption('--item <id>', 'content item id')
    .action(async (o: { item: string }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.content.publish({ itemId: o.item })))
    })
  contentCmd
    .command('unpublish')
    .requiredOption('--item <id>', 'content item id')
    .action(async (o: { item: string }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.content.unpublish({ itemId: o.item })))
    })
  contentCmd
    .command('schedule')
    .requiredOption('--item <id>', 'content item id')
    .requiredOption('--action <publish|unpublish>', 'schedule action')
    .requiredOption('--revision <id>', 'pinned revision id')
    .requiredOption('--run-at <iso>', 'run time')
    .action(async (o: { item: string; action: string; revision: string; runAt: string }) => {
      const domain = createDomain(await resolveCtx())
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
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.content.runSeoAudit({ itemId: o.item })))
    })
  contentCmd
    .command('asset-upload')
    .requiredOption('--workspace <id>', 'workspace id')
    .requiredOption('--filename <name>', 'file name')
    .requiredOption('--mime <mime>', 'MIME type')
    .requiredOption('--size-bytes <n>', 'declared byte size', parsePositiveInteger)
    .action(async (o: { workspace: string; filename: string; mime: string; sizeBytes: number }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.content.issueAssetUpload({
        workspaceId: o.workspace,
        filename: o.filename,
        mime: o.mime,
        sizeBytes: o.sizeBytes,
      })))
    })
  contentCmd
    .command('asset-finalize')
    .requiredOption('--asset <id>', 'asset id')
    .requiredOption('--checksum <sha256>', 'uploaded object checksum')
    .requiredOption('--size-bytes <n>', 'uploaded byte size', parsePositiveInteger)
    .option('--width <n>', 'image width', parsePositiveInteger)
    .option('--height <n>', 'image height', parsePositiveInteger)
    .action(async (o: { asset: string; checksum: string; sizeBytes: number; width?: number; height?: number }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.content.finalizeAsset({
        assetId: o.asset,
        checksum: o.checksum,
        sizeBytes: o.sizeBytes,
        width: o.width,
        height: o.height,
      })))
    })
  contentCmd
    .command('collection-create')
    .requiredOption('--workspace <id>', 'workspace id')
    .requiredOption('--key <key>', 'collection key')
    .requiredOption('--label <label>', 'display label')
    .option('--description <text>', 'description')
    .action(async (o: { workspace: string; key: string; label: string; description?: string }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.content.createCollection({
        workspaceId: o.workspace,
        key: o.key,
        label: o.label,
        description: o.description,
      })))
    })
  contentCmd
    .command('collection-add')
    .requiredOption('--collection <id>', 'collection id')
    .requiredOption('--item <id>', 'content item id')
    .option('--position <n>', 'position', parseNonNegativeInteger)
    .action(async (o: { collection: string; item: string; position?: number }) => {
      const domain = createDomain(await resolveCtx())
      await domain.content.addToCollection({ collectionId: o.collection, itemId: o.item, position: o.position })
      out(JSON.stringify({ ok: true }))
    })
  contentCmd
    .command('collection-reorder')
    .requiredOption('--collection <id>', 'collection id')
    .requiredOption('--items <json>', 'ordered JSON array of content item ids')
    .action(async (o: { collection: string; items: string }) => {
      const orderedItemIds = parseJsonFlag(o.items, [])
      if (!Array.isArray(orderedItemIds) || !orderedItemIds.every((id) => typeof id === 'string')) {
        throw new Error('invalid_item_id_array')
      }
      const domain = createDomain(await resolveCtx())
      await domain.content.reorderCollection({ collectionId: o.collection, orderedItemIds })
      out(JSON.stringify({ ok: true }))
    })
  contentCmd
    .command('link-asset')
    .requiredOption('--item <id>', 'content item id')
    .requiredOption('--asset <id>', 'asset id')
    .action(async (o: { item: string; asset: string }) => {
      const domain = createDomain(await resolveCtx())
      await domain.content.linkAsset({ itemId: o.item, assetId: o.asset })
      out(JSON.stringify({ ok: true }))
    })
  contentCmd
    .command('link-item')
    .requiredOption('--item <id>', 'content item id')
    .requiredOption('--target <id>', 'target content item id')
    .action(async (o: { item: string; target: string }) => {
      const domain = createDomain(await resolveCtx())
      await domain.content.linkItem({ itemId: o.item, targetItemId: o.target })
      out(JSON.stringify({ ok: true }))
    })
  contentCmd
    .command('link-task')
    .requiredOption('--item <id>', 'content item id')
    .requiredOption('--task <id>', 'editorial task id')
    .action(async (o: { item: string; task: string }) => {
      const domain = createDomain(await resolveCtx())
      await domain.content.linkEditorialTask({ itemId: o.item, taskId: o.task })
      out(JSON.stringify({ ok: true }))
    })

  const workflowsCmd = program.command('workflows').description('Manage workflow automation and webhooks')
  workflowsCmd
    .command('events')
    .option('--first <n>', 'page size', parsePositiveInteger)
    .option('--after <cursor>', 'page cursor')
    .action(async (o: { first?: number; after?: string }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.workflows.listEventTypes({ first: o.first, after: o.after ?? null })))
    })

  const workflowRulesCmd = workflowsCmd.command('rules').description('Workflow automation rules')
  workflowRulesCmd
    .command('list')
    .requiredOption('--workspace <id>', 'workspace id')
    .option('--first <n>', 'page size', parsePositiveInteger)
    .option('--after <cursor>', 'page cursor')
    .action(async (o: { workspace: string; first?: number; after?: string }) => {
      const domain = createDomain(await resolveCtx())
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
    .option('--priority <n>', 'rule priority', parseNonNegativeInteger, 100)
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
      const domain = createDomain(await resolveCtx())
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
    .option('--first <n>', 'page size', parsePositiveInteger)
    .option('--after <cursor>', 'page cursor')
    .action(async (o: { workspace: string; first?: number; after?: string }) => {
      const domain = createDomain(await resolveCtx())
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
      const domain = createDomain(await resolveCtx())
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
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.workflows.rotateWebhook({ workspaceId: o.workspace, subscriptionId: o.subscription })))
    })
  workflowWebhookCmd
    .command('activate')
    .requiredOption('--workspace <id>', 'workspace id')
    .requiredOption('--subscription <id>', 'subscription id')
    .action(async (o: { workspace: string; subscription: string }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.workflows.setWebhookActive({ workspaceId: o.workspace, subscriptionId: o.subscription, active: true })))
    })
  workflowWebhookCmd
    .command('deactivate')
    .requiredOption('--workspace <id>', 'workspace id')
    .requiredOption('--subscription <id>', 'subscription id')
    .action(async (o: { workspace: string; subscription: string }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.workflows.setWebhookActive({ workspaceId: o.workspace, subscriptionId: o.subscription, active: false })))
    })

  workflowsCmd
    .command('replay')
    .requiredOption('--workspace <id>', 'workspace id')
    .option('--dead', 'replay dead-lettered automate jobs')
    .action(async (o: { workspace: string; dead?: boolean }) => {
      await jobs.replay({ kind: 'automate', dead: !!o.dead, workspaceId: o.workspace })
    })

  const adminCmd = program.command('admin').description('Workspace administration')
  const ingestKeyCmd = adminCmd.command('ingest-key').description('Ingest API key management')
  ingestKeyCmd
    .command('list')
    .requiredOption('--workspace <id>', 'workspace id')
    .action(async (o: { workspace: string }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.admin.listIngestKeys({ workspaceId: o.workspace })))
    })
  ingestKeyCmd
    .command('create')
    .requiredOption('--workspace <id>', 'workspace id')
    .requiredOption('--label <label>', 'key label')
    .action(async (o: { workspace: string; label: string }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.admin.createIngestKey({ workspaceId: o.workspace, label: o.label })))
    })
  ingestKeyCmd
    .command('rotate')
    .requiredOption('--workspace <id>', 'workspace id')
    .requiredOption('--key <id>', 'key id')
    .action(async (o: { workspace: string; key: string }) => {
      const domain = createDomain(await resolveCtx())
      out(JSON.stringify(await domain.admin.rotateIngestKey({ workspaceId: o.workspace, keyId: o.key })))
    })
  ingestKeyCmd
    .command('revoke')
    .requiredOption('--workspace <id>', 'workspace id')
    .requiredOption('--key <id>', 'key id')
    .action(async (o: { workspace: string; key: string }) => {
      const domain = createDomain(await resolveCtx())
      await domain.admin.revokeIngestKey({ workspaceId: o.workspace, keyId: o.key })
      out(JSON.stringify({ revoked: true }))
    })

  program
    .command('search <query>')
    .requiredOption('--workspace <id>', 'workspace id')
    .option('--mode <mode>', 'fts (direct PG) | semantic | hybrid (via the GraphQL edge)')
    .option('--collection <name>', 'restrict to a collection')
    .option('--limit <n>', 'max hits', parsePositiveInteger)
    .action(async (query: string, o: { workspace: string; mode?: string; collection?: string; limit?: number }) => {
      const ctx = await resolveCtx()
      if (o.mode === 'semantic' || o.mode === 'hybrid') {
        const cfg = loadCliConfig()
        const apiUrl = process.env.SUPABASE_URL ?? cfg?.apiUrl
        if (!apiUrl) throw new Error('SUPABASE_URL is required for semantic/hybrid search (run `movp init`)')
        if (!ctx.accessToken) throw new Error('semantic/hybrid search needs a session token (login with a PAT or set MOVP_ACCESS_TOKEN)')
        out(
          JSON.stringify(
            await searchViaGraphql({
              apiUrl,
              accessToken: ctx.accessToken,
              workspaceId: o.workspace,
              query,
              mode: o.mode,
              collection: o.collection,
              limit: o.limit,
            }),
          ),
        )
        return
      }
      if (o.mode && o.mode !== 'fts') throw new Error(`unknown search mode: ${o.mode}`)
      out(
        JSON.stringify(
          await createDomain(ctx).search({
            workspaceId: o.workspace,
            query,
            mode: 'fts',
            collection: o.collection,
            limit: o.limit,
          }),
        ),
      )
    })

  program
    .command('init')
    .description('Write the CLI config (instance URL, anon key, default workspace)')
    .requiredOption('--api-url <url>', 'instance API URL (SUPABASE_URL)')
    .requiredOption('--anon-key <key>', 'anon/publishable key')
    .option('--workspace <id>', 'default workspace id')
    .action((o: { apiUrl: string; anonKey: string; workspace?: string }) => {
      const path = writeCliConfig({ apiUrl: o.apiUrl, anonKey: o.anonKey, defaultWorkspaceId: o.workspace })
      out(JSON.stringify({ ok: true, config: path }))
    })

  program
    .command('login')
    .description('Read a Personal Access Token from stdin, validate it, and store it securely')
    .action(async () => {
      const pat = (await readLoginToken()).trim()
      if (!pat.startsWith('movp_pat_')) throw new Error('a movp_pat_… token is required')
      const cfg = loadCliConfig()
      const apiUrl = process.env.SUPABASE_URL ?? cfg?.apiUrl
      const anonKey = process.env.SUPABASE_ANON_KEY ?? cfg?.anonKey
      if (!apiUrl || !anonKey) throw new Error('run `movp init` first (apiUrl/anonKey missing)')
      // exchangePat throws the stable code ('invalid_token'|'expired_token') on reject, so a
      // bad PAT is never stored. NEVER print `pat` — only the non-secret metadata below.
      const ex = await exchangePat(pat, apiUrl, anonKey)
      selectSecureStore(apiUrl).save({ pat, session: { access_token: ex.access_token, expires_at: ex.expires_at } })
      out(JSON.stringify({ ok: true, user_id: ex.user_id, default_workspace_id: ex.default_workspace_id }))
    })

  program
    .command('logout')
    .description('Clear the stored PAT and cached session')
    .action(() => {
      const cfg = loadCliConfig()
      const apiUrl = process.env.SUPABASE_URL ?? cfg?.apiUrl
      if (!apiUrl) throw new Error('run `movp init` first (apiUrl missing)')
      selectSecureStore(apiUrl).clear()
      out(JSON.stringify({ ok: true }))
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
