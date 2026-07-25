import { graphql } from 'graphql/index.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { schema as movpSchema } from '@movp/core-schema'
import { buildSchema } from '../src/schema.ts'
import { sha256Hex } from '../src/index.ts'

const itemId = 'd1000000-0000-4000-8000-000000000001'
const actorId = 'd2000000-0000-4000-8000-000000000001'
const requestId = 'd3000000-0000-4000-8000-000000000001'
const workspaceId = 'd5000000-0000-4000-8000-000000000001'
const submittedBody = '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"PRIVATE"}]}]}'
const reportContentSave = vi.fn()
const updateRichTextField = vi.fn()

function context() {
  return {
    db: {} as never,
    userId: actorId,
    requestId,
    domain: { content: { updateRichTextField } } as never,
    reportContentSave,
  }
}

async function run(): Promise<{
  data?: unknown
  errors?: ReadonlyArray<unknown>
}> {
  return await graphql({
    schema: buildSchema(movpSchema),
    source: `mutation {
      updateRichTextField(input: {
        itemId: "${itemId}"
        fieldKey: "body"
        body: ${JSON.stringify(submittedBody)}
        expectedRevisionId: "d4000000-0000-4000-8000-000000000001"
      }) { status revisionId code }
    }`,
    contextValue: context(),
  })
}

describe('rich-text field resolver observability', () => {
  beforeEach(() => {
    reportContentSave.mockReset()
    updateRichTextField.mockReset()
  })

  it('pins the GraphQL workspace hash to the canonical SHA-256 vector', async () => {
    await expect(sha256Hex('workspace-1')).resolves.toBe(
      '484d4f88b59b95fc9409ad7018107c51e26f7cc196e3e48caa9f7ccbfb509fbf',
    )
  })

  it.each([
    [
      { status: 'saved', revisionId: 'revision-2', workspaceId },
      'saved',
      'ok',
    ],
    [
      { status: 'conflict', workspaceId },
      'conflict',
      'content_update_conflict',
    ],
    [
      { status: 'error', code: 'content_field_not_found', workspaceId },
      'error',
      'content_field_not_found',
    ],
  ] as const)('emits exactly one content-disciplined resolver event for %#', async (
    domainResult,
    outcome,
    errorCode,
  ) => {
    updateRichTextField.mockResolvedValueOnce(domainResult)

    await run()

    expect(reportContentSave).toHaveBeenCalledTimes(1)
    expect(reportContentSave).toHaveBeenCalledWith({
      requestId,
      actorId,
      itemId,
      fieldKey: 'body',
      workspaceId,
      outcome,
      errorCode,
      latencyMs: expect.any(Number),
    })
    const serialized = JSON.stringify(reportContentSave.mock.calls)
    expect(serialized).not.toContain('PRIVATE')
    expect(serialized).not.toContain('token')
    expect(serialized).not.toContain('cookie')
    expect(serialized).not.toContain('content_hash')
  })

  it('never reports unvalidated identifier input', async () => {
    const maliciousItemId = 'victim@example.test'
    const maliciousFieldKey = 'body token=private'
    await graphql({
      schema: buildSchema(movpSchema),
      source: `mutation {
        updateRichTextField(input: {
          itemId: "${maliciousItemId}"
          fieldKey: "${maliciousFieldKey}"
          body: ${JSON.stringify(submittedBody)}
          expectedRevisionId: "d4000000-0000-4000-8000-000000000001"
        }) { status code }
      }`,
      contextValue: context(),
    })

    expect(reportContentSave).toHaveBeenCalledTimes(1)
    expect(reportContentSave).toHaveBeenCalledWith(expect.objectContaining({
      itemId: '00000000-0000-4000-8000-000000000000',
      fieldKey: 'invalid',
      outcome: 'error',
      errorCode: 'content_invalid_request',
    }))
    const serialized = JSON.stringify(reportContentSave.mock.calls)
    expect(serialized).not.toContain(maliciousItemId)
    expect(serialized).not.toContain(maliciousFieldKey)
    expect(serialized).not.toContain('PRIVATE')
  })
})
