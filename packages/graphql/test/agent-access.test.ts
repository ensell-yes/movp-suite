import { graphql } from 'graphql/index.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { schema as movpSchema } from '@movp/core-schema'
import { AdminDomainError } from '@movp/domain'
import { buildSchema } from '../src/schema.ts'
import { createYoga } from '../src/yoga.ts'

const mocks = vi.hoisted(() => ({
  createDomain: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
}))

vi.mock('@movp/domain', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createDomain: mocks.createDomain,
}))

mocks.createDomain.mockImplementation(() => ({
  agentAccess: { get: mocks.get, update: mocks.update },
}))

const schema = buildSchema(movpSchema)
const yoga = createYoga({ schema: movpSchema })

function contextValue(): { db: never; userId: string } {
  return { db: {} as never, userId: 'user-1' }
}

async function yogaQuery(source: string): Promise<{
  data?: Record<string, unknown> | null
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>
}> {
  const response = await yoga.handleRequest(new Request('http://localhost/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: source }),
  }), contextValue())
  return await response.json() as {
    data?: Record<string, unknown> | null
    errors?: Array<{ message: string; extensions?: Record<string, unknown> }>
  }
}

describe('agent access GraphQL surface', () => {
  beforeEach(() => {
    mocks.get.mockReset().mockResolvedValue({ mcpEnabled: true, cliEnabled: false })
    mocks.update.mockReset().mockResolvedValue({ mcpEnabled: false, cliEnabled: true })
  })

  it('returns the caller preferences', async () => {
    const result = await graphql({
      schema,
      source: 'query { agentAccessPreferences { mcpEnabled cliEnabled } }',
      contextValue: contextValue(),
    })

    expect(result.errors).toBeUndefined()
    expect(result.data?.agentAccessPreferences).toEqual({ mcpEnabled: true, cliEnabled: false })
    expect(mocks.get).toHaveBeenCalledOnce()
  })

  it('updates both preferences together', async () => {
    const result = await graphql({
      schema,
      source: `mutation {
        updateAgentAccessPreferences(mcpEnabled: false, cliEnabled: true) {
          mcpEnabled
          cliEnabled
        }
      }`,
      contextValue: contextValue(),
    })

    expect(result.errors).toBeUndefined()
    expect(result.data?.updateAgentAccessPreferences).toEqual({ mcpEnabled: false, cliEnabled: true })
    expect(mocks.update).toHaveBeenCalledWith(false, true)
  })

  it('exposes no caller-selected identity argument', () => {
    const queryField = schema.getQueryType()?.getFields().agentAccessPreferences
    const mutationField = schema.getMutationType()?.getFields().updateAgentAccessPreferences

    expect(queryField?.args).toEqual([])
    expect(mutationField?.args.map((arg) => [arg.name, String(arg.type)])).toEqual([
      ['cliEnabled', 'Boolean!'],
      ['mcpEnabled', 'Boolean!'],
    ])
  })

  it('requires both booleans on every update', async () => {
    const result = await graphql({
      schema,
      source: 'mutation { updateAgentAccessPreferences(mcpEnabled: false) { mcpEnabled } }',
      contextValue: contextValue(),
    })

    expect(result.errors?.[0]?.message).toContain('cliEnabled')
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('masks preference read failures at the Yoga boundary', async () => {
    mocks.get.mockRejectedValueOnce(new AdminDomainError(
      'agentAccessPreferences',
      '57014',
      'private database detail',
    ))

    const result = await yogaQuery('query { agentAccessPreferences { mcpEnabled cliEnabled } }')

    expect(result.errors?.[0]).toMatchObject({
      message: 'Unexpected error.',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    })
    expect(JSON.stringify(result)).not.toContain('private database detail')
  })

  it('masks preference update failures at the Yoga boundary', async () => {
    mocks.update.mockRejectedValueOnce(new AdminDomainError(
      'updateAgentAccessPreferences',
      '42501',
      'private authorization detail',
    ))

    const result = await yogaQuery(`mutation {
      updateAgentAccessPreferences(mcpEnabled: false, cliEnabled: false) { mcpEnabled cliEnabled }
    }`)

    expect(result.errors?.[0]).toMatchObject({
      message: 'Unexpected error.',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    })
    expect(JSON.stringify(result)).not.toContain('private authorization detail')
  })
})
