import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { runtimeFingerprint, schemaFingerprint } from '@movp/core-schema'
import { emitProjectMigration } from '@movp/codegen'
import { schema } from '../../../templates/crm-lite/supabase/functions/_shared/schema.ts'
import { readFileGuarded } from '../src/copier.ts'

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

  it('emits referenced tables before relation-bearing tables', () => {
    const sql = emitProjectMigration(schema)
    const company = sql.indexOf('create table if not exists public.company')
    const contact = sql.indexOf('create table if not exists public.contact')
    const deal = sql.indexOf('create table if not exists public.deal')
    expect(company).toBeGreaterThanOrEqual(0)
    expect(contact).toBeGreaterThan(company)
    expect(deal).toBeGreaterThan(contact)
  })

  it('seeds relation columns using their generated foreign-key names', () => {
    const seedPath = fileURLToPath(new URL('../../../templates/crm-lite/supabase/seed.sql', import.meta.url))
    const seed = readFileGuarded(seedPath).toString('utf8')
    expect(seed).toContain('title, company_id)')
    expect(seed).toContain('stage, company_id, primary_contact_id)')
    expect(seed).not.toMatch(/title, company\)|stage, company, primary_contact\)/)
  })

  it('configures only shipped functions and keeps optional local sidecars disabled', () => {
    const configPath = fileURLToPath(new URL('../../../templates/crm-lite/supabase/config.toml', import.meta.url))
    const config = readFileGuarded(configPath).toString('utf8')
    const functions = [...config.matchAll(/^\[functions\.([^\]]+)\]$/gm)].map((match) => match[1])
    expect(functions).toEqual(['graphql', 'mcp'])
    expect(config).toMatch(/\[storage\.vector\]\nenabled = false/)
    expect(config).toMatch(/\[analytics\]\nenabled = false\nport = 64527/)
  })

  it('imports the composed schema in both edge entrypoints', () => {
    for (const functionName of ['graphql', 'mcp']) {
      const entryPath = fileURLToPath(
        new URL(`../../../templates/crm-lite/supabase/functions/${functionName}/index.ts`, import.meta.url),
      )
      const entry = readFileGuarded(entryPath).toString('utf8')
      expect(entry).toContain("import { schema } from '../_shared/schema.ts'")
      expect(entry).not.toContain('\\nimport { schema }')
    }
  })

  it('has a stable runtimeFingerprint — the one verify-schema-runtime compares (06b)', () => {
    // runtimeFingerprint, NOT schemaFingerprint: `movp verify-schema-runtime` compares THIS one across
    // Node and Deno. schemaFingerprint is DB-exact and blind to `internal` + `events`, so it would not
    // catch a runtime divergence; it is asserted here only as the DB-shape identity.
    expect(runtimeFingerprint(schema)).toMatch(/^[0-9a-f]{64}$/)
    expect(schemaFingerprint(schema)).toMatch(/^[0-9a-f]{64}$/)
  })
})
