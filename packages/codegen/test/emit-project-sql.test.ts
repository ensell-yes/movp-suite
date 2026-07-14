import type { CollectionDef, MovpSchema } from '@movp/core-schema'
import { describe, expect, it } from 'vitest'
import { emitProjectMetadataPrune, emitProjectMigration } from '../src/emit-sql.ts'

const deal: CollectionDef = {
  name: 'deal',
  label: 'Deal',
  labelPlural: 'Deals',
  workspaceScoped: true,
  layer: 'project',
  fields: { title: { type: 'text', label: 'Title', searchable: true } },
}
const platformNote: CollectionDef = {
  name: 'note',
  label: 'Note',
  labelPlural: 'Notes',
  workspaceScoped: true,
  layer: 'platform',
  fields: { body: { type: 'text', label: 'Body' } },
}

function projectSchema(collections: CollectionDef[]): MovpSchema {
  return { collections, events: [], projectCollections: collections, platformCollections: [] }
}

describe('project SQL emitters', () => {
  it('emits project metadata without shared platform infrastructure', () => {
    const sql = emitProjectMigration(projectSchema([deal]))
    expect(sql).not.toContain('create table if not exists public.movp_collections')
    expect(sql).toContain('create table if not exists public.deal (')
    expect(sql).toContain('workspace_scoped, layer)')
    expect(sql).toContain("'deal', 'Deal', 'Deals', true, 'project'")
    expect(sql).toContain('embeddable, layer)')
  })

  it('rejects a platform collection on the project path', () => {
    expect(() => emitProjectMigration(projectSchema([platformNote]))).toThrow(/platform_row_delete_forbidden/)
  })

  it('prunes only project-layer metadata rows', () => {
    const sql = emitProjectMetadataPrune(projectSchema([deal]))
    expect(sql).toContain("delete from public.movp_fields where layer = 'project'")
    expect(sql).toContain("delete from public.movp_collections where layer = 'project'")
    expect(sql).toContain("name not in ('deal')")
    expect(sql).not.toContain("layer = 'platform'")
  })
})
