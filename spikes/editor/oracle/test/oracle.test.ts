import { describe, expect, it } from 'vitest'
import {
  hashOnce,
  makeLifecycleOracle,
  parseRpcBody,
  requireExpectedRevisionId,
  requireRevisionFields,
} from '../src/index.ts'

const rec = (body: string) => ({ title: 'T', body, meta: { a: 1 } })
const bodyOf = (value: unknown): string => {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('revision' in value) ||
    typeof value.revision !== 'object' ||
    value.revision === null ||
    !('data' in value.revision) ||
    typeof value.revision.data !== 'object' ||
    value.revision.data === null ||
    !('body' in value.revision.data) ||
    typeof value.revision.data.body !== 'string'
  ) {
    throw new Error('test: malformed published body')
  }
  return value.revision.data.body
}

describe('lifecycle oracle', () => {
  it('hashOnce is deterministic and content-sensitive', async () => {
    const h1 = await hashOnce(rec('x'))
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
    expect(await hashOnce(rec('x'))).toBe(h1)
    expect(await hashOnce(rec('y'))).not.toBe(h1)
  })

  it('runs create -> update -> publish in order and captures hashes', async () => {
    const o = makeLifecycleOracle()
    await o.service.create({ workspaceId: 'ws', contentTypeId: 'ct', slug: 's', data: rec('v1') })
    const r1 = o.currentRevisionId()
    await o.service.update({ itemId: 'item', expectedRevisionId: r1, data: rec('v2') })
    const r2 = o.currentRevisionId()
    await o.service.publish({ itemId: 'item' })
    expect(o.captures.map((c) => c.rpc)).toEqual([
      'create_content_with_revision',
      'update_content',
      'publish_content',
    ])
    expect(o.captures[1]?.p_expected_revision_id).toBe(r1)
    expect(o.publishedRevisionId()).toBe(r2)
  })

  it('getPublished reads the published revision; forcePublishedRevision reverts it', async () => {
    const o = makeLifecycleOracle()
    await o.service.create({ workspaceId: 'ws', contentTypeId: 'ct', slug: 's', data: rec('v1') })
    const r1 = o.currentRevisionId()
    await o.service.update({ itemId: 'item', expectedRevisionId: r1, data: rec('v2') })
    const r2 = o.currentRevisionId()
    await o.service.publish({ itemId: 'item' })
    const pub = await o.service.getPublished('item')
    expect(pub?.revision.id).toBe(r2)
    expect(bodyOf(pub)).toBe('v2')
    o.forcePublishedRevision(r1)
    const stale = await o.service.getPublished('item')
    expect(bodyOf(stale)).toBe('v1')
  })

  it('rejects malformed RPC bodies without unchecked casts', () => {
    expect(() => parseRpcBody({ body: '{not json' })).toThrow(/oracle_invalid_rpc_body/)
    expect(() => requireRevisionFields({ p_data: 'nope' })).toThrow(/oracle_invalid_rpc_body/)
    expect(() => requireExpectedRevisionId({ p_expected_revision_id: false })).toThrow(
      /oracle_invalid_rpc_body/,
    )
  })
})
