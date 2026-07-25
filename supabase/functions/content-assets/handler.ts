const ASSET_MAX_BYTES = 25 * 1024 * 1024
const ASSET_ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
])

type QueryError = { code?: string }
type QueryResult<T> = { data: T | null; error: QueryError | null }

export type ContentAssetsCaller = {
  userId: string
  resolveWorkspace: (workspaceId: string) => Promise<QueryResult<string>>
  resolveAsset: (
    assetId: string,
  ) => Promise<QueryResult<{ workspaceId: string; r2Key: string }>>
  checkEdit: (workspaceId: string, signal: AbortSignal) => Promise<QueryResult<boolean>>
}

type AssetInsert = {
  id: string
  workspace_id: string
  filename: string
  mime: string
  r2_key: string
  size_bytes: number
  uploaded_by: string
}

export type ContentAssetsAdmin = {
  insertAsset: (row: AssetInsert) => Promise<{ error: QueryError | null }>
  finalizeAsset: (
    assetId: string,
    patch: {
      size_bytes: number
      checksum: string
      width: number | null
      height: number | null
    },
  ) => Promise<QueryResult<unknown>>
}

export type ContentAssetsStorage = {
  signUpload: (input: {
    workspaceId: string
    r2Key: string
    mime: string
  }) => Promise<string>
  head: (r2Key: string) => Promise<Response>
}

type CapabilityFailureEvent = {
  event: 'content.asset_capability'
  request_id: string
  workspace_id_hash: string
  actor_id: string
  surface: 'content_assets'
  operation: 'issue' | 'finalize'
  outcome: 'denied' | 'error'
  reason: 'forbidden' | 'timeout' | 'transport'
  error_code: 'content_edit_forbidden' | 'content_edit_check_failed'
  latency_ms: number
  redaction_version: 1
}

export type ContentAssetsDeps = {
  authenticate: (request: Request) => Promise<ContentAssetsCaller | null>
  createAdmin: () => ContentAssetsAdmin
  createStorage: () => ContentAssetsStorage
  emit: (event: CapabilityFailureEvent) => void
  hashWorkspaceId: (workspaceId: string) => Promise<string>
  randomUUID: () => string
  capabilityTimeoutMs: number
}

type IssueBody = {
  action: 'issue'
  workspaceId: string
  filename: string
  mime: string
  sizeBytes: number
}

type FinalizeBody = {
  action: 'finalize'
  assetId: string
  width: number | null
  height: number | null
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

export const hashWorkspaceId = async (workspaceId: string): Promise<string> => {
  const bytes = new TextEncoder().encode(workspaceId)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const optionalDimension = (value: unknown): number | null | undefined => {
  if (value === undefined || value === null) return null
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : undefined
}

const parseBody = (value: unknown): IssueBody | FinalizeBody | null => {
  if (!isRecord(value)) return null
  if (
    value.action === 'issue'
    && typeof value.workspaceId === 'string'
    && value.workspaceId.length > 0
    && typeof value.filename === 'string'
    && value.filename.length > 0
    && typeof value.mime === 'string'
    && Number.isInteger(value.sizeBytes)
  ) {
    return {
      action: 'issue',
      workspaceId: value.workspaceId,
      filename: value.filename,
      mime: value.mime,
      sizeBytes: Number(value.sizeBytes),
    }
  }
  if (
    value.action === 'finalize'
    && typeof value.assetId === 'string'
    && value.assetId.length > 0
  ) {
    const width = optionalDimension(value.width)
    const height = optionalDimension(value.height)
    if (width === undefined || height === undefined) return null
    return { action: 'finalize', assetId: value.assetId, width, height }
  }
  return null
}

const capabilityDecision = async (
  caller: ContentAssetsCaller,
  workspaceId: string,
  timeoutMs: number,
): Promise<'allowed' | 'denied' | 'error' | 'timeout'> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const result = await caller.checkEdit(workspaceId, controller.signal)
    if (result.error || result.data === null) return 'error'
    return result.data ? 'allowed' : 'denied'
  } catch {
    return controller.signal.aborted ? 'timeout' : 'error'
  } finally {
    clearTimeout(timer)
  }
}

const authorize = async (
  deps: ContentAssetsDeps,
  caller: ContentAssetsCaller,
  workspaceId: string,
  operation: 'issue' | 'finalize',
  requestId: string,
): Promise<Response | null> => {
  const startedAt = performance.now()
  const decision = await capabilityDecision(
    caller,
    workspaceId,
    deps.capabilityTimeoutMs,
  )
  if (decision === 'allowed') return null

  const denied = decision === 'denied'
  const errorCode = denied
    ? 'content_edit_forbidden' as const
    : 'content_edit_check_failed' as const
  const reason = denied
    ? 'forbidden' as const
    : decision === 'timeout'
      ? 'timeout' as const
      : 'transport' as const
  deps.emit({
    event: 'content.asset_capability',
    request_id: requestId,
    workspace_id_hash: await deps.hashWorkspaceId(workspaceId),
    actor_id: caller.userId,
    surface: 'content_assets',
    operation,
    outcome: denied ? 'denied' : 'error',
    reason,
    error_code: errorCode,
    latency_ms: Math.max(0, Math.round(performance.now() - startedAt)),
    redaction_version: 1,
  })

  if (denied) return json(403, { error: errorCode })
  return json(decision === 'timeout' ? 503 : 500, { error: errorCode })
}

export const handleContentAssets = async (
  request: Request,
  deps: ContentAssetsDeps,
): Promise<Response> => {
  const caller = await deps.authenticate(request)
  if (!caller) return json(401, { error: 'unauthorized' })

  let rawBody: unknown
  try {
    rawBody = await request.json()
  } catch {
    return json(400, { error: 'invalid_body' })
  }
  if (
    isRecord(rawBody)
    && rawBody.action !== 'issue'
    && rawBody.action !== 'finalize'
  ) {
    return json(400, { error: 'unknown_action' })
  }
  const body = parseBody(rawBody)
  if (!body) return json(400, { error: 'invalid_body' })
  const requestId = deps.randomUUID()

  if (body.action === 'issue') {
    const workspace = await caller.resolveWorkspace(body.workspaceId)
    if (workspace.error) return json(500, { error: 'asset_workspace_read_failed' })
    if (!workspace.data) return json(404, { error: 'asset_workspace_not_found' })

    const rejected = await authorize(
      deps,
      caller,
      workspace.data,
      'issue',
      requestId,
    )
    if (rejected) return rejected
    if (!ASSET_ALLOWED_MIME.has(body.mime)) {
      return json(400, { error: 'disallowed_mime' })
    }
    if (
      body.sizeBytes <= 0
      || body.sizeBytes > ASSET_MAX_BYTES
    ) {
      return json(400, { error: 'size_out_of_bounds' })
    }

    const assetId = deps.randomUUID()
    const r2Key = `${workspace.data}/${assetId}`
    const admin = deps.createAdmin()
    const storage = deps.createStorage()
    const { error } = await admin.insertAsset({
      id: assetId,
      workspace_id: workspace.data,
      filename: body.filename,
      mime: body.mime,
      r2_key: r2Key,
      size_bytes: body.sizeBytes,
      uploaded_by: caller.userId,
    })
    if (error) return json(500, { error: 'asset_persist_failed' })

    const uploadUrl = await storage.signUpload({
      workspaceId: workspace.data,
      r2Key,
      mime: body.mime,
    })
    return json(200, { uploadUrl, r2Key, assetId })
  }

  const asset = await caller.resolveAsset(body.assetId)
  if (asset.error) return json(500, { error: 'asset_read_failed' })
  if (!asset.data) return json(404, { error: 'asset_not_found' })

  const rejected = await authorize(
    deps,
    caller,
    asset.data.workspaceId,
    'finalize',
    requestId,
  )
  if (rejected) return rejected

  const storage = deps.createStorage()
  const head = await storage.head(asset.data.r2Key)
  if (!head.ok) return json(409, { error: 'object_not_uploaded' })

  const sizeBytes = Number(head.headers.get('content-length') ?? '0')
  const checksum = (head.headers.get('etag') ?? '').replace(/"/g, '')
  const admin = deps.createAdmin()
  const finalized = await admin.finalizeAsset(body.assetId, {
    size_bytes: sizeBytes,
    checksum,
    width: body.width,
    height: body.height,
  })
  if (finalized.error || !finalized.data) {
    return json(500, { error: 'asset_finalize_failed' })
  }
  return json(200, finalized.data)
}
