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
const saveResult = (result: {
  status: 'saved' | 'error'
  revisionId?: string | null
  code?: string | null
}) => ({
  ok: true,
  data: { updateRichTextField: result },
})

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

  it('404 when the mutation returns the safe item-not-found code', async () => {
    h.gql.mockResolvedValueOnce(saveResult({
      status: 'error',
      code: 'content_item_not_found',
    }))
    spyLogs()
    expect((await post({ fieldKey: 'body', body: okDoc, expectedRevisionId: REV })).status).toBe(404)
    expectEvent('not_found')
  })

  it('500 when the primitive returns a safe operational code', async () => {
    h.gql.mockResolvedValueOnce(saveResult({
      status: 'error',
      code: 'content_schema_invalid',
    }))
    spyLogs()
    const res = await post({ fieldKey: 'body', body: okDoc, expectedRevisionId: REV })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ status: 'error', code: 'content_schema_invalid' })
    expectEvent('error')
  })

  it('422 for a non-richtext fieldKey without exposing the upstream code', async () => {
    h.gql.mockResolvedValueOnce(saveResult({
      status: 'error',
      code: 'content_field_not_richtext',
    }))
    spyLogs()
    const res = await post({ fieldKey: 'nope', body: okDoc, expectedRevisionId: REV })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ status: 'error', code: 'invalid_request' })
    expect(expectEvent('validation').field_key).toBe('nope')
  })

  it('409 on a structured CONFLICT from the write', async () => {
    h.gql.mockResolvedValueOnce({ ok: false, code: 'graphql_error', errorCode: 'CONFLICT' })
    spyLogs()
    const res = await post({ fieldKey: 'body', body: okDoc, expectedRevisionId: REV })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ status: 'conflict' })
    expectEvent('conflict')
  })

  it('200 on success — one upstream mutation, correlated id, no payload in the event', async () => {
    h.gql.mockResolvedValueOnce(saveResult({
      status: 'saved',
      revisionId: 'rNEW',
    }))
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      'd3000000-0000-4000-8000-000000000001',
    )
    spyLogs()
    const res = await post({ fieldKey: 'body', body: okDoc, expectedRevisionId: REV })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'saved', revisionId: 'rNEW' })
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(h.gql).toHaveBeenCalledTimes(1)
    expect(String(h.gql.mock.calls[0]?.[1])).toContain('mutation UpdateRichTextField')
    expect(h.gql.mock.calls[0]?.[2]).toEqual({
      input: {
        itemId: ITEM,
        fieldKey: 'body',
        body: okDoc,
        expectedRevisionId: REV,
      },
    })
    const event = expectEvent('saved')
    expect(event.field_key).toBe('body')
    expect(h.gql.mock.calls[0]?.[0]).toEqual({
      endpoint: 'http://x/graphql',
      token: 'tok',
      requestId: event.request_id,
    })
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

  it('resolves env and the HttpOnly token independently for every request', async () => {
    h.gql
      .mockResolvedValueOnce(saveResult({ status: 'saved', revisionId: 'r1' }))
      .mockResolvedValueOnce(saveResult({ status: 'saved', revisionId: 'r2' }))
    spyLogs()
    await post({ fieldKey: 'body', body: okDoc, expectedRevisionId: REV })
    h.token = 'tok-next'
    h.env.mockReturnValueOnce({
      graphqlEndpoint: 'http://next/graphql',
      workspaceId: 'w',
      supabaseUrl: 'http://next',
      supabaseAnonKey: 'anon-next',
    })
    await post({ fieldKey: 'body', body: okDoc, expectedRevisionId: REV })

    expect(h.env).toHaveBeenCalledTimes(2)
    expect(h.gql.mock.calls[0]?.[0]).toMatchObject({
      endpoint: 'http://x/graphql',
      token: 'tok',
    })
    expect(h.gql.mock.calls[1]?.[0]).toMatchObject({
      endpoint: 'http://next/graphql',
      token: 'tok-next',
    })
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
    expect(res.headers.get('cache-control')).toBe('no-store')
    expectEvent('read_ok')
  })
})

describe('boundedText', () => {
  it('drains without cancelling when the stream exceeds the cap', async () => {
    let step = 0
    let trailingChunkRead = false
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (step === 0) controller.enqueue(new Uint8Array(4))
        else if (step === 1) controller.enqueue(new Uint8Array(4))
        else if (step === 2) {
          trailingChunkRead = true
          controller.enqueue(new Uint8Array(4))
        } else controller.close()
        step += 1
      },
      cancel() {
        cancelled = true
      },
    })
    const request = { body: stream } as Request

    expect(await boundedText(request, 5)).toBeNull()
    expect(trailingChunkRead).toBe(true)
    expect(cancelled).toBe(false)
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
      requestId: 'd3000000-0000-4000-8000-000000000001',
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
