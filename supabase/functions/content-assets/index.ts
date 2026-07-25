import { createClient } from 'npm:@supabase/supabase-js@2'
import { AwsClient } from 'npm:aws4fetch'
import {
  hashWorkspaceId,
  handleContentAssets,
  type ContentAssetsAdmin,
  type ContentAssetsCaller,
  type ContentAssetsDeps,
  type ContentAssetsStorage,
} from './handler.ts'

const createCaller = async (req: Request): Promise<ContentAssetsCaller | null> => {
  const authHeader = req.headers.get('Authorization') ?? ''
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  return {
    userId: user.id,
    resolveWorkspace: async (workspaceId) => {
      const { data, error } = await supabase
        .from('workspace')
        .select('id')
        .eq('id', workspaceId)
        .maybeSingle()
      return {
        data: data?.id ?? null,
        error: error ? { code: error.code } : null,
      }
    },
    resolveAsset: async (assetId) => {
      const { data, error } = await supabase
        .from('asset')
        .select('workspace_id, r2_key')
        .eq('id', assetId)
        .maybeSingle()
      return {
        data: data
          ? { workspaceId: data.workspace_id, r2Key: data.r2_key }
          : null,
        error: error ? { code: error.code } : null,
      }
    },
    checkEdit: async (workspaceId, signal) => {
      const { data, error } = await supabase
        .rpc('has_content_capability', { ws: workspaceId, cap: 'edit' })
        .abortSignal(signal)
      return {
        data: typeof data === 'boolean' ? data : null,
        error: error ? { code: error.code } : null,
      }
    },
  }
}

const createAdmin = (): ContentAssetsAdmin => {
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  })
  return {
    insertAsset: async (row) => {
      const { error } = await admin.from('asset').insert(row)
      return { error: error ? { code: error.code } : null }
    },
    finalizeAsset: async (assetId, patch) => {
      const { data, error } = await admin
        .from('asset')
        .update(patch)
        .eq('id', assetId)
        .select()
        .single()
      return {
        data,
        error: error ? { code: error.code } : null,
      }
    },
  }
}

const createStorage = (): ContentAssetsStorage => {
  const r2 = new AwsClient({
    accessKeyId: Deno.env.get('R2_ACCESS_KEY_ID')!,
    secretAccessKey: Deno.env.get('R2_SECRET_ACCESS_KEY')!,
    service: 's3',
    region: 'auto',
  })
  const account = Deno.env.get('R2_ACCOUNT_ID')!
  const bucket = Deno.env.get('R2_BUCKET')!
  return {
    signUpload: async ({ r2Key, mime }) => {
      const url = new URL(
        `https://${account}.r2.cloudflarestorage.com/${bucket}/${r2Key}`,
      )
      url.searchParams.set('X-Amz-Expires', '600')
      const signed = await r2.sign(url.toString(), {
        method: 'PUT',
        headers: { 'content-type': mime },
        aws: { signQuery: true },
      })
      return signed.url
    },
    head: async (r2Key) =>
      await r2.fetch(
        `https://${account}.r2.cloudflarestorage.com/${bucket}/${r2Key}`,
        { method: 'HEAD' },
      ),
  }
}

const requestDeps = (): ContentAssetsDeps => ({
  authenticate: createCaller,
  createAdmin,
  createStorage,
  emit: (event) => console.log(JSON.stringify(event)),
  hashWorkspaceId,
  randomUUID: () => crypto.randomUUID(),
  capabilityTimeoutMs: 1_500,
})

if (import.meta.main) {
  Deno.serve(async (req: Request): Promise<Response> =>
    await handleContentAssets(req, requestDeps())
  )
}
