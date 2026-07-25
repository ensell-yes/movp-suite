import { describe, expect, it, vi } from 'vitest'
import { createRequestCorrelation } from '../src/index.ts'

const clientRequestId = 'd1000000-0000-4000-8000-000000000001'
const serverRequestId = 'd2000000-0000-4000-8000-000000000001'
const traceId = 'd3000000-0000-4000-8000-000000000001'

describe('GraphQL edge request correlation', () => {
  it('keeps a valid inbound UUID as client correlation while minting server identifiers', () => {
    const randomUUID = vi.fn()
      .mockReturnValueOnce(serverRequestId)
      .mockReturnValueOnce(traceId)

    expect(createRequestCorrelation(clientRequestId, randomUUID)).toEqual({
      requestId: serverRequestId,
      traceId,
      clientRequestId,
    })
    expect(randomUUID).toHaveBeenCalledTimes(2)
  })

  it('drops malformed inbound correlation without logging its value', () => {
    const randomUUID = vi.fn()
      .mockReturnValueOnce(serverRequestId)
      .mockReturnValueOnce(traceId)

    expect(createRequestCorrelation('victim@example.test', randomUUID)).toEqual({
      requestId: serverRequestId,
      traceId,
    })
  })
})
