import type { CollectionDef, MovpSchema } from '@movp/core-schema'
import { describe, expect, it } from 'vitest'
import { emitProjectMigration } from '../src/emit-sql.ts'
import { projectEvent, projectSchema } from './project-schema-fixture.ts'

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

describe('project SQL emitters', () => {
  it('emits project metadata without shared platform infrastructure', () => {
    const sql = emitProjectMigration(projectSchema([deal], [projectEvent('deal.created')]))
    expect(sql).not.toContain('create table if not exists public.movp_collections')
    expect(sql).toContain('create table if not exists public.deal (')
    expect(sql).toContain('workspace_scoped, layer)')
    expect(sql).toContain("'deal', 'Deal', 'Deals', true, 'project'")
    expect(sql).toContain('embeddable, layer)')
    expect(sql).toContain("'deal.created'")
    expect(sql).not.toContain("'note.created'")
  })

  it('rejects a platform collection on the project path', () => {
    const malformed = {
      collections: [platformNote],
      events: [],
      projectCollections: [platformNote],
      platformCollections: [],
      projectEvents: [],
      platformEvents: [],
    } as unknown as MovpSchema
    expect(() => emitProjectMigration(malformed)).toThrow(/platform_row_delete_forbidden/)
  })
})
