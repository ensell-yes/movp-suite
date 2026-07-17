import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  token: 'tok' as string | null,
  gql: vi.fn(),
  env: vi.fn(() => ({
    graphqlEndpoint: 'http://x/graphql',
    workspaceId: 'w',
    supabaseUrl: 'http://x',
    supabaseAnonKey: 'anon',
  })),
}))

vi.mock('../../../../lib/env.ts', () => ({
  readServerEnv: () => h.env(),
}))
vi.mock('../../../../lib/session.ts', () => ({ getSessionToken: () => h.token }))
vi.mock('../../../../lib/graphql.ts', () => ({ gqlRequest: h.gql }))

import {
  GET,
  POST,
  boundedText,
  classifyOutcome,
  emit,
  fieldKeyBytes,
  parseData,
  parseSchema,
} from './richtext.ts'

const ITEM = 'd1000000-0000-4000-8000-000000000001'
const REV = 'd2000000-0000-4000-8000-000000000001'
const okDoc = JSON.stringify({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }],
})
const itemOk = {
  ok: true,
  data: {
    contentItem: {
      data: '{"body":"","summary":""}',
      current_revision_id: REV,
      content_type: { field_schema: '[{"name":"body","type":"richtext"}]' },
    },
  },
}

let logs: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  h.token = 'tok'
  h.gql.mockReset()
  h.env.mockReset()
  h.env.mockReturnValue({
    graphqlEndpoint: 'http://x/graphql',
    workspaceId: 'w',
    supabaseUrl: 'http://x',
    supabaseAnonKey: 'anon',
  })
})

function spyLogs() {
  logs = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    logs.push(String(line))
  })
}

function expectEvent(outcome: string) {
  expect(logs).toHaveLength(1)
  const line = JSON.parse(logs[0]!) as Record<string, unknown>
  expect(line.outcome).toBe(outcome)
  expect(logs[0]).not.toContain('tok')
  expect(logs[0]).not.toContain('"text":"hi"')
  return line
}

const call = (fn: typeof POST, id: string, init: RequestInit & { url?: string }) =>
  fn({
    params: { id },
    cookies: {},
    request: new Request(init.url ?? `http://x/api/content/${id}/richtext`, init),
  } as unknown as Parameters<typeof POST>[0])

const post = (body: unknown, id = ITEM) =>
  call(POST, id, { method: 'POST', body: JSON.stringify(body) })

describe('POST outcomes — exactly one content-disciplined event each', () => {
  it('401 when the session cookie is missing', async () => {
    h.token = null
    spyLogs()
    const res = await post({ fieldKey: 'body', body: okDoc, expectedRevisionId: REV })
    expect(res.status).toBe(401)
    expectEvent('unauthorized')
  })

  it('422 for a non-doc body, before any upstream read', async () => {
    spyLogs()
    const res = await post({ fieldKey: 'body', body: '"nope"', expectedRevisionId: REV })
    expect(res.status).toBe(422)
    expect(h.gql).not.toHaveBeenCalled()
    expectEvent('validation')
  })

  it('413 for an oversized body, before parse/read', async () => {
    spyLogs()
    const res = await post({
      fieldKey: 'body',
      body: okDoc + ' '.repeat(300_000),
      expectedRevisionId: REV,
    })
    expect(res.status).toBe(413)
    expect(h.gql).not.toHaveBeenCalled()
    expectEvent('too_large')
  })

  it('404 when the combined read returns no item', async () => {
    h.gql.mockResolvedValueOnce({ ok: true, data: { contentItem: null } })
    spyLogs()
    expect((await post({ fieldKey: 'body', body: okDoc, expectedRevisionId: REV })).status).toBe(404)
    expectEvent('not_found')
  })

  it('500 when persisted state is structurally malformed', async () => {
    h.gql.mockResolvedValueOnce({
      ok: true,
      data: {
        contentItem: {
          data: 'not json',
          current_revision_id: REV,
          content_type: { field_schema: '[{"name":"body","type":"richtext"}]' },
        },
      },
    })
    spyLogs()
    expect((await post({ fieldKey: 'body', body: okDoc, expectedRevisionId: REV })).status).toBe(500)
    expectEvent('error')
  })

  it('422 for a non-richtext fieldKey without logging the key', async () => {
    h.gql.mockResolvedValueOnce(itemOk)
    spyLogs()
    const res = await post({ fieldKey: 'nope', body: okDoc, expectedRevisionId: REV })
    expect(res.status).toBe(422)
    expect(expectEvent('validation').field_key).toBeUndefined()
  })

  it('409 on a structured CONFLICT from the write', async () => {
    h.gql
      .mockResolvedValueOnce(itemOk)
      .mockResolvedValueOnce({ ok: false, code: 'graphql_error', errorCode: 'CONFLICT' })
    spyLogs()
    const res = await post({ fieldKey: 'body', body: okDoc, expectedRevisionId: REV })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ status: 'conflict' })
    expectEvent('conflict')
  })

  it('200 on success — new revision id, one combined read, no payload in the event', async () => {
    h.gql
      .mockResolvedValueOnce(itemOk)
      .mockResolvedValueOnce({
        ok: true,
        data: { updateContent: { current_revision_id: 'rNEW' } },
      })
    spyLogs()
    const res = await post({ fieldKey: 'body', body: okDoc, expectedRevisionId: REV })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'saved', revisionId: 'rNEW' })
    expect(h.gql).toHaveBeenCalledTimes(2)
    expect(expectEvent('saved').field_key).toBe('body')
  })

  it('500 + one error event when a request-bound dependency throws unexpectedly', async () => {
    h.env.mockImplementationOnce(() => {
      throw new Error('env unavailable')
    })
    spyLogs()
    const res = await post({ fieldKey: 'body', body: okDoc, expectedRevisionId: REV })
    expect(res.status).toBe(500)
    expectEvent('error')
  })
})

describe('GET returns the field body + revision', () => {
  it('200 with body + revisionId for a valid richtext field', async () => {
    h.gql.mockResolvedValueOnce(itemOk)
    spyLogs()
    const res = await call(GET, ITEM, {
      method: 'GET',
      url: `http://x/api/content/${ITEM}/richtext?fieldKey=body`,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ body: '', revisionId: REV })
    expectEvent('read_ok')
  })
})

describe('boundedText', () => {
  it('returns null when the stream exceeds the cap', async () => {
    const big = new Request('http://x', { method: 'POST', body: 'x'.repeat(300_000) })
    expect(await boundedText(big, 262_144)).toBeNull()
  })

  it('returns the decoded body under the cap', async () => {
    const request = new Request('http://x', { method: 'POST', body: '{"a":1}' })
    expect(await boundedText(request, 262_144)).toBe('{"a":1}')
  })
})

describe('classifyOutcome (code-based, not message-based)', () => {
  it('maps the structured CONFLICT extension code to conflict/409', () => {
    expect(classifyOutcome({ ok: false, code: 'graphql_error', errorCode: 'CONFLICT' })).toEqual({
      outcome: 'conflict',
      status: 409,
      body: { status: 'conflict' },
    })
  })

  it('maps auth_error to 401', () => {
    expect(classifyOutcome({ ok: false, code: 'auth_error' }).status).toBe(401)
  })

  it('does not infer conflict from message text alone', () => {
    const out = classifyOutcome({
      ok: false,
      code: 'graphql_error',
      message: 'content_update_conflict leaked',
    })
    expect(out).toEqual({
      outcome: 'error',
      status: 500,
      body: { status: 'error', code: 'save_failed' },
    })
  })
})

describe('parseSchema / parseData reject malformed persisted JSON', () => {
  it('parseSchema returns null for non-array / bad elements', () => {
    expect(parseSchema('{}')).toBeNull()
    expect(parseSchema('[{"type":"richtext"}]')).toBeNull()
    expect(parseSchema('not json')).toBeNull()
  })

  it('parseData returns null for non-object', () => {
    expect(parseData('[]')).toBeNull()
    expect(parseData('null')).toBeNull()
  })

  it('fieldKeyBytes measures UTF-8 bytes, not UTF-16 units', () => {
    expect(fieldKeyBytes('€')).toBe(3)
  })
})

describe('emit content discipline', () => {
  it('logs exactly one JSON line with names/outcome/latency only', () => {
    const lines: string[] = []
    const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line))
    })
    emit({
      outcome: 'saved',
      itemId: ITEM,
      fieldKey: 'body',
      startedAt: Date.now(),
    })
    spy.mockRestore()
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(parsed.event).toBe('content.richtext_save')
    expect(parsed.outcome).toBe('saved')
    expect(parsed.field_key).toBe('body')
    expect(typeof parsed.latency_ms).toBe('number')
    expect(parsed.request_id).toBeTruthy()
    expect(Object.keys(parsed)).not.toContain('body')
    expect(Object.keys(parsed)).not.toContain('token')
  })
})
