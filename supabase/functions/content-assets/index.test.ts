import {
  hashWorkspaceId,
  handleContentAssets,
  type ContentAssetsDeps,
} from './handler.ts'

const assertEquals = (actual: unknown, expected: unknown, message: string): void => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

const request = (body: unknown): Request =>
  new Request('http://localhost/functions/v1/content-assets', {
    method: 'POST',
    headers: {
      authorization: 'Bearer caller-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })

const responseBody = async (response: Response): Promise<unknown> => await response.json()

const eventAt = (events: unknown[], index: number): Record<string, unknown> => {
  const event = events[index]
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    throw new Error(`event ${index} is not a record`)
  }
  return event as Record<string, unknown>
}

const baseDeps = () => {
  let adminCalls = 0
  let storageCalls = 0
  const events: unknown[] = []

  const deps: ContentAssetsDeps = {
    authenticate: async () => ({
      userId: 'user-1',
      resolveWorkspace: async (workspaceId: string) => ({
        data: workspaceId,
        error: null,
      }),
      resolveAsset: async () => ({
        data: { workspaceId: 'workspace-1', r2Key: 'workspace-1/asset-1' },
        error: null,
      }),
      checkEdit: async () => ({ data: true, error: null }),
    }),
    createAdmin: () => {
      adminCalls += 1
      return {
        insertAsset: async () => ({ error: null }),
        finalizeAsset: async () => ({
          data: { id: 'asset-1', workspace_id: 'workspace-1' },
          error: null,
        }),
      }
    },
    createStorage: () => {
      storageCalls += 1
      return {
        signUpload: async () => 'https://upload.invalid/signed',
        head: async () =>
          new Response(null, {
            status: 200,
            headers: { 'content-length': '12', etag: '"etag-1"' },
          }),
      }
    },
    emit: (event: unknown) => {
      events.push(event)
    },
    hashWorkspaceId: async () => 'workspace-hash',
    randomUUID: () => '00000000-0000-4000-8000-000000000001',
    capabilityTimeoutMs: 25,
  }

  return {
    counts: () => ({ adminCalls, storageCalls }),
    events,
    deps,
  }
}

Deno.test('workspace correlation uses the canonical SHA-256 bytes', async () => {
  assertEquals(
    await hashWorkspaceId('workspace-1'),
    '484d4f88b59b95fc9409ad7018107c51e26f7cc196e3e48caa9f7ccbfb509fbf',
    'workspace hash',
  )
})

Deno.test('issue denial is 403 and constructs no privileged dependencies', async () => {
  const state = baseDeps()
  state.deps.authenticate = async () => ({
    userId: 'user-1',
    resolveWorkspace: async (workspaceId: string) => ({ data: workspaceId, error: null }),
    resolveAsset: async () => ({ data: null, error: null }),
    checkEdit: async () => ({ data: false, error: null }),
  })

  const response = await handleContentAssets(
    request({
      action: 'issue',
      workspaceId: 'workspace-1',
      filename: 'asset.png',
      mime: 'image/png',
      sizeBytes: 12,
    }),
    state.deps,
  )

  assertEquals(response.status, 403, 'denial status')
  assertEquals(await responseBody(response), { error: 'content_edit_forbidden' }, 'denial body')
  assertEquals(state.counts(), { adminCalls: 0, storageCalls: 0 }, 'privileged dependency count')
})

Deno.test('caller-invisible issue workspace is a non-enumerating 404', async () => {
  const state = baseDeps()
  state.deps.authenticate = async () => ({
    userId: 'user-1',
    resolveWorkspace: async () => ({ data: null, error: null }),
    resolveAsset: async () => ({ data: null, error: null }),
    checkEdit: async () => ({ data: true, error: null }),
  })

  const response = await handleContentAssets(
    request({
      action: 'issue',
      workspaceId: 'workspace-1',
      filename: 'asset.png',
      mime: 'image/png',
      sizeBytes: 12,
    }),
    state.deps,
  )

  assertEquals(response.status, 404, 'workspace lookup status')
  assertEquals(
    await responseBody(response),
    { error: 'asset_workspace_not_found' },
    'workspace lookup body',
  )
  assertEquals(state.counts(), { adminCalls: 0, storageCalls: 0 }, 'privileged dependency count')
})

Deno.test('finalize denial derives workspace from the caller-visible asset', async () => {
  const state = baseDeps()
  const checkedWorkspaces: string[] = []
  state.deps.authenticate = async () => ({
    userId: 'user-1',
    resolveWorkspace: async () => ({ data: null, error: null }),
    resolveAsset: async () => ({
      data: { workspaceId: 'workspace-from-asset', r2Key: 'workspace-from-asset/asset-1' },
      error: null,
    }),
    checkEdit: async (workspaceId: string) => {
      checkedWorkspaces.push(workspaceId)
      return { data: false, error: null }
    },
  })

  const response = await handleContentAssets(
    request({ action: 'finalize', assetId: 'asset-1', workspaceId: 'client-forgery' }),
    state.deps,
  )

  assertEquals(response.status, 403, 'denial status')
  assertEquals(checkedWorkspaces, ['workspace-from-asset'], 'checked workspace')
  assertEquals(state.counts(), { adminCalls: 0, storageCalls: 0 }, 'privileged dependency count')
})

Deno.test('capability transport failure is 500 and emits exactly one safe event', async () => {
  const state = baseDeps()
  state.deps.authenticate = async () => ({
    userId: 'user-1',
    resolveWorkspace: async (workspaceId: string) => ({ data: workspaceId, error: null }),
    resolveAsset: async () => ({ data: null, error: null }),
    checkEdit: async () => ({ data: null, error: { code: 'transport_failed' } }),
  })

  const response = await handleContentAssets(
    request({
      action: 'issue',
      workspaceId: 'workspace-1',
      filename: 'asset.png',
      mime: 'image/png',
      sizeBytes: 12,
    }),
    state.deps,
  )

  assertEquals(response.status, 500, 'transport failure status')
  assertEquals(await responseBody(response), { error: 'content_edit_check_failed' }, 'failure body')
  assertEquals(state.events.length, 1, 'event count')
  assertEquals(eventAt(state.events, 0).reason, 'transport', 'event reason')
  assertEquals(
    eventAt(state.events, 0).workspace_id_hash,
    'workspace-hash',
    'workspace correlation',
  )
  assertEquals(state.counts(), { adminCalls: 0, storageCalls: 0 }, 'privileged dependency count')
})

Deno.test('capability timeout is 503 and constructs no privileged dependencies', async () => {
  const state = baseDeps()
  state.deps.capabilityTimeoutMs = 1
  state.deps.authenticate = async () => ({
    userId: 'user-1',
    resolveWorkspace: async (workspaceId: string) => ({ data: workspaceId, error: null }),
    resolveAsset: async () => ({ data: null, error: null }),
    checkEdit: async (_workspaceId: string, signal: AbortSignal) =>
      await new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      }),
  })

  const response = await handleContentAssets(
    request({
      action: 'issue',
      workspaceId: 'workspace-1',
      filename: 'asset.png',
      mime: 'image/png',
      sizeBytes: 12,
    }),
    state.deps,
  )

  assertEquals(response.status, 503, 'timeout status')
  assertEquals(await responseBody(response), { error: 'content_edit_check_failed' }, 'timeout body')
  assertEquals(state.events.length, 1, 'event count')
  assertEquals(eventAt(state.events, 0).reason, 'timeout', 'event reason')
  assertEquals(
    eventAt(state.events, 0).workspace_id_hash,
    'workspace-hash',
    'workspace correlation',
  )
  assertEquals(state.counts(), { adminCalls: 0, storageCalls: 0 }, 'privileged dependency count')
})

Deno.test('authorized issue constructs privileged dependencies after the check', async () => {
  const state = baseDeps()
  const response = await handleContentAssets(
    request({
      action: 'issue',
      workspaceId: 'workspace-1',
      filename: 'asset.png',
      mime: 'image/png',
      sizeBytes: 12,
    }),
    state.deps,
  )

  assertEquals(response.status, 200, 'success status')
  assertEquals(state.counts(), { adminCalls: 1, storageCalls: 1 }, 'privileged dependency count')
})
