import { describe, expect, it } from 'vitest'
import type { SchemaManifest } from '@movp/codegen'
import { generateDslReference } from '../src/dsl-reference/generate.ts'

const manifest: SchemaManifest = {
  manifestVersion: 1,
  generatorVersion: '0.1.0',
  schemaFingerprint: 'sha256-fixture',
  collections: [
    {
      name: 'company',
      internal: false,
      label: 'Company',
      workspaceScoped: true,
      layer: 'project',
      fields: [{ name: 'name', type: 'text', label: 'Name', cardinality: null, reporting_role: null, searchable: true, embeddable: false }],
    },
    {
      name: 'deal',
      internal: false,
      label: 'Deal',
      workspaceScoped: true,
      layer: 'project',
      fields: [
        // Intentionally out of order to prove the generator sorts fields by name.
        { name: 'title', type: 'text', label: 'Title', cardinality: null, reporting_role: null, searchable: true, embeddable: false },
        { name: 'amount', type: 'number', label: 'Amount', cardinality: 'one', reporting_role: 'measure', searchable: false, embeddable: false },
      ],
    },
  ],
}

describe('generateDslReference', () => {
  it('emits an index plus one page per collection, sorted by path', () => {
    const pages = generateDslReference(manifest)
    expect(pages.map((p) => p.path)).toEqual([
      'reference/company.md',
      'reference/deal.md',
      'reference/index.md',
    ])
  })

  it('renders a collection page from the manifest (fields sorted, booleans as yes/no, null as em-dash)', () => {
    const deal = generateDslReference(manifest).find((p) => p.path === 'reference/deal.md')
    expect(deal?.content).toBe(
      [
        '---',
        'title: Deal',
        'description: DSL reference for the deal collection (generated — do not edit).',
        '---',
        '',
        '<!-- Generated from movp.schema.json by `pnpm docs:reference`. Do not edit by hand. -->',
        '',
        '**Collection name:** `deal`',
        '**Layer:** project',
        '**Workspace-scoped:** yes',
        '**Internal:** no',
        '',
        '## Fields',
        '',
        '| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        '| `amount` | `number` | Amount | one | measure | no | no |',
        '| `title` | `text` | Title | — | — | yes | no |',
        '',
      ].join('\n'),
    )
  })

  it('renders an index page linking every collection', () => {
    const index = generateDslReference(manifest).find((p) => p.path === 'reference/index.md')
    expect(index?.content).toBe(
      [
        '---',
        'title: Schema reference',
        'description: Generated DSL reference for every MOVP collection.',
        '---',
        '',
        '<!-- Generated from movp.schema.json by `pnpm docs:reference`. Do not edit by hand. -->',
        '',
        'Generated from manifest version 1 (generator 0.1.0).',
        '',
        '| Collection | Name | Layer | Fields |',
        '| --- | --- | --- | --- |',
        '| [Company](/reference/company/) | `company` | project | 1 |',
        '| [Deal](/reference/deal/) | `deal` | project | 2 |',
        '',
      ].join('\n'),
    )
  })

  it('is deterministic across runs', () => {
    expect(generateDslReference(manifest)).toEqual(generateDslReference(manifest))
  })
})
