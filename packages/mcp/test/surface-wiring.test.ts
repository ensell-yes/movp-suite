import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { defineCollection, defineSchema, schema } from '@movp/core-schema'
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
      fields: { title: { type: 'text', label: 'Title', required: true } },
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
  ...publicCollections.flatMap((collection) =>
    ['create', 'get', 'list', 'search', 'link'].map((operation) => `${collection.name}.${operation}`),
  ),
])
const expectedGraphqlQueries = new Set([
  ...customGraphqlQueries,
  ...publicCollections.flatMap((collection) => [collection.name, plural(collection.name)]),
])
const expectedGraphqlMutations = new Set([
  ...customGraphqlMutations,
  ...publicCollections.flatMap((collection) => [
    `create${pascal(collection.name)}`,
    `update${pascal(collection.name)}`,
  ]),
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
