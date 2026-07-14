import type { MovpSchema } from '@movp/core-schema'
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it } from 'vitest'
import { createDomain } from '../src/domain.ts'
import type { DomainCtx } from '../src/types.ts'

const ctx: DomainCtx = { db: {} as SupabaseClient, userId: 'u' }

function schemaWith(...collections: MovpSchema['collections']): MovpSchema {
  return {
    collections,
    events: [],
    platformCollections: collections.filter((collection) => collection.layer !== 'project'),
    projectCollections: collections.filter((collection) => collection.layer === 'project'),
  }
}

const col = (
  name: string,
  extra: Partial<MovpSchema['collections'][number]> = {},
): MovpSchema['collections'][number] => ({
  name,
  label: name,
  labelPlural: `${name}s`,
  workspaceScoped: true,
  layer: 'project',
  fields: {},
  ...extra,
})

describe('createDomain generic two-tier registry (C6b.3)', () => {
  it('exposes a generic service for a novel non-internal collection', () => {
    const domain = createDomain(ctx, { schema: schemaWith(col('widget')) })
    expect(typeof domain.collection('widget').create).toBe('function')
    expect(typeof domain.collection('widget').list).toBe('function')
  })

  it('excludes internal collections from the generic tier', () => {
    const domain = createDomain(ctx, { schema: schemaWith(col('secret', { internal: true })) })
    expect(() => domain.collection('secret')).toThrow(/no domain service for collection: secret/)
  })

  it('lets the custom campaign service win on a name collision', () => {
    const domain = createDomain(ctx, { schema: schemaWith(col('campaign')) })
    expect(typeof domain.campaign.linkTask).toBe('function')
    expect(domain.collection('campaign')).toBe(domain.campaign)
  })
})
