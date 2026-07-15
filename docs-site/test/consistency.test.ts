import { describe, expect, it } from 'vitest'
import type { CollectionDef, MovpSchema } from '@movp/core-schema'
import { emitManifest } from '@movp/codegen'
import { assertManifestMatchesSchema, DocsConsistencyError, type DocsConsistencyCode } from '../src/dsl-reference/consistency.ts'

const deal: CollectionDef = {
  name: 'deal',
  label: 'Deal',
  labelPlural: 'Deals',
  workspaceScoped: true,
  layer: 'project',
  internal: false,
  fields: { title: { type: 'text', label: 'Title', searchable: true } },
}

function schema(collections: CollectionDef[]): MovpSchema {
  return { collections, events: [], projectCollections: collections, platformCollections: [] } as unknown as MovpSchema
}

describe('assertManifestMatchesSchema', () => {
  it('passes for a manifest freshly emitted from the schema', () => {
    const s = schema([deal])
    expect(() => assertManifestMatchesSchema(s, emitManifest(s, { generatorVersion: '0.1.0' }))).not.toThrow()
  })

  it('fails with .code === manifest_fingerprint_mismatch (typed, no cast) when the fingerprint is stale', () => {
    const s = schema([deal])
    const manifest = { ...emitManifest(s, { generatorVersion: '0.1.0' }), schemaFingerprint: 'sha256-stale' }
    // `instanceof` narrows `error` to DocsConsistencyError, so `error.code` is read
    // through the declared DocsConsistencyCode type — no `as` cast, no `as never`.
    let code: DocsConsistencyCode | undefined
    try {
      assertManifestMatchesSchema(s, manifest)
    } catch (error) {
      if (error instanceof DocsConsistencyError) code = error.code
    }
    expect(code).toBe('manifest_fingerprint_mismatch')
  })

  it('fails with a C6c stable id when the manifest omits a collection', () => {
    const s = schema([deal])
    const manifest = { ...emitManifest(s, { generatorVersion: '0.1.0' }), collections: [] }
    expect(() => assertManifestMatchesSchema(s, manifest)).toThrow(/missing_metadata_row/)
  })

  it('fails altered_metadata_row when a manifest field column diverges', () => {
    const s = schema([deal])
    const manifest = emitManifest(s, { generatorVersion: '0.1.0' })
    manifest.collections[0].fields[0].type = 'number'
    expect(() => assertManifestMatchesSchema(s, manifest)).toThrow(/altered_metadata_row/)
  })
})
