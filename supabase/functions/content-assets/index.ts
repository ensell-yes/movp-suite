import { createClient } from 'npm:@supabase/supabase-js@2'
import { AwsClient } from 'npm:aws4fetch'

const ASSET_MAX_BYTES = 25 * 1024 * 1024
const ASSET_ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'])

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

Deno.serve(async (req: Request): Promise<Response> => {
  const authHeader = req.headers.get('Authorization') ?? ''
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  })
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return json(401, { error: 'unauthorized' })

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  })
  const r2 = new AwsClient({
    accessKeyId: Deno.env.get('R2_ACCESS_KEY_ID')!,
    secretAccessKey: Deno.env.get('R2_SECRET_ACCESS_KEY')!,
    service: 's3',
    region: 'auto',
  })
  const account = Deno.env.get('R2_ACCOUNT_ID')!
  const bucket = Deno.env.get('R2_BUCKET')!
  const body = await req.json()

  if (body.action === 'issue') {
    const { workspaceId, filename, mime, sizeBytes } = body
    const { data: member } = await supabase.rpc('is_workspace_member', { ws: workspaceId })
    if (!member) return json(403, { error: 'not_a_member' })
    if (!ASSET_ALLOWED_MIME.has(mime)) return json(400, { error: 'disallowed_mime' })
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > ASSET_MAX_BYTES) {
      return json(400, { error: 'size_out_of_bounds' })
    }

    const assetId = crypto.randomUUID()
    const r2Key = `${workspaceId}/${assetId}`
    const { error: insertError } = await admin.from('asset').insert({
      id: assetId,
      workspace_id: workspaceId,
      filename,
      mime,
      r2_key: r2Key,
      size_bytes: sizeBytes,
      uploaded_by: user.id,
    })
    if (insertError) return json(500, { error: 'asset_persist_failed' })

    const url = new URL(`https://${account}.r2.cloudflarestorage.com/${bucket}/${r2Key}`)
    url.searchParams.set('X-Amz-Expires', '600')
    const signed = await r2.sign(url.toString(), {
      method: 'PUT',
      headers: { 'content-type': mime },
      aws: { signQuery: true },
    })
    return json(200, { uploadUrl: signed.url, r2Key, assetId })
  }

  if (body.action === 'finalize') {
    const { assetId, width, height } = body
    const { data: asset, error: readError } = await supabase
      .from('asset')
      .select('workspace_id, r2_key')
      .eq('id', assetId)
      .maybeSingle()
    if (readError) return json(500, { error: 'asset_read_failed' })
    if (!asset) return json(404, { error: 'asset_not_found' })

    const head = await r2.fetch(`https://${account}.r2.cloudflarestorage.com/${bucket}/${asset.r2_key}`, {
      method: 'HEAD',
    })
    if (!head.ok) return json(409, { error: 'object_not_uploaded' })

    const sizeBytes = Number(head.headers.get('content-length') ?? '0')
    const checksum = (head.headers.get('etag') ?? '').replace(/"/g, '')
    const { data: row, error: updateError } = await supabase
      .from('asset')
      .update({ size_bytes: sizeBytes, checksum, width: width ?? null, height: height ?? null })
      .eq('id', assetId)
      .select()
      .single()
    if (updateError || !row) return json(500, { error: 'asset_finalize_failed' })
    return json(200, row)
  }

  return json(400, { error: 'unknown_action' })
})
