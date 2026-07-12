import { emitDeltaSql } from '@movp/codegen'
import { describe, expect, it } from 'vitest'
import { schema } from '../src/schema.ts'

describe('external_record collection (C5a.2)', () => {
  it('is registered in the schema exactly once, workspace-scoped', () => {
    const found = schema.collections.filter((collection) => collection.name === 'external_record')
    expect(found).toHaveLength(1)
    expect(found[0].workspaceScoped).toBe(true)
    expect(Object.keys(found[0].fields).sort()).toEqual(['external_id', 'payload', 'source'])
  })

  it('emits a create table with source/external_id/payload as a delta collection', () => {
    const sql = emitDeltaSql(schema, { collections: ['external_record'] })
    expect(sql).toContain('create table if not exists public.external_record (')
    expect(sql).toContain('  source text not null')
    expect(sql).toContain('  external_id text not null')
    expect(sql).toContain('  payload jsonb')
    expect(sql).toContain('create policy external_record_rw on public.external_record')
  })
})
