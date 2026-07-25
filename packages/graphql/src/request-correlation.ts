const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type RequestCorrelation = Readonly<{
  requestId: string
  traceId: string
  clientRequestId?: string
}>

export function createRequestCorrelation(
  incomingRequestId: string,
  randomUUID: () => string = () => crypto.randomUUID(),
): RequestCorrelation {
  const requestId = randomUUID()
  const traceId = randomUUID()
  return {
    requestId,
    traceId,
    ...(UUID.test(incomingRequestId) ? { clientRequestId: incomingRequestId } : {}),
  }
}
