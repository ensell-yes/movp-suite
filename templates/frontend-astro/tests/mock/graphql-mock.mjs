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
        : [{ collection: 'note', id: 'n1', title: 'First note', snippet: 'Body text', score: 0.91 }]
    return json(res, 200, { data: { search: hits } })
  }
  return json(res, 200, { data: {} })
}).listen(port, '127.0.0.1')
