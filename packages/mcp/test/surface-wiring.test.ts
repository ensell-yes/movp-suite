import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { defineCollection, defineSchema, genericWriteMode, schema } from '@movp/core-schema'
import { createDomain } from '@movp/domain'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { buildProgram } from '../../cli/src/program.ts'
import { buildSchema } from '../../graphql/src/schema.ts'
import { buildMcpServer } from '../src/server.ts'

function pascal(name: string): string {
  return name
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')
}

function plural(name: string): string {
  if (/[bcdfghjklmnpqrstvwxyz]y$/i.test(name)) return `${name.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/i.test(name)) return `${name}es`
  return `${name}s`
}

function surfaceDiff(
  actual: ReadonlySet<string>,
  expected: ReadonlySet<string>,
): { missing: string[]; unexpected: string[] } {
  return {
    missing: [...expected].filter((name) => !actual.has(name)).sort(),
    unexpected: [...actual].filter((name) => !expected.has(name)).sort(),
  }
}

const db = {} as SupabaseClient
const surfaceSchema = defineSchema({
  extends: schema,
  collections: [
    defineCollection({
      name: 'surface_widget',
      label: 'Surface widget',
      labelPlural: 'Surface widgets',
      workspaceScoped: true,
      fields: {
        title: { type: 'text', label: 'Title', required: true },
        settings: { type: 'json', label: 'Settings', required: true },
      },
    }),
    defineCollection({
      name: 'surface_secret',
      label: 'Surface secret',
      labelPlural: 'Surface secrets',
      workspaceScoped: true,
      internal: true,
      fields: {},
    }),
  ],
})
const publicCollections = surfaceSchema.collections.filter((collection) => collection.internal !== true)
const internalCollections = surfaceSchema.collections.filter((collection) => collection.internal === true)
const customMcpTools = [
  'admin.ingest_key.create',
  'admin.ingest_key.list',
  'admin.ingest_key.revoke',
  'admin.ingest_key.rotate',
  'comment.add',
  'content.add_to_collection',
  'content.create',
  'content.create_collection',
  'content.create_type',
  'content.decide_approval',
  'content.finalize_asset',
  'content.get',
  'content.get_detail',
  'content.get_published',
  'content.issue_asset_upload',
  'content.link_asset',
  'content.link_editorial_task',
  'content.link_item',
  'content.list',
  'content.list_approvals',
  'content.list_revisions',
  'content.list_types',
  'content.publish',
  'content.reorder_collection',
  'content.run_seo_audit',
  'content.schedule',
  'content.submit_for_approval',
  'content.unpublish',
  'content.update',
  'inbox.list',
  'reaction.toggle',
  'save.toggle',
  'share.create',
  'task.add_dependency',
  'task.add_observer',
  'task.assign',
  'task.attach',
  'task.board',
  'task.create',
  'task.get',
  'task.get_detail',
  'task.list',
  'task.remove_dependency',
  'task.remove_observer',
  'task.transition',
  'task.unassign',
  'task.update_description',
  'workflow.event_types',
  'workflow.jobs.replay_dead',
  'workflow.rules.list',
  'workflow.rules.upsert',
  'workflow.runs.list',
  'workflow.webhook.active',
  'workflow.webhook.register',
  'workflow.webhook.rotate',
] as const
const customGraphqlQueries = [
  'automationRules',
  'campaignDetail',
  'collectionsMeta',
  'comments',
  'content',
  'contentApprovals',
  'contentItem',
  'contentRevisions',
  'contentTypes',
  'deadJobs',
  'deliverableSchedule',
  'deliverableSchedules',
  'eventTypes',
  'inbox',
  'ingestKeys',
  'jobCounts',
  'personalAccessTokens',
  'previewMatchingCount',
  'publishedContent',
  'reportingCampaignMetrics',
  'reportingContentFunnel',
  'reportingEventDailyCounts',
  'reportingIngestVolume',
  'reportingJobDailyCounts',
  'reportingSegmentGrowth',
  'reportingTaskThroughput',
  'reportingWorkflowHealth',
  'search',
  'segmentMembers',
  'segmentMembershipExplained',
  'segmentSnapshots',
  'segmentSummaries',
  'snapshotDiff',
  'task',
  'taskBoard',
  'tasks',
  'workflowEvent',
  'workspaceMembers',
  'workspaceSettings',
] as const
const customGraphqlMutations = [
  'acceptInvite',
  'addComment',
  'addTaskDependency',
  'addTaskObserver',
  'addToCollection',
  'assignTask',
  'attachTask',
  'createContent',
  'createContentCollection',
  'createContentType',
  'createIngestKey',
  'createPersonalAccessToken',
  'createSegmentRuleVersion',
  'createShareLink',
  'createTask',
  'createWorkspace',
  'decideApproval',
  'finalizeAsset',
  'inviteMember',
  'issueAssetUpload',
  'publishContent',
  'registerWebhookSubscription',
  'removeMember',
  'replayDeadJobs',
  'replayDeadWorkflowJobs',
  'resolveShareLink',
  'revokeIngestKey',
  'revokePersonalAccessToken',
  'rotateIngestKey',
  'rotateWebhookSecret',
  'runSeoAudit',
  'scheduleContent',
  'setMemberRole',
  'setWebhookActive',
  'setWebhookFilter',
  'submitForApproval',
  'toggleReaction',
  'toggleSave',
  'transitionTask',
  'unassignTask',
  'unpublishContent',
  'updateContent',
  'updateTaskDescription',
  'upsertAutomationRule',
] as const
const customCliCommands = [
  'admin',
  'codegen',
  'comment',
  'content',
  'inbox',
  'init',
  'jobs',
  'login',
  'logout',
  'migrate',
  'new-delta',
  'search',
  'task',
  'verify-schema-runtime',
  'workflows',
] as const

const expectedMcpTools = new Set([
  ...customMcpTools,
  ...publicCollections.flatMap((collection) => {
    const operations = ['get', 'list', 'search', 'link']
    const writeMode = genericWriteMode(collection)
    if (writeMode !== 'none') operations.push('create')
    if (writeMode === 'crud') operations.push('update')
    return operations.map((operation) => `${collection.name}.${operation}`)
  }),
])
const expectedGraphqlQueries = new Set([
  ...customGraphqlQueries,
  ...publicCollections.flatMap((collection) => [collection.name, plural(collection.name)]),
])
const expectedGraphqlMutations = new Set([
  ...customGraphqlMutations,
  ...publicCollections.flatMap((collection) => {
    const mutations: string[] = []
    const writeMode = genericWriteMode(collection)
    if (writeMode !== 'none') mutations.push(`create${pascal(collection.name)}`)
    if (writeMode === 'crud') mutations.push(`update${pascal(collection.name)}`)
    return mutations
  }),
])
const expectedCliCommands = new Set([
  ...customCliCommands,
  ...publicCollections.map((collection) => collection.name),
])

describe('real-schema generic surface wiring', () => {
  it('resolves every public collection through the real domain registry', () => {
    const domain = createDomain({ db, userId: 'user-1' }, { schema: surfaceSchema })
    for (const collection of publicCollections) {
      expect(() => domain.collection(collection.name)).not.toThrow()
    }
    for (const collection of internalCollections) {
      expect(() => domain.collection(collection.name)).toThrow(/no domain service for collection/)
    }
    expect(domain.collection('campaign')).toBe(domain.campaign)
  })

  it('exposes every public collection through MCP without a mocked domain', async () => {
    const client = new Client({ name: 'surface-wiring', version: '0.0.0' })
    const server = buildMcpServer(surfaceSchema, { db, userId: 'user-1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const names = new Set((await client.listTools()).tools.map((tool) => tool.name))

    expect(surfaceDiff(names, expectedMcpTools)).toEqual({ missing: [], unexpected: [] })
  })

  it('exposes only stored relation ids and preserves required JSON inputs', async () => {
    const client = new Client({ name: 'surface-inputs', version: '0.0.0' })
    const server = buildMcpServer(surfaceSchema, { db, userId: 'user-1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const tools = (await client.listTools()).tools
    const create = tools.find((tool) => tool.name === 'campaign_metric.create')
    const update = tools.find((tool) => tool.name === 'campaign.update')
    const widgetCreate = tools.find((tool) => tool.name === 'surface_widget.create')
    const noteCreate = tools.find((tool) => tool.name === 'note.create')
    const noteUpdate = tools.find((tool) => tool.name === 'note.update')

    expect(create?.inputSchema.required).toEqual(expect.arrayContaining(['workspace_id', 'campaign_id']))
    expect(create?.inputSchema.properties).toMatchObject({
      campaign_id: { type: 'string' },
      value: { type: 'number' },
    })
    expect(update?.inputSchema.required).toEqual(['id'])
    expect(update?.inputSchema.properties).toMatchObject({
      id: { type: 'string' },
      marketing_plan_id: { type: 'string' },
      rank: { type: 'number' },
    })
    expect(widgetCreate?.inputSchema.required).toEqual(
      expect.arrayContaining(['workspace_id', 'title', 'settings']),
    )
    expect(widgetCreate?.inputSchema.properties?.settings).not.toEqual({})
    expect(noteCreate?.inputSchema.properties).not.toHaveProperty('tags_id')
    expect(noteCreate?.inputSchema.properties).not.toHaveProperty('tags')
    expect(noteUpdate?.inputSchema.properties).not.toHaveProperty('tags_id')
    expect(noteUpdate?.inputSchema.properties).not.toHaveProperty('tags')
    expect(tools.some((tool) => tool.name === 'campaign_metric.update')).toBe(false)
    expect(tools.some((tool) => tool.name === 'segment_snapshot.create')).toBe(false)
  })

  it('rejects an MCP update with no fields before reaching the database', async () => {
    const client = new Client({ name: 'surface-empty-update', version: '0.0.0' })
    const server = buildMcpServer(surfaceSchema, { db, userId: 'user-1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const result = await client.callTool({ name: 'campaign.update', arguments: { id: 'campaign-1' } })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('no_update_fields')
  })

  it('exposes every public collection through GraphQL and CLI', () => {
    const graphql = buildSchema(surfaceSchema)
    const queries = graphql.getQueryType()?.getFields() ?? {}
    const mutations = graphql.getMutationType()?.getFields() ?? {}
    const cliProgram = buildProgram(surfaceSchema)

    expect(surfaceDiff(new Set(Object.keys(queries)), expectedGraphqlQueries))
      .toEqual({ missing: [], unexpected: [] })
    expect(surfaceDiff(new Set(Object.keys(mutations)), expectedGraphqlMutations))
      .toEqual({ missing: [], unexpected: [] })
    expect(surfaceDiff(
      new Set(cliProgram.commands.map((command) => command.name())),
      expectedCliCommands,
    )).toEqual({ missing: [], unexpected: [] })

    const widgetCreate = cliProgram.commands
      .find((command) => command.name() === 'surface_widget')
      ?.commands.find((command) => command.name() === 'create')
    const noteCreate = cliProgram.commands
      .find((command) => command.name() === 'note')
      ?.commands.find((command) => command.name() === 'create')
    expect(widgetCreate?.options.find((option) => option.long === '--settings')?.mandatory).toBe(true)
    expect(noteCreate?.options.map((option) => option.long)).not.toContain('--tags_id')
    expect(noteCreate?.options.map((option) => option.long)).not.toContain('--tags')
  })

  it('detects bespoke internal registrations outside the generic loops', () => {
    expect(surfaceDiff(new Set([...expectedMcpTools, 'asset.get']), expectedMcpTools).unexpected)
      .toEqual(['asset.get'])
    expect(surfaceDiff(
      new Set([...expectedGraphqlQueries, 'assetById']),
      expectedGraphqlQueries,
    ).unexpected).toEqual(['assetById'])
    expect(surfaceDiff(
      new Set([...expectedGraphqlMutations, 'deleteAsset']),
      expectedGraphqlMutations,
    ).unexpected).toEqual(['deleteAsset'])
    expect(surfaceDiff(new Set([...expectedCliCommands, 'asset']), expectedCliCommands).unexpected)
      .toEqual(['asset'])
  })
})
