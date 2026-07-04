import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 4322)
let scenario = 'ok'

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
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
]
const statuses = [{ id: 's1', label: 'Todo', category: 'backlog', sort_order: 0 }]
const comments = [{ id: 'c1', body: 'Looks good', author_id: 'u2', created_at: '2026-07-01T00:00:00Z' }]
const contentTypes = [
  {
    id: 'ct1',
    key: 'article',
    label: 'Article',
    field_schema: JSON.stringify({
      fields: [
        { key: 'headline', type: 'text', label: 'Headline' },
        { key: 'body', type: 'richtext', label: 'Body' },
        { key: 'hero', type: 'asset', label: 'Hero asset' },
      ],
    }),
  },
]
const contentItems = [
  {
    id: 'ci1',
    slug: 'launch-article',
    status: 'draft',
    content_type_id: 'ct1',
    data: JSON.stringify({ headline: 'Launch article', body: 'Draft body', hero: '' }),
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

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  if (url.pathname === '/health') return json(res, 200, { ok: true })
  if (url.pathname === '/scenario') {
    scenario = url.searchParams.get('name') ?? 'ok'
    return json(res, 200, { scenario })
  }
  if (url.pathname !== '/graphql') return json(res, 404, { error: 'not_found' })
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
  if (query.includes('query ContentTypes')) {
    return json(res, 200, { data: { contentTypes: scenario === 'empty' ? [] : contentTypes } })
  }
  if (query.includes('query Content(')) {
    return json(res, 200, { data: { content: { items: scenario === 'empty' ? [] : contentItems, nextCursor: null } } })
  }
  if (query.includes('query ContentItem')) {
    return json(res, 200, { data: { contentItem: scenario === 'empty' ? null : contentItems.find((item) => item.id === parsed.variables?.id) ?? null } })
  }
  if (query.includes('query ContentRevisions')) {
    return json(res, 200, { data: { contentRevisions: scenario === 'empty' ? [] : contentRevisions } })
  }
  if (query.includes('query ContentComments')) {
    return json(res, 200, { data: { comments: scenario === 'empty' ? [] : [{ ...comments[0], body: 'Editorial note' }] } })
  }
  if (query.includes('query ContentApprovals')) {
    return json(res, 200, { data: { contentApprovals: scenario === 'empty' ? [] : contentApprovals } })
  }
  if (query.includes('mutation RunSeoAudit')) {
    return json(res, 200, { data: { runSeoAudit: { score: 87, checklist: JSON.stringify([{ rule: 'headline', pass: true }]) } } })
  }
  if (query.includes('mutation UpdateContent')) {
    return json(res, 200, { data: { updateContent: { id: parsed.variables?.id, status: 'draft' } } })
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
  return json(res, 200, { data: {} })
}).listen(port, '127.0.0.1')
