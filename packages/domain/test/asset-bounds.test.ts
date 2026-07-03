import { describe, expect, it } from 'vitest'
import { ASSET_MAX_BYTES, validateAssetRequest, verifyFinalizePayload } from '../src/asset-bounds'

describe('validateAssetRequest', () => {
  it('accepts an allowed mime within the size bound', () => {
    expect(validateAssetRequest({ mime: 'image/png', sizeBytes: 1024 })).toEqual({ ok: true })
  })

  it('rejects a disallowed mime', () => {
    expect(validateAssetRequest({ mime: 'application/x-msdownload', sizeBytes: 1024 })).toEqual({
      ok: false,
      error: 'disallowed_mime',
    })
  })

  it('rejects an oversized upload', () => {
    expect(validateAssetRequest({ mime: 'image/png', sizeBytes: ASSET_MAX_BYTES + 1 })).toEqual({
      ok: false,
      error: 'size_out_of_bounds',
    })
  })

  it('rejects non-positive and non-integer sizes', () => {
    expect(validateAssetRequest({ mime: 'image/png', sizeBytes: 0 }).ok).toBe(false)
    expect(validateAssetRequest({ mime: 'image/png', sizeBytes: 1.5 }).ok).toBe(false)
  })
})

describe('verifyFinalizePayload', () => {
  it('returns the R2 HEAD size and checksum, not the client-declared values', () => {
    const out = verifyFinalizePayload({
      headContentLength: 2048,
      headEtag: '"abc123"',
      declaredSizeBytes: 999999,
      declaredChecksum: 'client-lie',
    })

    expect(out).toEqual({ sizeBytes: 2048, checksum: 'abc123' })
  })
})
