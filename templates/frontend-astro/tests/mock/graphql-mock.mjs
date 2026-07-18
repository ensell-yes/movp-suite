import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 4322)
let fallbackScenario = 'ok'
const scenarios = new Map()
const counts = new Map()

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function scenarioFor(req) {
  const auth = String(req.headers.authorization ?? '')
  const match = auth.match(/^Bearer\s+(.+)$/i)
  return match ? scenarios.get(match[1]) ?? fallbackScenario : fallbackScenario
}

function tokenFor(req) {
  const auth = String(req.headers.authorization ?? '')
  return auth.match(/^Bearer\s+(.+)$/i)?.[1] ?? 'fallback'
}

function bump(token, key) {
  const current = counts.get(token) ?? {}
  current[key] = (current[key] ?? 0) + 1
  counts.set(token, current)
}

const notes = [
  {
    id: 'n1',
    title: 'First note',
    body: 'Body text',
    status: 'draft',
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
  },
]
const tasks = [
  {
    id: 't1',
    title: 'Ship task',
    status_id: 's1',
    priority_id: 'p1',
    parent_id: null,
    description: 'Task body text',
    due_date: '2026-07-10',
    dependency_blocked: false,
    completed_at: null,
  },
  {
    id: 't2',
    title: 'Write subtask',
    status_id: 's1',
    priority_id: 'p1',
    parent_id: 't1',
    description: 'Subtask body',
    due_date: null,
    dependency_blocked: false,
    completed_at: null,
  },
  {
    id: 'task-1',
    title: 'Campaign launch task',
    status_id: 's1',
    priority_id: 'p1',
    parent_id: null,
    description: 'Backs the launch email deliverable',
    due_date: '2026-07-10',
    dependency_blocked: false,
    completed_at: null,
  },
  {
    id: 'task-2',
    title: 'Unlinked task',
    status_id: 's1',
    priority_id: 'p1',
    parent_id: null,
    description: 'Should not appear on the campaign board',
    due_date: '2026-07-12',
    dependency_blocked: false,
    completed_at: null,
  },
]
const statuses = [{ id: 's1', label: 'Todo', category: 'backlog', sort_order: 0 }]
const comments = [{ id: 'c1', body: 'Looks good', author_id: 'u2', created_at: '2026-07-01T00:00:00Z' }]
const campaigns = [
  {
    id: 'camp-1',
    name: 'Launch campaign',
    status: 'active',
    priority: 'high',
    rank: '1',
    start_date: '2026-07-01',
    end_date: '2026-07-31',
  },
  {
    id: 'camp-2',
    name: 'Planning campaign',
    status: 'scheduled',
    priority: 'low',
    rank: '2',
    start_date: '2026-06-15',
    end_date: '2026-06-30',
  },
  {
    id: 'camp-3',
    name: 'Wrap-up campaign',
    status: 'completed',
    priority: 'urgent',
    rank: '3',
    start_date: '2026-08-01',
    end_date: '2026-08-15',
  },
  {
    id: 'camp-4',
    name: 'Cancelled campaign',
    status: 'cancelled',
    priority: 'medium',
    rank: '4',
    start_date: '2026-09-01',
    end_date: '2026-09-15',
  },
]
const campaignDeliverables = [{ id: 'd1', name: 'Launch email' }]
const campaignSchedules = [{ deliverableId: 'd1', taskId: 'task-1', startDate: '2026-07-03', dueDate: '2026-07-10' }]
const campaignCalendarEvents = [{ id: 'cal-1', title: 'Launch day', event_date: '2026-07-08', event_type: 'launch' }]
const campaignDetail = {
  id: 'camp-1',
  name: 'Launch campaign',
  brief: 'Launch the summer campaign across owned and paid channels.',
  status: 'active',
  priority: 'high',
  rank: '1',
  startDate: '2026-07-01',
  endDate: '2026-07-31',
  ownerId: 'owner-1',
  marketingPlanId: 'plan-1',
  goalMetrics: [{ metricKey: 'clicks', targetValue: '100', unit: 'count' }],
  actuals: [{ metricKey: 'clicks', total: 40 }],
  deliverables: [{ id: 'd1', name: 'Launch email', taskId: 'task-1' }],
  channels: [{ id: 'ch1', channelType: 'email', name: 'Email' }],
  stakeholders: { ownerId: 'owner-1', observerIds: [] },
}
const contentTypes = [
  {
    id: 'ct1',
    key: 'article',
    label: 'Article',
    field_schema: JSON.stringify([
      { name: 'headline', type: 'text', label: 'Headline' },
      { name: 'body', type: 'richtext', label: 'Body' },
      { name: 'priority', type: 'number', label: 'Priority' },
      { name: 'featured', type: 'bool', label: 'Featured' },
      { name: 'category', type: 'enum', label: 'Category', values: ['news', 'guide'] },
      { name: 'hero', type: 'asset', label: 'Hero asset' },
    ]),
  },
]
const rtContentType = {
  id: 'ct-rt',
  key: 'note',
  label: 'Note',
  field_schema: JSON.stringify([
    { name: 'body', type: 'richtext', label: 'Body' },
    { name: 'summary', type: 'richtext', label: 'Summary' },
  ]),
}
contentTypes.push(rtContentType)

const RT_ITEM_ID = 'd1000000-0000-4000-8000-000000000001'
const rtRevId = (revisionNumber) => `d2000000-0000-4000-8000-${String(revisionNumber).padStart(12, '0')}`

function freshRtState() {
  const data = JSON.stringify({ body: '', summary: '' })
  const item = {
    id: RT_ITEM_ID,
    slug: 'note-1',
    status: 'draft',
    content_type_id: 'ct-rt',
    data,
    current_revision_id: rtRevId(1),
    approved_revision_id: null,
    published_revision_id: null,
    updated_at: '2026-07-02T00:00:00Z',
    content_type: rtContentType,
  }
  return {
    item,
    revSeq: 1,
    revisions: [
      {
        id: rtRevId(1),
        parent_id: null,
        revision_number: 1,
        data,
        author_id: 'u1',
        created_at: '2026-07-01T00:00:00Z',
      },
    ],
  }
}

const rtStates = new Map()

function rtStateFor(token) {
  let state = rtStates.get(token)
  if (!state) {
    state = freshRtState()
    rtStates.set(token, state)
  }
  return state
}

const contentItems = [
  {
    id: 'ci1',
    slug: 'launch-article',
    status: 'draft',
    content_type_id: 'ct1',
    data: JSON.stringify({ headline: 'Launch article', body: 'Draft body', priority: 1, featured: true, category: 'news', hero: 'w/hero.png' }),
    current_revision_id: 'cr2',
    approved_revision_id: null,
    published_revision_id: null,
    updated_at: '2026-07-02T00:00:00Z',
    content_type: contentTypes[0],
  },
]
const contentRevisions = [
  { id: 'cr1', parent_id: null, revision_number: 1, data: JSON.stringify({ headline: 'Launch article', body: 'First body' }), author_id: 'u1', created_at: '2026-07-01T00:00:00Z' },
  { id: 'cr2', parent_id: 'cr1', revision_number: 2, data: JSON.stringify({ headline: 'Launch article', body: 'Draft body' }), author_id: 'u1', created_at: '2026-07-02T00:00:00Z' },
]
const contentApprovals = [{ id: 'ca1', content_item_id: 'ci1', state: 'pending' }]
const contentEvents = [{ kind: 'content.scheduled', entity_type: 'content_item', entity_id: 'ci1', ref_id: 'cs1', created_at: '2026-07-03T00:00:00Z' }]

// ── Segmentation (Part D) fixtures ──
const segmentSummaries = [
  { id: 'seg-1', name: 'Registered-not-onboarded', active: true, mode: 'dynamic', ownerRef: 'owner-1', memberCount: 3, lastRecomputedAt: '2026-07-02T00:00:00Z' },
]
const segmentHeader = { id: 'seg-1', name: 'Registered-not-onboarded', active: true, mode: 'dynamic' }
const segmentMembers = [
  { subjectRef: 'user-9', subjectType: 'user', matchedRuleId: 'rule-2', evaluatedAt: '2026-07-02T00:00:00Z' },
  { subjectRef: 'user-8', subjectType: 'user', matchedRuleId: 'rule-2', evaluatedAt: '2026-07-02T00:00:00Z' },
]
// Evidence carries NO `properties` field — the surface never exposes raw payloads (PII discipline).
const membershipExplanation = {
  subjectRef: 'user-9', matchedRuleId: 'rule-2', matchedRuleVersion: 2,
  firstMatchedAt: '2026-07-01T00:00:00Z', evaluatedAt: '2026-07-02T00:00:00Z',
  evidence: [{ eventId: 'ev1', eventType: 'registration.completed', occurredAt: '2026-06-30T00:00:00Z' }],
}
const segmentSnapshots = [
  { id: 'snap-1', takenAt: '2026-07-01T00:00:00Z', reason: 'on_demand', memberCount: 2 },
  { id: 'snap-2', takenAt: '2026-07-02T00:00:00Z', reason: 'scheduled', memberCount: 3 },
]
const snapshotDiff = { added: ['user-8'], removed: [], addedCount: 1, removedCount: 0 }

// ── Workflows (Part 06d) fixtures ──
const eventTypes = [
  { id: 'evt-task-completed', key: 'task.completed', domain: 'task', label: 'Task completed', active: true },
  { id: 'evt-content-approved', key: 'content.approved', domain: 'cms', label: 'Content approved', active: true },
]
const workflowRules = [
  {
    id: 'rule-1',
    trigger_event_type_id: 'evt-task-completed',
    condition: JSON.stringify({ field: 'status', op: 'eq', value: 'done' }),
    action_type: 'notify',
    action_config: JSON.stringify({ recipient_user_id: 'user-2' }),
    enabled: true,
    priority: 10,
    updated_at: '2026-07-04T00:00:00Z',
  },
]
const workflowSubscriptions = [
  {
    id: 'sub-1',
    event_type_id: 'evt-task-completed',
    url: 'https://hooks.example.test/workflows',
    filter: JSON.stringify({ field: 'event', op: 'eq', value: 'task.completed' }),
    active: true,
    secret_set: true,
    secret_last_rotated_at: '2026-07-04T00:00:00Z',
    internal_webhook_id: 'wh-1',
    updated_at: '2026-07-04T00:00:00Z',
  },
]
const workflowRuns = [
  {
    id: 'run-1',
    source_event_id: 'ev-workflow-1',
    event_type: 'task.completed',
    matched: true,
    action_type: 'notify',
    outcome: 'succeeded',
    job_id: 'job-1',
    error_code: null,
    trace_id: 'trace-workflow-1',
    automation_rule_id: 'rule-1',
    updated_at: '2026-07-04T00:00:00Z',
  },
  {
    id: 'run-2',
    source_event_id: 'ev-workflow-2',
    event_type: 'content.approved',
    matched: false,
    action_type: 'deliver_webhook',
    outcome: 'skipped',
    job_id: 'job-2',
    error_code: 'condition_not_matched',
    trace_id: 'trace-workflow-2',
    automation_rule_id: 'rule-1',
    updated_at: '2026-07-04T00:01:00Z',
  },
]
const workflowEvent = {
  id: 'ev-workflow-1',
  type: 'task.completed',
  payload_keys: ['body', 'email', 'task_id'],
  trace_id: 'trace-workflow-1',
}
const workspaceMembers = [
  {
    workspace_id: '00000000-0000-0000-0000-000000000001',
    user_id: 'owner-1',
    role: 'owner',
    created_at: '2026-07-08T00:00:00Z',
  },
  {
    workspace_id: '00000000-0000-0000-0000-000000000001',
    user_id: 'member-1',
    role: 'member',
    created_at: '2026-07-08T00:01:00Z',
  },
]
const ingestKeys = [
  { id: 'key-1', label: 'ci', active: true, created_at: '2026-07-08T00:02:00Z' },
]
const deadJobs = [
  {
    id: 'job-1',
    kind: 'webhook',
    attempts: 8,
    last_error_code: 'delivery_failed',
    updated_at: '2026-07-08T00:03:00Z',
    payload_keys: ['secret_url'],
  },
]
const workspaceSettings = {
  workspace_id: 'w',
  name: 'Acme',
  member_count: 2,
}
const collectionsMeta = [
  {
    name: 'note',
    label: 'Note',
    labelPlural: 'Notes',
    fields: [
      { name: 'title', type: 'text', label: 'Title', required: true },
      { name: 'body', type: 'longtext', label: 'Body', required: false },
      { name: 'status', type: 'enum', label: 'Status', required: true },
    ],
  },
  {
    name: 'tag',
    label: 'Tag',
    labelPlural: 'Tags',
    fields: [{ name: 'label', type: 'text', label: 'Label', required: true }],
  },
]

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  if (url.pathname === '/health') return json(res, 200, { ok: true })
  if (url.pathname === '/auth/v1/verify') {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    const parsed = JSON.parse(body || '{}')
    if (parsed.token_hash === 'valid-token-hash' && (parsed.type ?? 'email') === 'email') {
      return json(res, 200, { session: { access_token: 'verified-login-token-1234567890' } })
    }
    return json(res, 400, { error: 'invalid_token_hash' })
  }
  if (url.pathname === '/auth/v1/user') {
    const auth = String(req.headers.authorization ?? '')
    const token = auth.match(/^Bearer\s+(.+)$/i)?.[1] ?? ''
    if (token.startsWith('test-token-') || token === 'verified-login-token-1234567890') {
      return json(res, 200, { id: 'user-login-1', email: 'demo-owner@example.test' })
    }
    return json(res, 401, { error: 'invalid_token' })
  }
  if (url.pathname === '/auth/v1/otp') {
    let body = ''
    for await (const chunk of req) body += String(chunk)
    const parsed = JSON.parse(body || '{}')
    const redirectTo = url.searchParams.get('redirect_to') ?? ''
    const redirectPath = redirectTo ? new URL(redirectTo).pathname : ''
    if (
      typeof parsed.email === 'string' &&
      parsed.email.includes('@') &&
      parsed.create_user === false &&
      redirectPath === '/auth/callback'
    ) {
      return json(res, 200, {})
    }
    return json(res, 400, { error: 'invalid_otp_request' })
  }
  if (url.pathname === '/scenario') {
    const next = url.searchParams.get('name') ?? 'ok'
    const requestedToken = url.searchParams.get('token')
    const stateKey = requestedToken ?? 'fallback'
    if (requestedToken) scenarios.set(requestedToken, next)
    else fallbackScenario = next
    counts.set(stateKey, {})
    rtStates.set(stateKey, freshRtState())
    return json(res, 200, { scenario: next })
  }
  if (url.pathname === '/counts') {
    const token = url.searchParams.get('token') ?? 'fallback'
    return json(res, 200, counts.get(token) ?? {})
  }
  if (url.pathname !== '/graphql') return json(res, 404, { error: 'not_found' })
  const scenario = scenarioFor(req)
  const token = tokenFor(req)
  if (scenario === 'auth') return json(res, 401, { error: 'auth_error' })
  if (scenario === 'error') return json(res, 200, { errors: [{ message: 'seeded' }] })

  let body = ''
  for await (const chunk of req) body += String(chunk)
  const parsed = JSON.parse(body || '{}')
  const query = String(parsed.query ?? '')

  if (query.includes('query Notes')) {
    return json(res, 200, { data: { notes: { items: scenario === 'empty' ? [] : notes, nextCursor: null } } })
  }
  if (query.includes('query Note')) {
    return json(res, 200, { data: { note: scenario === 'empty' ? null : notes[0] } })
  }
  if (query.includes('query Search')) {
    const hits =
      scenario === 'empty'
        ? []
        : [
            { collection: 'note', id: 'n1', title: 'First note', snippet: 'Body text', score: 0.91 },
            { collection: 'content_item', id: 'ci1', title: 'Launch article', snippet: 'Draft body', score: 0.89 },
          ]
    return json(res, 200, { data: { search: hits } })
  }
  if (query.includes('query Campaigns')) {
    return json(res, 200, { data: { campaigns: { items: scenario === 'empty' ? [] : campaigns, nextCursor: null } } })
  }
  if (query.includes('query CampaignDetail')) {
    return json(res, 200, { data: { campaignDetail: scenario === 'empty' ? null : campaignDetail } })
  }
  if (query.includes('query CampaignComments')) {
    return json(res, 200, { data: { comments: scenario === 'empty' ? [] : [{ ...comments[0], body: 'Campaign note' }] } })
  }
  if (query.includes('query Deliverables')) {
    return json(res, 200, { data: { campaign_deliverables: { items: scenario === 'empty' ? [] : campaignDeliverables, nextCursor: null } } })
  }
  if (query.includes('query DeliverableSchedules')) {
    bump(token, 'DeliverableSchedules')
    return json(res, 200, { data: { deliverableSchedules: scenario === 'empty' ? [] : campaignSchedules } })
  }
  if (query.includes('query CalendarEvents')) {
    return json(res, 200, { data: { campaign_calendar_events: { items: scenario === 'empty' ? [] : campaignCalendarEvents, nextCursor: null } } })
  }
  if (query.includes('query ContentTypes')) {
    return json(res, 200, { data: { contentTypes: scenario === 'empty' ? [] : contentTypes } })
  }
  if (query.includes('query Content(')) {
    const items = scenario === 'empty' ? [] : [...contentItems, rtStateFor(token).item]
    return json(res, 200, { data: { content: { items, nextCursor: null } } })
  }
  if (query.includes('query ContentItem')) {
    bump(token, 'contentItemRead')
    const requested = parsed.variables?.id
    const item = requested === RT_ITEM_ID
      ? rtStateFor(token).item
      : contentItems.find((candidate) => candidate.id === requested) ?? null
    return json(res, 200, { data: { contentItem: scenario === 'empty' ? null : item } })
  }
  if (query.includes('query ContentRevisions')) {
    const revisions = parsed.variables?.itemId === RT_ITEM_ID ? rtStateFor(token).revisions : contentRevisions
    return json(res, 200, { data: { contentRevisions: scenario === 'empty' ? [] : revisions } })
  }
  if (query.includes('query ContentComments')) {
    return json(res, 200, { data: { comments: scenario === 'empty' ? [] : [{ ...comments[0], body: 'Editorial note' }] } })
  }
  if (query.includes('query ContentApprovalsPage')) {
    return json(res, 200, {
      data: {
        contentApprovals: scenario === 'empty' ? [] : contentApprovals,
        content: { items: scenario === 'empty' ? [] : contentItems, nextCursor: null },
      },
    })
  }
  if (query.includes('query ContentApprovals')) {
    return json(res, 200, { data: { contentApprovals: scenario === 'empty' ? [] : contentApprovals } })
  }
  if (query.includes('mutation RunSeoAudit')) {
    return json(res, 200, { data: { runSeoAudit: { score: 87, checklist: JSON.stringify([{ rule: 'headline', pass: true }]) } } })
  }
  if (query.includes('mutation UpdateContent')) {
    const vid = parsed.variables?.id
    if (scenario === 'conflict' && vid === 'ci1') {
      return json(res, 200, { errors: [{ message: 'This content was updated by someone else.', extensions: { code: 'CONFLICT' } }] })
    }
    if (vid === RT_ITEM_ID) {
      const state = rtStateFor(token)
      const item = state.item
      const expected = parsed.variables?.expectedRevisionId
      const submitted = JSON.parse(parsed.variables?.data ?? '{}')
      const submittedHash = JSON.stringify(submitted)
      const currentRevision = state.revisions.find((revision) => revision.id === item.current_revision_id)
      if (currentRevision && currentRevision.data === submittedHash) {
        return json(res, 200, {
          data: {
            updateContent: {
              id: vid,
              status: item.status,
              current_revision_id: item.current_revision_id,
            },
          },
        })
      }
      if (expected && expected !== item.current_revision_id) {
        return json(res, 200, { errors: [{ message: 'This content was updated by someone else.', extensions: { code: 'CONFLICT' } }] })
      }
      state.revSeq += 1
      const newRevision = {
        id: rtRevId(state.revSeq),
        parent_id: item.current_revision_id,
        revision_number: state.revSeq,
        data: submittedHash,
        author_id: 'u1',
        created_at: '2026-07-02T00:00:00Z',
      }
      state.revisions.push(newRevision)
      item.current_revision_id = newRevision.id
      item.data = submittedHash
      return json(res, 200, {
        data: {
          updateContent: {
            id: vid,
            status: item.status,
            current_revision_id: newRevision.id,
          },
        },
      })
    }
    const data = JSON.parse(parsed.variables?.data ?? '{}')
    if (typeof data.priority !== 'number' || typeof data.featured !== 'boolean' || !['news', 'guide'].includes(data.category) || !data.hero) {
      return json(res, 200, { errors: [{ message: 'invalid content data' }] })
    }
    return json(res, 200, { data: { updateContent: { id: vid, status: 'draft' } } })
  }
  if (query.includes('mutation SubmitContent')) {
    return json(res, 200, { data: { submitForApproval: { id: parsed.variables?.itemId, status: 'in_review' } } })
  }
  if (query.includes('mutation DecideApproval')) {
    return json(res, 200, { data: { decideApproval: { id: parsed.variables?.approvalId, state: parsed.variables?.vote === 'reject' ? 'rejected' : 'approved' } } })
  }
  if (query.includes('mutation PublishContent')) {
    return json(res, 200, { data: { publishContent: { id: parsed.variables?.itemId, status: 'published', published_revision_id: 'cr2' } } })
  }
  if (query.includes('mutation UnpublishContent')) {
    return json(res, 200, { data: { unpublishContent: { id: parsed.variables?.itemId, status: 'draft' } } })
  }
  if (query.includes('mutation ScheduleContent')) {
    return json(res, 200, { data: { scheduleContent: { id: 'cs1', state: 'scheduled' } } })
  }
  if (query.includes('mutation IssueAssetUpload')) {
    return json(res, 200, { data: { issueAssetUpload: { uploadUrl: `http://127.0.0.1:${port}/upload`, assetId: 'asset1', r2Key: 'w/asset1' } } })
  }
  if (query.includes('mutation FinalizeAsset')) {
    return json(res, 200, { data: { finalizeAsset: { id: parsed.variables?.assetId, r2_key: 'w/asset1' } } })
  }
  if (query.includes('query Tasks') || query.includes('query Subtasks')) {
    const parentId = parsed.variables?.parentId
    const items = scenario === 'empty' ? [] : tasks.filter((task) => (parentId ? task.parent_id === parentId : task.parent_id === null))
    return json(res, 200, { data: { tasks: { items, nextCursor: null } } })
  }
  if (query.includes('query TaskBoard')) {
    return json(res, 200, {
      data: {
        taskBoard: scenario === 'empty' ? [] : statuses.map((status) => ({ status, tasks: tasks.filter((task) => task.parent_id === null) })),
      },
    })
  }
  if (query.includes('query Task')) {
    return json(res, 200, { data: { task: scenario === 'empty' ? null : tasks.find((task) => task.id === parsed.variables?.id) ?? null } })
  }
  if (query.includes('query Comments')) {
    return json(res, 200, { data: { comments: scenario === 'empty' ? [] : comments } })
  }
  if (query.includes('query Inbox')) {
    const inbox = scenario === 'empty' ? [] : [{ kind: 'task.assigned', entity_type: 'task', entity_id: 't1', ref_id: 'a1', created_at: '2026-07-01T00:00:00Z' }, ...contentEvents]
    return json(res, 200, { data: { inbox } })
  }
  if (query.includes('query SegmentSummaries')) {
    return json(res, 200, { data: { segmentSummaries: scenario === 'empty' ? [] : segmentSummaries } })
  }
  if (query.includes('query SegmentMembers')) {
    return json(res, 200, { data: { segmentMembers: { items: scenario === 'empty' ? [] : segmentMembers, nextCursor: null } } })
  }
  if (query.includes('query MembershipExplanation')) {
    return json(res, 200, { data: { segmentMembershipExplained: scenario === 'empty' ? null : membershipExplanation } })
  }
  if (query.includes('query SegmentSnapshots')) {
    return json(res, 200, { data: { segmentSnapshots: scenario === 'empty' ? [] : segmentSnapshots } })
  }
  if (query.includes('query SnapshotDiff')) {
    return json(res, 200, { data: { snapshotDiff: snapshotDiff } })
  }
  if (query.includes('query PreviewMatchingCount')) {
    return json(res, 200, { data: { previewMatchingCount: { count: 12 } } })
  }
  if (query.includes('mutation CreateSegmentRuleVersion')) {
    return json(res, 200, { data: { createSegmentRuleVersion: { id: 'rule-2', version: 2 } } })
  }
  if (query.includes('query Segment(')) {
    return json(res, 200, { data: { segment: scenario === 'empty' ? null : segmentHeader } })
  }
  if (query.includes('query WorkflowRules')) {
    return json(res, 200, {
      data: {
        eventTypes: { items: eventTypes, nextCursor: null },
        automationRules: { items: scenario === 'empty' ? [] : workflowRules, nextCursor: null },
      },
    })
  }
  if (query.includes('mutation UpsertAutomationRule')) {
    if (String(parsed.variables?.condition ?? '').includes('not-json')) {
      return json(res, 200, { errors: [{ message: 'condition_invalid' }] })
    }
    return json(res, 200, {
      data: {
        upsertAutomationRule: {
          id: 'rule-2',
          action_type: parsed.variables?.actionType,
          enabled: parsed.variables?.enabled,
          priority: parsed.variables?.priority,
          updated_at: '2026-07-04T00:02:00Z',
        },
      },
    })
  }
  if (query.includes('query WorkflowWebhooks')) {
    return json(res, 200, {
      data: {
        eventTypes: { items: eventTypes, nextCursor: null },
        webhook_subscriptions: { items: scenario === 'empty' ? [] : workflowSubscriptions, nextCursor: null },
      },
    })
  }
  if (query.includes('mutation RegisterWebhookSubscription')) {
    return json(res, 200, {
      data: { registerWebhookSubscription: { subscriptionId: 'sub-new', secret: 'register-secret-value-1234567890' } },
    })
  }
  if (query.includes('mutation RotateWebhookSecret')) {
    return json(res, 200, {
      data: { rotateWebhookSecret: { subscriptionId: parsed.variables?.subscriptionId, secret: 'rotated-secret-value-1234567890' } },
    })
  }
  if (query.includes('mutation SetWebhookActive')) {
    return json(res, 200, { data: { setWebhookActive: { id: parsed.variables?.subscriptionId, active: parsed.variables?.active, updated_at: '2026-07-04T00:03:00Z' } } })
  }
  if (query.includes('mutation SetWebhookFilter')) {
    return json(res, 200, { data: { setWebhookFilter: { id: parsed.variables?.subscriptionId, filter: parsed.variables?.filter, updated_at: '2026-07-04T00:03:00Z' } } })
  }
  if (query.includes('query WorkflowRuns')) {
    return json(res, 200, { data: { workflow_runs: { items: scenario === 'empty' ? [] : workflowRuns, nextCursor: null } } })
  }
  if (query.includes('query WorkflowEvent')) {
    return json(res, 200, { data: { workflowEvent: JSON.stringify(workflowEvent) } })
  }
  if (query.includes('mutation ReplayDeadWorkflowJobs')) {
    return json(res, 200, { data: { replayDeadWorkflowJobs: { replayed: 2 } } })
  }
  if (query.includes('query WorkspaceMembers')) {
    return json(res, 200, { data: { workspaceMembers: scenario === 'empty' ? [] : workspaceMembers } })
  }
  if (query.includes('mutation InviteMember')) {
    return json(res, 200, { data: { inviteMember: { inviteId: 'invite-1', token: 'invite-token-1234567890' } } })
  }
  if (query.includes('mutation AcceptInvite')) {
    if (parsed.variables?.token === 'bad-token') {
      return json(res, 200, {
        errors: [{
          message: 'domain.admin.acceptInvite failed [P0001]: invite_not_found',
          extensions: { code: 'NOT_FOUND', pgCode: 'P0001', reason: 'invite_not_found' },
        }],
      })
    }
    return json(res, 200, { data: { acceptInvite: { ...workspaceMembers[1], role: 'member' } } })
  }
  if (query.includes('mutation SetMemberRole')) {
    return json(res, 200, { data: { setMemberRole: { ...workspaceMembers[1], role: parsed.variables?.role } } })
  }
  if (query.includes('mutation RemoveMember')) {
    return json(res, 200, { data: { removeMember: true } })
  }
  if (query.includes('query IngestKeys')) {
    return json(res, 200, { data: { ingestKeys: scenario === 'empty' ? [] : ingestKeys } })
  }
  if (query.includes('mutation CreateIngestKey')) {
    return json(res, 200, { data: { createIngestKey: { keyId: 'key-new', rawKey: 'a'.repeat(48) } } })
  }
  if (query.includes('mutation RotateIngestKey')) {
    return json(res, 200, { data: { rotateIngestKey: { keyId: parsed.variables?.keyId, rawKey: 'b'.repeat(48) } } })
  }
  if (query.includes('mutation RevokeIngestKey')) {
    return json(res, 200, { data: { revokeIngestKey: true } })
  }
  if (query.includes('query AdminJobs')) {
    return json(res, 200, {
      data: {
        jobCounts: JSON.stringify({ dead: scenario === 'empty' ? 0 : 1, failed: 1, pending: 2 }),
        deadJobs: scenario === 'empty' ? [] : deadJobs,
      },
    })
  }
  if (query.includes('query ReportingDashboards')) {
    const empty = scenario === 'empty'
    const partial = scenario === 'partial'
    return json(res, 200, {
      data: {
        reportingTaskThroughput: {
          avgCycleHours: empty ? null : 24,
          openCount: empty ? 0 : 3,
          series: empty ? [] : [
            { day: '2026-07-09', count: 1 },
            { day: '2026-07-10', count: 2 },
          ],
        },
        reportingContentFunnel: empty ? [] : [
          { status: 'draft', count: 2 },
          { status: 'published', count: 1 },
        ],
        reportingCampaignMetrics: partial ? null : empty ? [] : [{ metricKey: 'clicks', total: 100 }],
        reportingSegmentGrowth: empty ? [] : [{
          segmentId: 's-1',
          name: 'Registered',
          points: [
            { takenAt: '2026-07-09', memberCount: 3 },
            { takenAt: '2026-07-10', memberCount: 5 },
          ],
        }],
        reportingWorkflowHealth: empty ? [] : [
          { day: '2026-07-10', outcome: 'succeeded', count: 4 },
          { day: '2026-07-10', outcome: 'failed', count: 1 },
        ],
        reportingIngestVolume: empty ? [] : [{ day: '2026-07-10', source: 'internal', count: 7 }],
        reportingEventDailyCounts: empty ? [] : [{ day: '2026-07-10', type: 'task.completed', count: 5 }],
        reportingJobDailyCounts: empty ? [] : [{ day: '2026-07-10', kind: 'embed', status: 'done', count: 6 }],
      },
      errors: partial ? [{
        message: 'Could not load this report.',
        path: ['reportingCampaignMetrics'],
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
      }] : undefined,
    })
  }
  if (query.includes('mutation ReplayDeadJobs')) {
    return json(res, 200, { data: { replayDeadJobs: { replayed: 1 } } })
  }
  if (query.includes('query WorkspaceSettings')) {
    return json(res, 200, { data: { workspaceSettings } })
  }
  if (query.includes('query CollectionsMeta')) {
    return json(res, 200, { data: { collectionsMeta: scenario === 'empty' ? [] : collectionsMeta } })
  }
  if (query.includes('query CollectionRows')) {
    return json(res, 200, { data: { notes: { items: scenario === 'empty' ? [] : notes, nextCursor: null } } })
  }
  if (query.includes('mutation UpdateCollectionRow')) {
    return json(res, 200, { data: { updateNote: { id: parsed.variables?.id } } })
  }
  return json(res, 200, { data: {} })
}).listen(port, '127.0.0.1')
