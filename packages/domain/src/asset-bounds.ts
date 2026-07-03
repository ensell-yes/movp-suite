export const ASSET_MAX_BYTES = 25 * 1024 * 1024
export const ASSET_ALLOWED_MIME: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
])

export type AssetBoundError = 'disallowed_mime' | 'size_out_of_bounds'

export function validateAssetRequest(input: {
  mime: string
  sizeBytes: number
}): { ok: true } | { ok: false; error: AssetBoundError } {
  if (!ASSET_ALLOWED_MIME.has(input.mime)) return { ok: false, error: 'disallowed_mime' }
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > ASSET_MAX_BYTES) {
    return { ok: false, error: 'size_out_of_bounds' }
  }
  return { ok: true }
}

export function verifyFinalizePayload(input: {
  headContentLength: number
  headEtag: string
  declaredSizeBytes: number
  declaredChecksum: string
}): { sizeBytes: number; checksum: string } {
  return { sizeBytes: input.headContentLength, checksum: input.headEtag.replace(/"/g, '') }
}
