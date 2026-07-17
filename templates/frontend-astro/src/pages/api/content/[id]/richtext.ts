import type { APIRoute } from 'astro'
import { isDocShape } from '@movp/richtext'
import { readServerEnv } from '../../../../lib/env.ts'
import { getSessionToken } from '../../../../lib/session.ts'
import { gqlRequest } from '../../../../lib/graphql.ts'
import { CONTENT_ITEM_QUERY, UPDATE_CONTENT_MUTATION } from '../../../../lib/content-queries.ts'

export const MAX_BODY_BYTES = 262_144

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type Outcome =
  | 'too_large'
  | 'validation'
  | 'unauthorized'
  | 'not_found'
  | 'saved'
  | 'conflict'
  | 'error'
  | 'read_ok'

type OutcomeRow = {
  outcome: Outcome
  status: number
  body: Record<string, unknown>
}

type HandlerResult = OutcomeRow & {
  itemId?: string
  fieldKey?: string
}

type ContentItemNode = {
  data?: string | null
  current_revision_id?: string | null
  content_type?: { field_schema?: string | null } | null
}

type FieldDef = {
  name: string
  type?: string
}

/** Read the request stream with a hard byte cap before buffering. */
export async function boundedText(request: Request, max: number): Promise<string | null> {
  const reader = request.body?.getReader()
  if (!reader) return ''

  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }

  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

/** Classify conflicts from the structured GraphQL extension code, which survives error masking. */
export function classifyOutcome(result: {
  ok: false
  code: string
  message?: string
  errorCode?: string
}): OutcomeRow {
  if (result.code === 'auth_error') {
    return {
      outcome: 'unauthorized',
      status: 401,
      body: { status: 'error', code: 'auth_error' },
    }
  }
  if (result.errorCode === 'CONFLICT') {
    return { outcome: 'conflict', status: 409, body: { status: 'conflict' } }
  }
  return {
    outcome: 'error',
    status: 500,
    body: { status: 'error', code: 'save_failed' },
  }
}

/** UTF-8 byte length, matching the request-boundary limit. */
export function fieldKeyBytes(value: string): number {
  return new TextEncoder().encode(value).length
}

/** Structurally validate persisted field schema before use. */
export function parseSchema(raw: string | null): FieldDef[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw ?? '[]')
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null

  const fields: FieldDef[] = []
  for (const field of parsed) {
    if (!field || typeof field !== 'object' || Array.isArray(field)) return null
    const name = (field as { name?: unknown }).name
    const type = (field as { type?: unknown }).type
    if (typeof name !== 'string') return null
    fields.push({ name, type: typeof type === 'string' ? type : undefined })
  }
  return fields
}

/** Structurally validate persisted item data before use. */
export function parseData(raw: string | null): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw ?? '{}')
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

export function emit(row: {
  outcome: Outcome
  itemId?: string
  fieldKey?: string
  startedAt: number
}): void {
  // Only validated identifiers and bounded metadata cross this logging boundary; never payloads or tokens.
  console.log(JSON.stringify({
    event: 'content.richtext_save',
    outcome: row.outcome,
    item_id: row.itemId,
    field_key: row.fieldKey,
    request_id: crypto.randomUUID(),
    latency_ms: Date.now() - row.startedAt,
  }))
}

function finish(result: HandlerResult, startedAt: number): Response {
  emit({
    outcome: result.outcome,
    itemId: result.itemId,
    fieldKey: result.fieldKey,
    startedAt,
  })
  return Response.json(result.body, { status: result.status })
}

function errorResult(itemId?: string): HandlerResult {
  return {
    outcome: 'error',
    status: 500,
    body: { status: 'error', code: 'save_failed' },
    itemId,
  }
}

function parsePostInput(raw: string): {
  fieldKey: string
  body: string
  expectedRevisionId: string
} | null {
  let input: unknown
  try {
    input = JSON.parse(raw || '{}')
  } catch {
    return null
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const values = input as Record<string, unknown>
  if (
    typeof values.fieldKey !== 'string'
    || typeof values.body !== 'string'
    || typeof values.expectedRevisionId !== 'string'
  ) {
    return null
  }
  return {
    fieldKey: values.fieldKey,
    body: values.body,
    expectedRevisionId: values.expectedRevisionId,
  }
}

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const startedAt = Date.now()
  const id = String(params.id ?? '')
  const validatedItemId = UUID.test(id) ? id : undefined
  let result: HandlerResult

  try {
    const token = getSessionToken(cookies)
    if (!token) {
      result = {
        outcome: 'unauthorized',
        status: 401,
        body: { status: 'error', code: 'auth_error' },
      }
    } else {
      const raw = await boundedText(request, MAX_BODY_BYTES)
      if (raw === null) {
        result = {
          outcome: 'too_large',
          status: 413,
          body: { status: 'error', code: 'body_too_large' },
          itemId: validatedItemId,
        }
      } else {
        const input = parsePostInput(raw)
        let parsedBody: unknown
        if (input) {
          try {
            parsedBody = JSON.parse(input.body)
          } catch {
            parsedBody = undefined
          }
        }

        const validInput = input
          && UUID.test(id)
          && UUID.test(input.expectedRevisionId)
          && input.fieldKey.length > 0
          && fieldKeyBytes(input.fieldKey) <= 256
          && isDocShape(parsedBody)

        if (!validInput || !input) {
          result = {
            outcome: 'validation',
            status: 422,
            body: { status: 'error', code: 'invalid_request' },
            itemId: validatedItemId,
          }
        } else {
          // Resolve request-bound workerd env and credentials at call time, never at module initialization.
          const { graphqlEndpoint } = readServerEnv()
          const read = await gqlRequest<{ contentItem: ContentItemNode | null }>(
            { endpoint: graphqlEndpoint, token },
            CONTENT_ITEM_QUERY,
            { id },
          )

          if (!read.ok) {
            result = { ...classifyOutcome(read), itemId: validatedItemId }
          } else if (!read.data.contentItem) {
            result = {
              outcome: 'not_found',
              status: 404,
              body: { status: 'error', code: 'not_found' },
              itemId: validatedItemId,
            }
          } else {
            const item = read.data.contentItem
            const schema = parseSchema(item.content_type?.field_schema ?? null)
            const current = parseData(item.data ?? '{}')
            if (!schema || !current) {
              result = errorResult(validatedItemId)
            } else if (!schema.some((field) => field.name === input.fieldKey && field.type === 'richtext')) {
              result = {
                outcome: 'validation',
                status: 422,
                body: { status: 'error', code: 'invalid_request' },
                itemId: validatedItemId,
              }
            } else {
              const merged = { ...current, [input.fieldKey]: input.body }
              const write = await gqlRequest<{
                updateContent: { id: string; status: string; current_revision_id: string }
              }>(
                { endpoint: graphqlEndpoint, token },
                UPDATE_CONTENT_MUTATION,
                {
                  id,
                  data: JSON.stringify(merged),
                  expectedRevisionId: input.expectedRevisionId,
                },
              )
              if (!write.ok) {
                result = {
                  ...classifyOutcome(write),
                  itemId: validatedItemId,
                  fieldKey: input.fieldKey,
                }
              } else {
                result = {
                  outcome: 'saved',
                  status: 200,
                  body: {
                    status: 'saved',
                    revisionId: write.data.updateContent.current_revision_id,
                  },
                  itemId: validatedItemId,
                  fieldKey: input.fieldKey,
                }
              }
            }
          }
        }
      }
    }
  } catch {
    result = errorResult(validatedItemId)
  }

  return finish(result, startedAt)
}

export const GET: APIRoute = async ({ params, request, cookies }) => {
  const startedAt = Date.now()
  const id = String(params.id ?? '')
  const validatedItemId = UUID.test(id) ? id : undefined
  let result: HandlerResult

  try {
    const fieldKey = new URL(request.url).searchParams.get('fieldKey') ?? ''
    const token = getSessionToken(cookies)
    if (!token) {
      result = {
        outcome: 'unauthorized',
        status: 401,
        body: { status: 'error', code: 'auth_error' },
      }
    } else if (!UUID.test(id) || !fieldKey || fieldKeyBytes(fieldKey) > 256) {
      result = {
        outcome: 'validation',
        status: 422,
        body: { status: 'error', code: 'invalid_request' },
        itemId: validatedItemId,
      }
    } else {
      // Resolve request-bound workerd env and credentials at call time, never at module initialization.
      const { graphqlEndpoint } = readServerEnv()
      const read = await gqlRequest<{ contentItem: ContentItemNode | null }>(
        { endpoint: graphqlEndpoint, token },
        CONTENT_ITEM_QUERY,
        { id },
      )
      if (!read.ok) {
        result = { ...classifyOutcome(read), itemId: validatedItemId }
      } else if (!read.data.contentItem) {
        result = {
          outcome: 'not_found',
          status: 404,
          body: { status: 'error', code: 'not_found' },
          itemId: validatedItemId,
        }
      } else {
        const item = read.data.contentItem
        const schema = parseSchema(item.content_type?.field_schema ?? null)
        const data = parseData(item.data ?? '{}')
        if (!schema || !data) {
          result = errorResult(validatedItemId)
        } else if (!schema.some((field) => field.name === fieldKey && field.type === 'richtext')) {
          result = {
            outcome: 'validation',
            status: 422,
            body: { status: 'error', code: 'invalid_request' },
            itemId: validatedItemId,
          }
        } else {
          const value = data[fieldKey]
          result = {
            outcome: 'read_ok',
            status: 200,
            body: {
              body: typeof value === 'string' ? value : '',
              revisionId: item.current_revision_id ?? '',
            },
            itemId: validatedItemId,
            fieldKey,
          }
        }
      }
    }
  } catch {
    result = errorResult(validatedItemId)
  }

  return finish(result, startedAt)
}
