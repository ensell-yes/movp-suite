import { describe, expect, it, vi } from 'vitest'
import { GraphQLError } from 'graphql'
import { schema as movpSchema } from '@movp/core-schema'
import { createYoga } from '../src/yoga.ts'

const mocks = vi.hoisted(() => ({ update: vi.fn() }))

vi.mock('@movp/domain', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createDomain: () => ({ content: { update: mocks.update } }),
}))

const yoga = createYoga({ schema: movpSchema })

async function run(source: string): Promise<{
  data?: unknown
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>
}> {
  const response = await yoga.handleRequest(
    new Request('http://localhost/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: source }),
    }),
    { db: {} as never, userId: 'u-1' },
  )
  return await response.json() as {
    data?: unknown
    errors?: Array<{ message: string; extensions?: Record<string, unknown> }>
  }
}

const MUTATION = `mutation {
  updateContent(
    id: "d1000000-0000-4000-8000-000000000001"
    data: "{}"
    expectedRevisionId: "d2000000-0000-4000-8000-000000000001"
  ) { id current_revision_id }
}`

describe('updateContent conflict boundary', () => {
  it('surfaces a content-update conflict as a sanitized CONFLICT code', async () => {
    mocks.update.mockRejectedValueOnce(
      new Error('domain.content.update failed [content_update_conflict]'),
    )

    const body = await run(MUTATION)

    expect(body.errors?.[0]).toMatchObject({
      message: 'This content was updated by someone else.',
      extensions: { code: 'CONFLICT' },
    })
    expect(JSON.stringify(body)).not.toContain('content_update_conflict')
    expect(JSON.stringify(body)).not.toContain('safeContentConflict')
  })

  it('still masks an ordinary internal error', async () => {
    mocks.update.mockRejectedValueOnce(new Error('some internal boom'))

    const body = await run(MUTATION)

    expect(body.errors?.[0]).toMatchObject({
      message: 'Unexpected error.',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    })
  })

  it('masks an unmarked CONFLICT GraphQLError', async () => {
    mocks.update.mockRejectedValueOnce(
      new GraphQLError('sensitive conflict detail', { extensions: { code: 'CONFLICT' } }),
    )

    const body = await run(MUTATION)

    expect(body.errors?.[0]).toMatchObject({
      message: 'Unexpected error.',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    })
    expect(JSON.stringify(body)).not.toContain('sensitive conflict detail')
  })
})
