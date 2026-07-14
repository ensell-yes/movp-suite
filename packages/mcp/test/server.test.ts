import { describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { schema } from '@movp/core-schema'
import { createDomain } from '@movp/domain'
import { buildMcpServer } from '../src/index.ts'

const created = { id: 'n1', workspace_id: 'w', title: 'Hello' }
const search = vi.fn(async () => [{ collection: 'note', id: 'n1', title: 'Hello', snippet: 'Hello', score: 1 }])
const commentAdd = vi.fn(async () => ({ id: 'c1', body: 'hi' }))
const inbox = vi.fn(async () => [
  { kind: 'user.mentioned', entity_type: 'note', entity_id: 'n1', ref_id: 'm1', created_at: 't', payload: {} },
])
const taskCreate = vi.fn(async () => ({ id: 't1', title: 'Ship it', status_id: 's1' }))
const taskList = vi.fn(async () => ({ items: [{ id: 't1' }], nextCursor: 'next-task' }))
const taskBoard = vi.fn(async () => [{ status: { id: 's1', label: 'Todo' }, tasks: [{ id: 't1' }] }])
const taskDetail = vi.fn(async () => ({ task: { id: 't1' }, description: 'Ship it', assignments: [], observers: [], dependencies: [], attachments: [] }))
const contentCreate = vi.fn(async () => ({ id: 'ci1', slug: 'hello', status: 'draft' }))
const contentUpdate = vi.fn(async () => ({ id: 'ci1', current_revision_id: 'r2' }))
const contentPublish = vi.fn(async () => ({ id: 'ci1', status: 'published' }))
const contentDetail = vi.fn(async () => ({ item: { id: 'ci1' }, type: { id: 'ct1' }, currentRevision: { id: 'r2', data: { headline: 'Hi' } } }))
const contentIssueAsset = vi.fn(async () => ({ uploadUrl: 'https://r2/put', assetId: 'a1', r2Key: 'w/a1' }))
const campaignLinkTask = vi.fn(async () => undefined)
const campaignDeliverableSchedules = vi.fn(async () => [])
const workflowListEventTypes = vi.fn(async () => ({ items: [{ id: 'evt1', key: 'task.completed' }], nextCursor: null }))
const workflowListRules = vi.fn(async () => ({ items: [{ id: 'rule1', action_type: 'notify' }], nextCursor: null }))
const workflowUpsertRule = vi.fn(async () => ({ id: 'rule1', action_type: 'notify' }))
const workflowRegisterWebhook = vi.fn(async () => ({ subscriptionId: 'sub1', secret: 's'.repeat(64) }))
const workflowRotateWebhook = vi.fn(async () => ({ subscriptionId: 'sub1', secret: 'r'.repeat(64) }))
const workflowSetWebhookActive = vi.fn(async () => ({ id: 'sub1', active: false, secret_set: true }))
const adminListIngestKeys = vi.fn(async () => [{ id: 'key1', label: 'ci', active: true, created_at: 't' }])
const adminCreateIngestKey = vi.fn(async () => ({ keyId: 'key1', rawKey: 'a'.repeat(48) }))
const adminRotateIngestKey = vi.fn(async () => ({ keyId: 'key1', rawKey: 'b'.repeat(48) }))
const adminRevokeIngestKey = vi.fn(async () => undefined)

function crud() {
  return {
    create: vi.fn(async () => created),
    get: vi.fn(async () => created),
    list: vi.fn(async () => ({ items: [created], nextCursor: null })),
    update: vi.fn(),
    delete: vi.fn(),
  }
}

vi.mock('@movp/domain', () => ({
  createDomain: vi.fn(() => ({
    event_type: crud(),
    external_record: crud(),
    note: crud(),
    tag: crud(),
    marketing_plan: crud(),
    task_status_option: crud(),
    task_priority_option: crud(),
    campaign_channel: crud(),
    campaign_deliverable: crud(),
    campaign_calendar_event: crud(),
    campaign_metric: crud(),
    campaign_segment: crud(),
    platform_event: crud(),
    segment: crud(),
    segment_rule: crud(),
    segment_membership: crud(),
    segment_snapshot: crud(),
    segment_snapshot_member: crud(),
    segment_recompute_run: crud(),
    automation_rule: crud(),
    webhook_subscription: crud(),
    workflow_run: crud(),
    workflows: {
      listEventTypes: workflowListEventTypes,
      listRules: workflowListRules,
      upsertRule: workflowUpsertRule,
      getEvent: vi.fn(),
      registerWebhook: workflowRegisterWebhook,
      rotateWebhook: workflowRotateWebhook,
      setWebhookActive: workflowSetWebhookActive,
      setWebhookFilter: vi.fn(),
    },
    admin: {
      listIngestKeys: adminListIngestKeys,
      createIngestKey: adminCreateIngestKey,
      rotateIngestKey: adminRotateIngestKey,
      revokeIngestKey: adminRevokeIngestKey,
    },
    search,
    graph: { link: vi.fn(async () => undefined), traverse: vi.fn() },
    collab: {
      comment: { create: commentAdd, listByEntity: vi.fn() },
      react: vi.fn(async () => undefined),
      unreact: vi.fn(async () => undefined),
      save: vi.fn(async () => undefined),
      unsave: vi.fn(async () => undefined),
      createShareLink: vi.fn(async () => ({ token: 'raw-token' })),
      inbox,
    },
    task: {
      create: taskCreate,
      get: vi.fn(async () => ({ id: 't1' })),
      getDetail: taskDetail,
      list: taskList,
      board: taskBoard,
      assign: vi.fn(async () => undefined),
      unassign: vi.fn(),
      addObserver: vi.fn(),
      removeObserver: vi.fn(),
      transition: vi.fn(async () => ({ id: 't1', status_id: 's2' })),
      addDependency: vi.fn(async () => undefined),
      removeDependency: vi.fn(),
      updateDescription: vi.fn(async () => ({ id: 't1' })),
      attach: vi.fn(),
    },
    content: {
      createType: vi.fn(async () => ({ id: 'ct1', key: 'article' })),
      create: contentCreate,
      update: contentUpdate,
      get: vi.fn(async () => ({ id: 'ci1' })),
      getDetail: contentDetail,
      list: vi.fn(async () => ({ items: [{ id: 'ci1' }], nextCursor: null })),
      listTypes: vi.fn(async () => ({ items: [{ id: 'ct1' }], nextCursor: null })),
      listRevisions: vi.fn(async () => ({ items: [{ id: 'r1' }], nextCursor: null })),
      listApprovals: vi.fn(async () => ({ items: [{ id: 'ap1' }], nextCursor: null })),
      submitForApproval: vi.fn(async () => ({ id: 'ci1', status: 'in_review' })),
      decideApproval: vi.fn(async () => ({ id: 'ap1', content_item_id: 'ci1', state: 'approved', approved_revision_id: 'r2' })),
      publish: contentPublish,
      unpublish: vi.fn(async () => ({ id: 'ci1', status: 'draft' })),
      getPublished: vi.fn(async () => ({ item: { id: 'ci1' }, revision: { id: 'r2', data: { headline: 'v2' }, content_hash: 'h2' } })),
      schedule: vi.fn(async () => ({ id: 'sch1', content_item_id: 'ci1', revision_id: 'r2', action: 'publish', state: 'scheduled' })),
      runSeoAudit: vi.fn(async () => ({ score: 88, checklist: [{ rule: 'title_length', pass: true }] })),
      issueAssetUpload: contentIssueAsset,
      finalizeAsset: vi.fn(async () => ({ id: 'a1', r2_key: 'w/a1', mime: 'image/png', size_bytes: 10 })),
      createCollection: vi.fn(),
      addToCollection: vi.fn(),
      reorderCollection: vi.fn(),
      linkAsset: vi.fn(),
      linkItem: vi.fn(),
      linkEditorialTask: vi.fn(),
    },
    campaign: {
      ...crud(),
      linkTask: campaignLinkTask,
      linkContent: vi.fn(async () => undefined),
      linkSegment: vi.fn(async () => undefined),
      addObserver: vi.fn(async () => undefined),
      deliverableSchedule: vi.fn(async () => null),
      deliverableSchedules: campaignDeliverableSchedules,
    },
  })),
}))

describe('buildMcpServer', () => {
  it('lists generated tools and calls note create/search', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' })
    const server = buildMcpServer(schema, { db: {} as never, userId: 'u' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const tools = await client.listTools()
    expect(tools.tools.map((t) => t.name)).toEqual(expect.arrayContaining([
      'external_record.create',
      'note.create',
      'note.search',
      'tag.create',
    ]))

    const externalRecordRes = await client.callTool({
      name: 'external_record.create',
      arguments: { workspace_id: 'w', source: 'hubspot', external_id: 'contact-1' },
    })
    expect(JSON.stringify(externalRecordRes.content)).toContain('Hello')

    const createRes = await client.callTool({
      name: 'note.create',
      arguments: { workspace_id: 'w', title: 'Hello' },
    })
    expect(JSON.stringify(createRes.content)).toContain('Hello')

    const searchRes = await client.callTool({
      name: 'note.search',
      arguments: { workspaceId: 'w', query: 'Hello' },
    })
    expect(JSON.stringify(searchRes.content)).toContain('n1')
  })

  it('registers and calls the collab tools', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' })
    const server = buildMcpServer(schema, { db: {} as never, userId: 'u' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(['inbox.list', 'comment.add', 'reaction.toggle', 'save.toggle', 'share.create']))
    expect(names).not.toContain('comment.create')
    expect(names).not.toContain('mention.create')
    expect(names).not.toContain('reaction.create')
    expect(names).not.toContain('saved_item.create')
    expect(names).not.toContain('share_link.create')

    const addRes = await client.callTool({
      name: 'comment.add',
      arguments: { entityType: 'note', entityId: 'n1', body: 'hi', mentions: ['u2'] },
    })
    expect(commentAdd).toHaveBeenCalledWith({
      entityType: 'note',
      entityId: 'n1',
      body: 'hi',
      parentId: undefined,
      mentions: ['u2'],
    })
    expect(JSON.stringify(addRes.content)).toContain('c1')

    const inboxRes = await client.callTool({ name: 'inbox.list', arguments: { workspaceId: 'w', tab: 'mentions' } })
    expect(inbox).toHaveBeenCalledWith({ workspaceId: 'w', tab: 'mentions', first: undefined })
    expect(JSON.stringify(inboxRes.content)).toContain('user.mentioned')
  })

  it('registers and calls the custom task tools', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' })
    const server = buildMcpServer(schema, { db: {} as never, userId: 'u' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining([
      'task.create',
      'task.get',
      'task.get_detail',
      'task.list',
      'task.board',
      'task.assign',
      'task.unassign',
      'task.add_observer',
      'task.remove_observer',
      'task.transition',
      'task.add_dependency',
      'task.remove_dependency',
      'task.update_description',
      'task.attach',
    ]))
    expect(names).not.toContain('task_revision.create')
    expect(names).toEqual(expect.arrayContaining(['task_status_option.create', 'task_priority_option.create']))

    const createRes = await client.callTool({ name: 'task.create', arguments: { workspaceId: 'w', title: 'Ship it' } })
    expect(taskCreate).toHaveBeenCalledWith({
      workspaceId: 'w',
      title: 'Ship it',
      description: undefined,
      statusId: undefined,
      priorityId: undefined,
      parentId: undefined,
      startDate: undefined,
      dueDate: undefined,
      idempotencyKey: undefined,
    })
    expect(JSON.stringify(createRes.content)).toContain('t1')
    expect(createRes.structuredContent).toEqual({ result: { id: 't1', title: 'Ship it', status_id: 's1' } })

    const detailRes = await client.callTool({ name: 'task.get_detail', arguments: { id: 't1' } })
    expect(taskDetail).toHaveBeenCalledWith('t1')
    expect(JSON.stringify(detailRes.structuredContent)).toContain('Ship it')

    await client.callTool({
      name: 'task.list',
      arguments: { workspaceId: 'w', topLevel: true, first: 10, after: 'task-cursor' },
    })
    expect(taskList).toHaveBeenCalledWith({
      workspaceId: 'w',
      statusId: undefined,
      assigneeId: undefined,
      parentId: null,
      first: 10,
      after: 'task-cursor',
    })

    const conflictingFilter = await client.callTool({
      name: 'task.list',
      arguments: { workspaceId: 'w', topLevel: true, parentId: 'parent-1' },
    })
    expect(conflictingFilter.isError).toBe(true)
    expect(JSON.stringify(conflictingFilter.content)).toContain('invalid_parent_filter')

    const boardRes = await client.callTool({ name: 'task.board', arguments: { workspaceId: 'w' } })
    expect(taskBoard).toHaveBeenCalledWith({ workspaceId: 'w' })
    expect(JSON.stringify(boardRes.content)).toContain('s1')
  })

  it('registers and calls the custom content tools', async () => {
    vi.mocked(createDomain).mockClear()
    const client = new Client({ name: 'test', version: '0.0.0' })
    const server = buildMcpServer(schema, {
      db: {} as never,
      userId: 'u',
      accessToken: 'test',
      assetsFnUrl: 'http://localhost:54321/functions/v1/content-assets',
    })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining([
      'content.create_type',
      'content.list_types',
      'content.create',
      'content.update',
      'content.get',
      'content.get_detail',
      'content.list',
      'content.list_revisions',
      'content.get_published',
      'content.submit_for_approval',
      'content.decide_approval',
      'content.publish',
      'content.unpublish',
      'content.schedule',
      'content.run_seo_audit',
      'content.issue_asset_upload',
      'content.finalize_asset',
      'content.list_approvals',
      'content.create_collection',
      'content.add_to_collection',
      'content.reorder_collection',
      'content.link_asset',
      'content.link_item',
      'content.link_editorial_task',
    ]))
    expect(names).not.toContain('content_item.create')
    expect(names).not.toContain('content_revision.create')
    expect((await client.listTools()).tools.find((tool) => tool.name === 'content.get_detail')?.outputSchema).toBeUndefined()

    const emptySchema = await client.callTool({
      name: 'content.create_type',
      arguments: { workspaceId: 'w', key: 'empty', label: 'Empty', fieldSchema: '' },
    })
    expect(emptySchema.isError).toBe(true)
    expect(JSON.stringify(emptySchema.content)).toContain('invalid_json')

    const emptyData = await client.callTool({
      name: 'content.create',
      arguments: { workspaceId: 'w', contentTypeId: 'ct1', slug: 'empty', data: '   ' },
    })
    expect(emptyData.isError).toBe(true)
    expect(JSON.stringify(emptyData.content)).toContain('invalid_json')

    const createRes = await client.callTool({
      name: 'content.create',
      arguments: { workspaceId: 'w', contentTypeId: 'ct1', slug: 'hello', data: '{"headline":"Hi"}' },
    })
    expect(contentCreate).toHaveBeenCalledWith({ workspaceId: 'w', contentTypeId: 'ct1', slug: 'hello', data: { headline: 'Hi' } })
    expect(JSON.stringify(createRes.content)).toContain('ci1')

    await client.callTool({
      name: 'content.create_type',
      arguments: {
        workspaceId: 'w',
        key: 'article',
        label: 'Article',
        fieldSchema: [{ name: 'headline', type: 'text', required: true }],
        moderationPolicy: 'pre',
        approvalPolicy: 'single',
      },
    })
    const domain = vi.mocked(createDomain).mock.results.at(-1)?.value
    expect(domain?.content.createType).toHaveBeenCalledWith({
      workspaceId: 'w',
      key: 'article',
      label: 'Article',
      fieldSchema: [{ name: 'headline', type: 'text', required: true }],
      moderationPolicy: 'pre',
      approvalPolicy: 'single',
    })

    await client.callTool({
      name: 'content.create',
      arguments: { workspaceId: 'w', contentTypeId: 'ct1', slug: 'structured', data: { headline: 'Structured' } },
    })
    expect(contentCreate).toHaveBeenLastCalledWith({
      workspaceId: 'w',
      contentTypeId: 'ct1',
      slug: 'structured',
      data: { headline: 'Structured' },
    })

    await client.callTool({
      name: 'content.update',
      arguments: { id: 'ci1', data: { headline: 'Updated' }, expectedRevisionId: 'r1' },
    })
    expect(contentUpdate).toHaveBeenCalledWith({
      itemId: 'ci1',
      data: { headline: 'Updated' },
      expectedRevisionId: 'r1',
    })

    const detailRes = await client.callTool({ name: 'content.get_detail', arguments: { id: 'ci1' } })
    expect(contentDetail).toHaveBeenCalledWith('ci1')
    expect(JSON.stringify(detailRes.structuredContent)).toContain('headline')

    const publishedRes = await client.callTool({ name: 'content.get_published', arguments: { id: 'ci1' } })
    expect(JSON.stringify(publishedRes.structuredContent)).toContain('headline')

    const publishRes = await client.callTool({ name: 'content.publish', arguments: { itemId: 'ci1' } })
    expect(contentPublish).toHaveBeenCalledWith({ itemId: 'ci1' })
    expect(JSON.stringify(publishRes.content)).toContain('published')

    const assetRes = await client.callTool({
      name: 'content.issue_asset_upload',
      arguments: { workspaceId: 'w', filename: 'x.png', mime: 'image/png', sizeBytes: 10 },
    })
    expect(contentIssueAsset).toHaveBeenCalledWith({ workspaceId: 'w', filename: 'x.png', mime: 'image/png', sizeBytes: 10 })
    expect(JSON.stringify(assetRes.content)).toContain('r2/put')
    expect(vi.mocked(createDomain)).toHaveBeenCalledWith(
      expect.objectContaining({ accessToken: 'test', assetsFnUrl: 'http://localhost:54321/functions/v1/content-assets' }),
      expect.anything(),
    )
  })

  it('registers workflow tools and only returns secrets from register/rotate', async () => {
    const client = new Client({ name: 'test', version: '0.0.0' })
    const rpc = vi.fn(async () => ({ data: 2, error: null }))
    const server = buildMcpServer(schema, { db: { rpc } as never, userId: 'u' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining([
      'workflow.event_types',
      'workflow.rules.list',
      'workflow.rules.upsert',
      'workflow.runs.list',
      'workflow.webhook.register',
      'workflow.webhook.rotate',
      'workflow.webhook.active',
      'workflow.jobs.replay_dead',
      'admin.ingest_key.list',
      'admin.ingest_key.create',
      'admin.ingest_key.rotate',
      'admin.ingest_key.revoke',
    ]))

    await client.callTool({ name: 'workflow.event_types', arguments: { first: 5 } })
    expect(workflowListEventTypes).toHaveBeenCalledWith({ first: 5, after: null })

    await client.callTool({
      name: 'workflow.rules.upsert',
      arguments: {
        workspaceId: 'w',
        triggerEventTypeId: 'evt1',
        condition: '{"field":"event"}',
        actionType: 'notify',
        actionConfig: '{"recipient_user_id":"u"}',
        enabled: true,
        priority: 1,
      },
    })
    expect(workflowUpsertRule).toHaveBeenCalledWith(expect.objectContaining({
      condition: { field: 'event' },
      actionConfig: { recipient_user_id: 'u' },
    }))

    const registered = await client.callTool({
      name: 'workflow.webhook.register',
      arguments: { workspaceId: 'w', eventKey: 'task.completed', url: 'https://hooks.example.test/workflows' },
    })
    expect(JSON.stringify(registered.content)).toContain('s'.repeat(64))

    const active = await client.callTool({
      name: 'workflow.webhook.active',
      arguments: { workspaceId: 'w', subscriptionId: 'sub1', active: false },
    })
    expect(JSON.stringify(active.content)).not.toContain('s'.repeat(64))

    const replay = await client.callTool({
      name: 'workflow.jobs.replay_dead',
      arguments: { workspaceId: 'w' },
    })
    const replayContent = replay.content as Array<{ type: 'text'; text: string }>
    expect(JSON.parse(replayContent[0]!.text)).toEqual({ replayed: 2 })
    expect(rpc).toHaveBeenCalledWith('replay_workflow_jobs', { ws: 'w', only_dead: true })

    const listed = await client.callTool({ name: 'admin.ingest_key.list', arguments: { workspaceId: 'w' } })
    expect(adminListIngestKeys).toHaveBeenCalledWith({ workspaceId: 'w' })
    expect(JSON.stringify(listed.content)).not.toContain('rawKey')
    expect(JSON.stringify(listed.content)).not.toContain('key_hash')

    const created = await client.callTool({
      name: 'admin.ingest_key.create',
      arguments: { workspaceId: 'w', label: 'ci' },
    })
    expect(adminCreateIngestKey).toHaveBeenCalledWith({ workspaceId: 'w', label: 'ci' })
    expect(JSON.stringify(created.content)).toContain('key1')
    expect(JSON.stringify(created.content)).not.toContain('a'.repeat(48))
    expect(JSON.stringify(created.content)).not.toContain('rawKey')

    const rotated = await client.callTool({
      name: 'admin.ingest_key.rotate',
      arguments: { workspaceId: 'w', keyId: 'key1' },
    })
    expect(adminRotateIngestKey).toHaveBeenCalledWith({ workspaceId: 'w', keyId: 'key1' })
    expect(JSON.stringify(rotated.content)).toContain('key1')
    expect(JSON.stringify(rotated.content)).not.toContain('b'.repeat(48))
    expect(JSON.stringify(rotated.content)).not.toContain('rawKey')

    const revoked = await client.callTool({
      name: 'admin.ingest_key.revoke',
      arguments: { workspaceId: 'w', keyId: 'key1' },
    })
    expect(adminRevokeIngestKey).toHaveBeenCalledWith({ workspaceId: 'w', keyId: 'key1' })
    expect(JSON.stringify(revoked.content)).toContain('revoked')
  })
})
