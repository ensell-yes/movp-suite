import { describe, expect, it } from 'vitest'
import type { CollectionDef, MovpSchema } from '../src/index.ts'
import { metadataProjection, schemaFingerprint } from '../src/index.ts'

function makeSchema(): MovpSchema {
  const collections: CollectionDef[] = [
    {
      name: 'beta', label: 'Beta', labelPlural: 'Betas', workspaceScoped: true, layer: 'project',
      fields: {
        zeta: { type: 'text', label: 'Zeta', searchable: true },
        alpha: { type: 'number', label: 'Alpha', reporting: { role: 'measure' } },
      },
    },
    {
      name: 'alpha', label: 'Alpha', labelPlural: 'Alphas', workspaceScoped: false, layer: 'platform',
      internal: true,
      fields: { ref: { type: 'relation', label: 'Ref', target: 'beta', cardinality: 'many-to-one' } },
    },
  ]
  return {
    collections,
    events: [],
    platformCollections: collections.filter((c) => c.layer === 'platform'),
    projectCollections: collections.filter((c) => c.layer === 'project'),
    platformEvents: [],
    projectEvents: [],
  }
}

describe('metadataProjection', () => {
  it('projects exactly the DB-compared columns, deterministically ordered', () => {
    const p = metadataProjection(makeSchema())
    expect(p.collections.map((c) => c.name)).toEqual(['alpha', 'beta'])
    expect(p.collections[1]).toEqual({
      name: 'beta', label: 'Beta', label_plural: 'Betas', workspace_scoped: true, layer: 'project',
    })
    expect(p.fields.map((f) => `${f.collection_name}.${f.name}`)).toEqual([
      'alpha.ref', 'beta.alpha', 'beta.zeta',
    ])
    expect(p.fields[1]).toEqual({
      collection_name: 'beta', name: 'alpha', type: 'number', label: 'Alpha',
      cardinality: null, reporting_role: 'measure', searchable: false, embeddable: false, layer: 'project',
    })
    expect(p.fields[0].layer).toBe('platform')
    expect(p.fields[0].cardinality).toBe('many-to-one')
    expect(Object.keys(p.collections[0])).not.toContain('internal')
  })
})

describe('schemaFingerprint', () => {
  it('is a stable sha256 hex string, order-independent over input collection order', () => {
    const fp = schemaFingerprint(makeSchema())
    expect(fp).toMatch(/^[0-9a-f]{64}$/)
    const original = makeSchema()
    const collections = [...original.collections].reverse()
    const reordered: MovpSchema = {
      ...original,
      collections,
      platformCollections: collections.filter((c) => c.layer === 'platform'),
      projectCollections: collections.filter((c) => c.layer === 'project'),
    }
    expect(schemaFingerprint(reordered)).toBe(fp)
  })

  it('changes when a projected column changes', () => {
    const base = schemaFingerprint(makeSchema())
    const mutated = makeSchema()
    mutated.collections[0].fields.zeta.label = 'Zeta 2'
    expect(schemaFingerprint(mutated)).not.toBe(base)
  })
})
