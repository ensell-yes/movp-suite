import { defineCollection, f, type CollectionDef, type MovpSchema } from '@movp/core-schema'
import { describe, expect, it } from 'vitest'
import { emitCollectionSql, emitTypes } from '../src/index.ts'

const deliverable: CollectionDef = defineCollection({
  name: 'deliverable',
  label: 'Deliverable',
  labelPlural: 'Deliverables',
  workspaceScoped: true,
  fields: {
    campaign: f.relation('campaign', { label: 'Campaign', required: true, cardinality: 'many-to-one' }),
    reviewer: f.relation('reviewer', { label: 'Reviewer', cardinality: 'one-to-one' }),
    tags: f.relation('tag', { label: 'Tags', cardinality: 'many-to-many', graph: true }),
    due_on: f.date({ label: 'Due' }),
    meta: f.json({ label: 'Meta' }),
  },
})

describe('DSL/codegen contract extensions', () => {
  const sql = emitCollectionSql(deliverable)
  const isolatedSchema: MovpSchema = {
    collections: [deliverable],
    events: [],
    platformCollections: [deliverable],
    projectCollections: [],
    platformEvents: [],
    projectEvents: [],
  }
  const ts = emitTypes(isolatedSchema)

  it('many-to-one and one-to-one relations emit FK columns', () => {
    expect(sql).toContain('campaign_id uuid not null references public.campaign(id) on delete cascade')
    expect(sql).toContain('reviewer_id uuid references public.reviewer(id) on delete set null')
  })

  it('many-to-many relations do not emit a column', () => {
    expect(sql).not.toContain('tags_id')
  })

  it('maps json to jsonb and date to date', () => {
    expect(sql).toContain('meta jsonb')
    expect(sql).toContain('due_on date')
  })

  it('generated types carry FK ids and json/date mappings', () => {
    expect(ts).toContain('campaign_id: string')
    expect(ts).toContain('reviewer_id: string | null')
    expect(ts).toContain('meta: Record<string, unknown> | null')
    expect(ts).toContain('due_on: string | null')
    expect(ts).not.toContain('tags')
  })
})
