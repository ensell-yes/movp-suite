import { graphql, printSchema } from 'graphql/index.js'
import { describe, expect, it, vi } from 'vitest'
import { schema as movpSchema } from '@movp/core-schema'
import { buildSchema } from '../src/schema.ts'
import { createYoga } from '../src/yoga.ts'

const item = {
  id: 'd1000000-0000-4000-8000-000000000001',
  workspace_id: 'd2000000-0000-4000-8000-000000000001',
}

function context(result: unknown, options?: { item?: typeof item | null; capability?: boolean; rpcError?: boolean }) {
  const get = vi.fn(async () => options?.item === null ? null : (options?.item ?? item))
  const updateRichTextField = vi.fn(async () => result)
  const rpc = vi.fn(async () => ({
    data: options?.capability ?? true,
    error: options?.rpcError ? { code: 'XX000' } : null,
  }))
  const reportContentCapabilityFailure = vi.fn()
  return {
    value: {
      db: { rpc } as never,
      userId: 'd3000000-0000-4000-8000-000000000001',
      domain: { content: { get, updateRichTextField } } as never,
      requestId: 'd4000000-0000-4000-8000-000000000001',
      reportContentCapabilityFailure,
    },
    get,
    updateRichTextField,
    rpc,
    reportContentCapabilityFailure,
  }
}

describe('rich-text field GraphQL surface', () => {
  it('pins the exact query, mutation, input, and result signatures', () => {
    const sdl = printSchema(buildSchema(movpSchema))
    expect(sdl).toMatch(/contentCanEdit\(itemId: ID!\): Boolean!/)
    expect(sdl).toMatch(/updateRichTextField\(input: UpdateRichTextFieldInput!\): RichTextFieldUpdateResult!/)
    expect(sdl).toMatch(/input UpdateRichTextFieldInput \{[\s\S]*body: String![\s\S]*expectedRevisionId: ID![\s\S]*fieldKey: String![\s\S]*itemId: ID!/)
    expect(sdl).toMatch(/type RichTextFieldUpdateResult \{[\s\S]*code: String[\s\S]*revisionId: ID[\s\S]*status: String!/)
  })

  it('fails closed and reports when the caller-bound item read fails', async () => {
    const state = context({ status: 'saved', revisionId: 'revision-2' })
    state.get.mockRejectedValueOnce(new Error('private item read failure'))
    const result = await graphql({
      schema: buildSchema(movpSchema),
      source: `query { contentCanEdit(itemId: "${item.id}") }`,
      contextValue: state.value,
    })

    expect(result.errors).toBeUndefined()
    expect(result.data).toEqual({ contentCanEdit: false })
    expect(state.reportContentCapabilityFailure).toHaveBeenCalledWith({
      requestId: state.value.requestId,
      actorId: state.value.userId,
      itemId: item.id,
      code: 'content_edit_check_failed',
    })
    expect(JSON.stringify(state.reportContentCapabilityFailure.mock.calls)).not.toContain(
      'private item read failure',
    )
  })

  it('checks edit capability against the caller-visible item workspace', async () => {
    const state = context({ status: 'saved', revisionId: 'revision-2' })
    const result = await graphql({
      schema: buildSchema(movpSchema),
      source: `query { contentCanEdit(itemId: "${item.id}") }`,
      contextValue: state.value,
    })

    expect(result.errors).toBeUndefined()
    expect(result.data).toEqual({ contentCanEdit: true })
    expect(state.get).toHaveBeenCalledWith(item.id)
    expect(state.rpc).toHaveBeenCalledWith('has_content_capability', {
      ws: item.workspace_id,
      cap: 'edit',
    })
  })

  it('fails the advisory capability probe closed and reports operational failure', async () => {
    const state = context({ status: 'saved', revisionId: 'revision-2' }, { rpcError: true })
    const result = await graphql({
      schema: buildSchema(movpSchema),
      source: `query { contentCanEdit(itemId: "${item.id}") }`,
      contextValue: state.value,
    })

    expect(result.errors).toBeUndefined()
    expect(result.data).toEqual({ contentCanEdit: false })
    expect(state.reportContentCapabilityFailure).toHaveBeenCalledTimes(1)
    expect(state.reportContentCapabilityFailure).toHaveBeenCalledWith({
      requestId: state.value.requestId,
      actorId: state.value.userId,
      itemId: item.id,
      workspaceId: item.workspace_id,
      code: 'content_edit_check_failed',
    })
    expect(JSON.stringify(state.reportContentCapabilityFailure.mock.calls)).not.toContain('XX000')
  })

  it('routes one structurally stable save result to the domain method', async () => {
    const state = context({ status: 'saved', revisionId: 'revision-2' })
    const body = '{"type":"doc","content":[]}'
    const result = await graphql({
      schema: buildSchema(movpSchema),
      source: `mutation {
        updateRichTextField(input: {
          itemId: "${item.id}"
          fieldKey: "body"
          body: ${JSON.stringify(body)}
          expectedRevisionId: "d5000000-0000-4000-8000-000000000001"
        }) { status revisionId code }
      }`,
      contextValue: state.value,
    })

    expect(result.errors).toBeUndefined()
    expect(result.data).toEqual({
      updateRichTextField: { status: 'saved', revisionId: 'revision-2', code: null },
    })
    expect(state.updateRichTextField).toHaveBeenCalledTimes(1)
    expect(state.updateRichTextField).toHaveBeenCalledWith({
      itemId: item.id,
      fieldKey: 'body',
      body,
      expectedRevisionId: 'd5000000-0000-4000-8000-000000000001',
    })
  })

  it('maps only the domain conflict to the sanitized CONFLICT contract', async () => {
    const conflict = context({ status: 'conflict' })
    const yoga = createYoga({ schema: movpSchema })
    const response = await yoga.handleRequest(
      new Request('http://localhost/graphql', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          query: `mutation {
            updateRichTextField(input: {
              itemId: "${item.id}"
              fieldKey: "body"
              body: "private body"
              expectedRevisionId: "d5000000-0000-4000-8000-000000000001"
            }) { status }
          }`,
        }),
      }),
      conflict.value,
    )
    const body = await response.json() as {
      errors?: Array<{ message: string; extensions?: Record<string, unknown> }>
    }

    expect(body.errors?.[0]).toMatchObject({
      message: 'This content was updated by someone else.',
      extensions: { code: 'CONFLICT' },
    })
    expect(JSON.stringify(body)).not.toContain('private body')

    const ordinary = context({ status: 'error', code: 'not_allowlisted_private_detail' })
    const ordinaryResult = await graphql({
      schema: buildSchema(movpSchema),
      source: `mutation {
        updateRichTextField(input: {
          itemId: "${item.id}"
          fieldKey: "body"
          body: "private body"
          expectedRevisionId: "d5000000-0000-4000-8000-000000000001"
        }) { status code }
      }`,
      contextValue: ordinary.value,
    })
    expect(ordinaryResult.errors).toBeUndefined()
    expect(ordinaryResult.data).toEqual({
      updateRichTextField: { status: 'error', code: 'content_save_failed' },
    })
    expect(JSON.stringify(ordinaryResult)).not.toContain('not_allowlisted_private_detail')
    expect(JSON.stringify(ordinaryResult)).not.toContain('private body')
  })

  it('preserves the stable edit-denial code', async () => {
    const state = context({ status: 'error', code: 'content_edit_forbidden' })
    const result = await graphql({
      schema: buildSchema(movpSchema),
      source: `mutation {
        updateRichTextField(input: {
          itemId: "${item.id}"
          fieldKey: "body"
          body: "{\\"type\\":\\"doc\\",\\"content\\":[]}"
          expectedRevisionId: "d5000000-0000-4000-8000-000000000001"
        }) { status code }
      }`,
      contextValue: state.value,
    })

    expect(result.errors).toBeUndefined()
    expect(result.data).toEqual({
      updateRichTextField: { status: 'error', code: 'content_edit_forbidden' },
    })
  })
})
