import { metadataProjection, type CollectionDef, type MovpSchema } from '@movp/core-schema'
import { describe, expect, it } from 'vitest'
import { checkMetadataConsistency, type MetadataDbState } from '../src/metadata-consistency.ts'

const deal: CollectionDef = {
  name: 'deal', label: 'Deal', labelPlural: 'Deals', workspaceScoped: true, layer: 'project',
  fields: { title: { type: 'text', label: 'Title', searchable: true } },
}
const schema = (collections: CollectionDef[]): MovpSchema => ({
  collections, events: [], projectCollections: collections, platformCollections: [],
})
function dbFrom(input: MovpSchema): MetadataDbState {
  const projection = metadataProjection(input)
  return {
    collections: projection.collections.map((collection) => ({ ...collection })),
    fields: projection.fields.map((field) => ({ ...field })),
  }
}

describe('checkMetadataConsistency', () => {
  it('passes an exact projection', () => {
    const input = schema([deal])
    expect(() => checkMetadataConsistency(input, dbFrom(input))).not.toThrow()
  })

  it('reports a missing row', () => {
    const input = schema([deal])
    const db = dbFrom(input)
    db.fields = []
    expect(() => checkMetadataConsistency(input, db)).toThrow(/missing_metadata_row/)
  })

  it('reports an altered column without its value', () => {
    const input = schema([deal])
    const db = dbFrom(input)
    const first = db.collections[0]
    if (!first) throw new Error('fixture missing collection')
    first.label = 'SECRET VALUE'
    let message = ''
    try { checkMetadataConsistency(input, db) } catch (error: unknown) { message = String(error) }
    expect(message).toMatch(/altered_metadata_row.*column "label"/)
    expect(message).not.toContain('SECRET VALUE')
  })

  it('reports a stale row', () => {
    const input = schema([deal])
    const db = dbFrom(input)
    db.fields.push({
      collection_name: 'deal', name: 'ghost', type: 'text', label: 'Ghost', cardinality: null,
      reporting_role: null, searchable: false, embeddable: false, layer: 'project',
    })
    expect(() => checkMetadataConsistency(input, db)).toThrow(/stale_metadata_row/)
  })
})
