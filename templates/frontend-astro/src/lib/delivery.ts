export type DeliveryPublicEnv = Readonly<{
  supabaseUrl: string
  supabaseAnonKey: string
  workspaceId: string
}>

export type PublishedContent = Readonly<{
  itemId: string
  contentType: string
  slug: string
  publishedRevisionId: string
  publishedAt: string
  data: Readonly<Record<string, unknown>>
  richTextFieldKeys: readonly string[]
  meta: unknown
  jsonld: unknown
}>

export type PublishedRoute = Readonly<{
  itemId: string
  contentType: string
  slug: string
  publishedRevisionId: string
  publishedAt: string
}>

export type DeliveryShard = Readonly<{
  after: string | null
  until: string
  count: number
}>

export type DeliveryErrorCode =
  | 'delivery_request_invalid'
  | 'delivery_upstream_aborted'
  | 'delivery_upstream_content_type'
  | 'delivery_upstream_invalid'
  | 'delivery_upstream_status'
  | 'delivery_upstream_timeout'
  | 'delivery_upstream_too_large'
  | 'delivery_shards_timeout'

export type DeliveryResult<T> =
  | Readonly<{ status: 'found'; value: T }>
  | Readonly<{ status: 'not_found' }>
  | Readonly<{ status: 'error'; code: DeliveryErrorCode }>

type Fetcher = typeof fetch

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_RICHTEXT_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 5_000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TYPE_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,127}$/
const FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,127}$/
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{4,128}$/
const CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f]/
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validSlug(value: unknown): value is string {
  return typeof value === 'string'
    && encoder.encode(value).byteLength >= 1
    && encoder.encode(value).byteLength <= 256
    && !value.includes('/')
    && !value.includes('\\')
    && !CONTROL_PATTERN.test(value)
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 64
    && !Number.isNaN(new Date(value).valueOf())
}

function validCursor(value: unknown): value is string {
  return typeof value === 'string' && CURSOR_PATTERN.test(value)
}

function validateEnv(value: DeliveryPublicEnv): boolean {
  if (
    !UUID_PATTERN.test(value.workspaceId)
    || value.supabaseAnonKey.length < 1
    || value.supabaseAnonKey.length > 16_384
  ) {
    return false
  }
  try {
    const url = new URL(value.supabaseUrl)
    return (url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
      && url.username === ''
      && url.password === ''
      && url.search === ''
      && url.hash === ''
  } catch {
    return false
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

async function readBoundedJson(response: Response): Promise<
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; code: DeliveryErrorCode }>
> {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    return { ok: false, code: 'delivery_upstream_content_type' }
  }

  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength)
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      return { ok: false, code: 'delivery_upstream_invalid' }
    }
    if (parsedLength > MAX_RESPONSE_BYTES) {
      return { ok: false, code: 'delivery_upstream_too_large' }
    }
  }
  if (!response.body) return { ok: false, code: 'delivery_upstream_invalid' }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        return { ok: false, code: 'delivery_upstream_too_large' }
      }
      chunks.push(part.value)
    }
  } catch {
    return { ok: false, code: 'delivery_upstream_aborted' }
  }

  const body = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { ok: true, value: JSON.parse(decoder.decode(body)) as unknown }
  } catch {
    return { ok: false, code: 'delivery_upstream_invalid' }
  }
}

function upstreamError(value: unknown): DeliveryErrorCode {
  if (isRecord(value) && value.message === 'delivery_shards_timeout') {
    return 'delivery_shards_timeout'
  }
  return 'delivery_upstream_status'
}

async function callRpc(
  env: DeliveryPublicEnv,
  name: string,
  body: Readonly<Record<string, unknown>>,
  fetcher: Fetcher,
): Promise<Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; code: DeliveryErrorCode }>> {
  if (!validateEnv(env)) return { ok: false, code: 'delivery_request_invalid' }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetcher(`${normalizeBaseUrl(env.supabaseUrl)}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        apikey: env.supabaseAnonKey,
        authorization: `Bearer ${env.supabaseAnonKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const parsed = await readBoundedJson(response)
    if (!parsed.ok) return parsed
    if (!response.ok) return { ok: false, code: upstreamError(parsed.value) }
    return parsed
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { ok: false, code: 'delivery_upstream_timeout' }
    }
    return { ok: false, code: 'delivery_upstream_aborted' }
  } finally {
    clearTimeout(timeout)
  }
}

function validatePublishedContent(value: unknown): PublishedContent | null {
  if (
    !isRecord(value)
    || !UUID_PATTERN.test(String(value.item_id))
    || typeof value.content_type_key !== 'string'
    || !TYPE_KEY_PATTERN.test(value.content_type_key)
    || !validSlug(value.slug)
    || !UUID_PATTERN.test(String(value.published_revision_id))
    || !validTimestamp(value.published_at)
    || !isRecord(value.data)
    || !Array.isArray(value.richtext_field_keys)
    || value.richtext_field_keys.length > 256
  ) {
    return null
  }
  const richTextFieldKeys: string[] = []
  const seenFieldKeys = new Set<string>()
  for (const fieldKey of value.richtext_field_keys) {
    if (
      typeof fieldKey !== 'string'
      || !FIELD_KEY_PATTERN.test(fieldKey)
      || seenFieldKeys.has(fieldKey)
    ) {
      return null
    }
    seenFieldKeys.add(fieldKey)
    richTextFieldKeys.push(fieldKey)
  }
  return {
    itemId: String(value.item_id),
    contentType: value.content_type_key,
    slug: value.slug,
    publishedRevisionId: String(value.published_revision_id),
    publishedAt: value.published_at,
    data: value.data,
    richTextFieldKeys,
    meta: value.meta ?? null,
    jsonld: value.jsonld ?? null,
  }
}

function validatePublishedRoute(value: unknown): PublishedRoute | null {
  if (
    !isRecord(value)
    || !UUID_PATTERN.test(String(value.item_id))
    || typeof value.content_type_key !== 'string'
    || !TYPE_KEY_PATTERN.test(value.content_type_key)
    || !validSlug(value.slug)
    || !UUID_PATTERN.test(String(value.published_revision_id))
    || !validTimestamp(value.published_at)
  ) {
    return null
  }
  return {
    itemId: String(value.item_id),
    contentType: value.content_type_key,
    slug: value.slug,
    publishedRevisionId: String(value.published_revision_id),
    publishedAt: value.published_at,
  }
}

export async function getPublishedBySlug(
  env: DeliveryPublicEnv,
  contentType: string,
  slug: string,
  fetcher: Fetcher = fetch,
): Promise<DeliveryResult<PublishedContent>> {
  if (!TYPE_KEY_PATTERN.test(contentType) || !validSlug(slug)) {
    return { status: 'error', code: 'delivery_request_invalid' }
  }
  const result = await callRpc(env, 'get_published_by_slug', {
    ws: env.workspaceId,
    p_content_type_key: contentType,
    p_slug: slug,
  }, fetcher)
  if (!result.ok) return { status: 'error', code: result.code }
  if (result.value === null) return { status: 'not_found' }
  const value = validatePublishedContent(result.value)
  return value
    ? { status: 'found', value }
    : { status: 'error', code: 'delivery_upstream_invalid' }
}

export async function listPublishedDelivery(
  env: DeliveryPublicEnv,
  options: Readonly<{ after: string | null; until: string | null; limit: number }>,
  fetcher: Fetcher = fetch,
): Promise<DeliveryResult<Readonly<{ items: readonly PublishedRoute[]; nextCursor: string | null }>>> {
  if (
    (options.after !== null && !validCursor(options.after))
    || (options.until !== null && !validCursor(options.until))
    || !Number.isInteger(options.limit)
    || options.limit < 1
    || options.limit > 1_000
  ) {
    return { status: 'error', code: 'delivery_request_invalid' }
  }
  const result = await callRpc(env, 'list_published_delivery', {
    ws: env.workspaceId,
    p_after: options.after,
    p_until: options.until,
    p_limit: options.limit,
  }, fetcher)
  if (!result.ok) return { status: 'error', code: result.code }
  if (!isRecord(result.value) || !Array.isArray(result.value.items)) {
    return { status: 'error', code: 'delivery_upstream_invalid' }
  }
  if (result.value.next_cursor !== null && !validCursor(result.value.next_cursor)) {
    return { status: 'error', code: 'delivery_upstream_invalid' }
  }
  const items = result.value.items.map(validatePublishedRoute)
  if (items.some((item) => item === null)) {
    return { status: 'error', code: 'delivery_upstream_invalid' }
  }
  return {
    status: 'found',
    value: {
      items: items.filter((item): item is PublishedRoute => item !== null),
      nextCursor: result.value.next_cursor,
    },
  }
}

export async function listPublishedDeliveryShards(
  env: DeliveryPublicEnv,
  fetcher: Fetcher = fetch,
): Promise<DeliveryResult<readonly DeliveryShard[]>> {
  const result = await callRpc(env, 'list_published_delivery_shards', {
    ws: env.workspaceId,
    p_urls_per_shard: 4_000,
  }, fetcher)
  if (!result.ok) return { status: 'error', code: result.code }
  if (!Array.isArray(result.value)) {
    return { status: 'error', code: 'delivery_upstream_invalid' }
  }
  const shards: DeliveryShard[] = []
  for (const candidate of result.value) {
    if (
      !isRecord(candidate)
      || (candidate.after !== null && !validCursor(candidate.after))
      || !validCursor(candidate.until)
      || !Number.isInteger(candidate.count)
      || Number(candidate.count) < 1
      || Number(candidate.count) > 4_000
    ) {
      return { status: 'error', code: 'delivery_upstream_invalid' }
    }
    shards.push({
      after: candidate.after,
      until: candidate.until,
      count: Number(candidate.count),
    })
  }
  return { status: 'found', value: shards }
}

export function parsePublishedRichText(value: unknown): unknown | null {
  if (typeof value !== 'string' || encoder.encode(value).byteLength > MAX_RICHTEXT_BYTES) {
    return null
  }
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) && parsed.type === 'doc' && Array.isArray(parsed.content)
      ? parsed
      : null
  } catch {
    return null
  }
}

export function parseDeclaredPublishedRichText(
  value: unknown,
  fieldKey: string,
  richTextFieldKeys: readonly string[],
): unknown | null {
  return richTextFieldKeys.includes(fieldKey) ? parsePublishedRichText(value) : null
}
