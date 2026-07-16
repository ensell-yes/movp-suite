// @spike/oracle — Node-only. NEVER imported from a browser/client path (§6).
import { createClient } from '@supabase/supabase-js'
import { makeContentService } from '@movp/domain'
import { FIXTURE_FIELD_SCHEMA } from '@spike/fixture'

export interface RpcCapture {
  rpc: string
  p_data?: Record<string, unknown>
  p_content_hash?: string
  p_expected_revision_id?: string | null
}

export interface LifecycleOracle {
  service: ReturnType<typeof makeContentService>
  captures: RpcCapture[]
  currentRevisionId(): string
  publishedRevisionId(): string | null
  forcePublishedRevision(id: string): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseRpcBody(init: RequestInit | undefined): Record<string, unknown> {
  if (!init?.body) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(String(init.body))
  } catch {
    throw new Error('oracle_invalid_rpc_body')
  }
  if (!isRecord(parsed)) throw new Error('oracle_invalid_rpc_body')
  return parsed
}

export function requireRevisionFields(
  body: Record<string, unknown>,
): { data: Record<string, unknown>; hash: string } {
  if (!isRecord(body.p_data) || typeof body.p_content_hash !== 'string') {
    throw new Error('oracle_invalid_rpc_body')
  }
  return { data: body.p_data, hash: body.p_content_hash }
}

export function requireExpectedRevisionId(body: Record<string, unknown>): string | null {
  const value = body.p_expected_revision_id
  if (value !== null && typeof value !== 'string') {
    throw new Error('oracle_invalid_rpc_body')
  }
  return value
}

export function makeLifecycleOracle(): LifecycleOracle {
  const captures: RpcCapture[] = []
  const revisions = new Map<string, { data: Record<string, unknown>; content_hash: string }>()
  let revSeq = 0
  const item: {
    id: string
    content_type_id: string
    current_revision_id: string
    published_revision_id: string | null
  } = {
    id: 'item',
    content_type_id: 'ct',
    current_revision_id: '',
    published_revision_id: null,
  }

  const json = (obj: unknown, ct = 'application/json'): Response =>
    new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': ct } })

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const body = parseRpcBody(init)
    if (url.includes('/rest/v1/content_type')) {
      return json({ field_schema: FIXTURE_FIELD_SCHEMA }, 'application/vnd.pgrst.object+json')
    }
    if (url.includes('/rest/v1/content_revision')) {
      const id = decodeURIComponent(/id=eq\.([^&]+)/.exec(url)?.[1] ?? '')
      const rev = revisions.get(id)
      return json(rev ? { id, ...rev } : null, 'application/vnd.pgrst.object+json')
    }
    if (url.includes('/rest/v1/content_item')) {
      return json({ ...item }, 'application/vnd.pgrst.object+json')
    }
    if (url.includes('/rpc/create_content_with_revision')) {
      const rev = `r${++revSeq}`
      const fields = requireRevisionFields(body)
      captures.push({
        rpc: 'create_content_with_revision',
        p_data: fields.data,
        p_content_hash: fields.hash,
      })
      revisions.set(rev, { data: fields.data, content_hash: fields.hash })
      item.current_revision_id = rev
      return json({ id: item.id, current_revision_id: rev })
    }
    if (url.includes('/rpc/update_content')) {
      const rev = `r${++revSeq}`
      const fields = requireRevisionFields(body)
      const expectedRevisionId = requireExpectedRevisionId(body)
      captures.push({
        rpc: 'update_content',
        p_data: fields.data,
        p_content_hash: fields.hash,
        p_expected_revision_id: expectedRevisionId,
      })
      revisions.set(rev, { data: fields.data, content_hash: fields.hash })
      item.current_revision_id = rev
      return json({ id: item.id, current_revision_id: rev })
    }
    if (url.includes('/rpc/publish_content')) {
      item.published_revision_id = item.current_revision_id
      captures.push({ rpc: 'publish_content' })
      return json({ id: item.id, published_revision_id: item.published_revision_id })
    }
    throw new Error(`oracle: unexpected request ${url}`)
  }

  const db = createClient('http://spike.invalid', 'stub-anon-key', {
    global: { fetch: fakeFetch },
  })
  const service = makeContentService({ db, userId: 'spike-user' })
  return {
    service,
    captures,
    currentRevisionId: () => item.current_revision_id,
    publishedRevisionId: () => item.published_revision_id,
    forcePublishedRevision: (id: string) => {
      item.published_revision_id = id
    },
  }
}

export async function hashOnce(data: Record<string, unknown>): Promise<string> {
  const oracle = makeLifecycleOracle()
  await oracle.service.create({
    workspaceId: 'ws',
    contentTypeId: 'ct',
    slug: 's',
    data,
  })
  const capture = oracle.captures.find((entry) => entry.rpc === 'create_content_with_revision')
  if (!capture?.p_content_hash) throw new Error('hashOnce: no create hash captured')
  return capture.p_content_hash
}
