import type { APIRoute } from 'astro'
import { readServerEnv } from '../../../../lib/env.ts'
import { gqlRequest } from '../../../../lib/graphql.ts'
import { getSessionToken } from '../../../../lib/session.ts'
import { CONTENT_CAN_EDIT_QUERY } from '../../../../lib/content-queries.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function response(canEdit: boolean): Response {
  return Response.json({ canEdit }, {
    status: 200,
    headers: { 'cache-control': 'no-store' },
  })
}

export const GET: APIRoute = async ({ params, cookies }) => {
  const itemId = String(params.id ?? '')
  const token = getSessionToken(cookies)
  if (!token || !UUID.test(itemId)) return response(false)

  const requestId = crypto.randomUUID()
  try {
    const { graphqlEndpoint } = readServerEnv()
    const result = await gqlRequest<{ contentCanEdit: boolean }>(
      { endpoint: graphqlEndpoint, token, requestId },
      CONTENT_CAN_EDIT_QUERY,
      { itemId },
    )
    if (result.ok) return response(result.data.contentCanEdit === true)
    if (result.code === 'auth_error') return response(false)
  } catch {
    // The event below owns the bounded operational signal.
  }

  console.log(JSON.stringify({
    event: 'content.overlay_capability',
    outcome: 'error',
    item_id: itemId,
    request_id: requestId,
    error_code: 'content_edit_check_failed',
  }))
  return response(false)
}
