const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const FIELD_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/
const MAX_RESPONSE_BYTES = 1_048_576

export interface OverlayRegion {
  itemId: string
  fieldKey: string
  body: string
  revisionId: string
}

export type OverlayHostOptions = {
  canEdit(region: Pick<OverlayRegion, 'itemId' | 'fieldKey'>): Promise<boolean>
  resolveEditable(
    region: Pick<OverlayRegion, 'itemId' | 'fieldKey'>,
  ): Promise<OverlayRegion | null>
  save(
    region: OverlayRegion,
    body: string,
  ): Promise<
    | { status: 'saved'; revisionId: string }
    | { status: 'conflict' }
    | { status: 'error'; code: string }
  >
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
  } catch {
    return null
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function createOverlayHostOptions(fetchImpl: typeof fetch = fetch): OverlayHostOptions {
  return {
    async canEdit() {
      return true
    },
    async resolveEditable(reference) {
      if (!UUID.test(reference.itemId) || !FIELD_KEY.test(reference.fieldKey)) return null
      const response = await fetchImpl(
        `/api/content/${encodeURIComponent(reference.itemId)}/richtext?fieldKey=${encodeURIComponent(reference.fieldKey)}`,
        { credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' } },
      )
      if (!response.ok) return null
      const value = record(await boundedJson(response))
      if (
        !value
        || typeof value.body !== 'string'
        || typeof value.revisionId !== 'string'
        || value.revisionId.length === 0
      ) return null
      return { ...reference, body: value.body, revisionId: value.revisionId }
    },
    async save(region, body) {
      if (!UUID.test(region.itemId) || !FIELD_KEY.test(region.fieldKey)) {
        return { status: 'error', code: 'invalid_request' }
      }
      let response: Response
      try {
        response = await fetchImpl(`/api/content/${encodeURIComponent(region.itemId)}/richtext`, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            fieldKey: region.fieldKey,
            body,
            expectedRevisionId: region.revisionId,
          }),
        })
      } catch {
        return { status: 'error', code: 'save_failed' }
      }
      if (response.status === 409) return { status: 'conflict' }
      if (response.status === 401) return { status: 'error', code: 'auth_error' }
      const value = record(await boundedJson(response))
      if (value?.status === 'saved' && typeof value.revisionId === 'string') {
        return { status: 'saved', revisionId: value.revisionId }
      }
      const safeCodes = new Set([
        'auth_error',
        'content_edit_forbidden',
        'content_revision_invalid',
        'content_revision_not_found',
        'content_save_failed',
        'content_schema_invalid',
        'invalid_request',
        'not_found',
        'save_failed',
      ])
      const code = typeof value?.code === 'string' && safeCodes.has(value.code)
        ? value.code
        : 'save_failed'
      return { status: 'error', code }
    },
  }
}
