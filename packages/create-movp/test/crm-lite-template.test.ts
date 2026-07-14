import { describe, expect, it } from 'vitest'
import { runtimeFingerprint, schemaFingerprint } from '@movp/core-schema'
import { schema } from '../../../templates/crm-lite/supabase/functions/_shared/schema.ts'

describe('CRM-lite template schema', () => {
  it('adds contact/company/deal as project extensions over the platform schema', () => {
    expect(schema.projectCollections.map((c) => c.name).sort()).toEqual(['company', 'contact', 'deal'])
    expect(schema.projectCollections.every((c) => c.layer === 'project')).toBe(true)
    expect(schema.platformCollections.length).toBeGreaterThan(0)
    expect(schema.platformCollections.every((c) => c.layer === 'platform')).toBe(true)
  })

  it('declares no project events (the template extends collections only)', () => {
    // `projectEvents`/`platformEvents` are derived, layer-scoped arrays on MovpSchema. Project codegen
    // emits projectEvents ONLY — a project baseline must never re-seed the platform event_type catalog.
    expect(schema.projectEvents).toEqual([])
    expect(schema.platformEvents.length).toBeGreaterThan(0)
  })

  it('has a stable runtimeFingerprint — the one verify-schema-runtime compares (06b)', () => {
    // runtimeFingerprint, NOT schemaFingerprint: `movp verify-schema-runtime` compares THIS one across
    // Node and Deno. schemaFingerprint is DB-exact and blind to `internal` + `events`, so it would not
    // catch a runtime divergence; it is asserted here only as the DB-shape identity.
    expect(runtimeFingerprint(schema)).toMatch(/^[0-9a-f]{64}$/)
    expect(schemaFingerprint(schema)).toMatch(/^[0-9a-f]{64}$/)
  })
})
