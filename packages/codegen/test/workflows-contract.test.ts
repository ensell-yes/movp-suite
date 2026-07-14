import { defineCollection, defineEvent, defineSchema, f } from '@movp/core-schema'
import { describe, expect, it } from 'vitest'
import { checkEventCatalog } from '../src/event-catalog.ts'
import { emitSqlMigration } from '../src/emit-sql.ts'

describe('workflow catalog codegen contract', () => {
  it('emits global collection SQL without workspace-member RLS', () => {
    const eventType = defineCollection({
      name: 'event_type',
      label: 'Event type',
      labelPlural: 'Event types',
      workspaceScoped: false,
      fields: {
        key: f.text({ label: 'Key', required: true }),
        domain: f.enum(['task'], { label: 'Domain', required: true }),
        payload_schema: f.json({ label: 'Payload schema', required: true }),
      },
    })
    const sql = emitSqlMigration(
      defineSchema({
        collections: [eventType],
        events: [
          defineEvent({ key: 'task.completed', domain: 'task', payloadSchema: { type: 'object' }, version: 1 }),
        ],
      }),
    )

    const eventTypeSql = sql.slice(
      sql.indexOf('create table if not exists public.event_type'),
      sql.indexOf('insert into public.movp_collections'),
    )
    expect(sql).toContain('create table if not exists public.event_type')
    expect(eventTypeSql).not.toContain('event_type_rw')
    expect(eventTypeSql).not.toContain('public.is_workspace_member(workspace_id)')
    expect(eventTypeSql).toContain('create policy event_type_read on public.event_type for select to authenticated using (true)')
    expect(sql).toContain("('task.completed', 'task'")
  })

  it('reports emit callsites that are missing from the event catalog', () => {
    const result = checkEventCatalog(
      [defineEvent({ key: 'task.completed', domain: 'task', payloadSchema: { type: 'object' }, version: 1 })],
      ['task.completed', 'missing.event'],
    )

    expect(result.missingFromCatalog).toEqual(['missing.event'])
    expect(result.unusedCatalogKeys).toEqual([])
  })
})
