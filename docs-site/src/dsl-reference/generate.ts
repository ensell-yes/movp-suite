import type { ManifestCollection, ManifestField, SchemaManifest } from '@movp/codegen'

export interface GeneratedPage {
  /** Path relative to the Starlight docs content root, e.g. "reference/deal.md". */
  path: string
  content: string
}

const yesNo = (value: boolean): string => (value ? 'yes' : 'no')
const orDash = (value: string | null): string => (value === null || value === '' ? '—' : value)
const GENERATED_BANNER = '<!-- Generated from movp.schema.json by `pnpm docs:reference`. Do not edit by hand. -->'

function fieldRow(field: ManifestField): string {
  return `| \`${field.name}\` | \`${field.type}\` | ${field.label} | ${orDash(field.cardinality)} | ${orDash(
    field.reporting_role,
  )} | ${yesNo(field.searchable)} | ${yesNo(field.embeddable)} |`
}

function collectionPage(collection: ManifestCollection): GeneratedPage {
  const fields = [...collection.fields].sort((a, b) => a.name.localeCompare(b.name))
  const content = [
    '---',
    `title: ${collection.label}`,
    `description: DSL reference for the ${collection.name} collection (generated — do not edit).`,
    '---',
    '',
    GENERATED_BANNER,
    '',
    `**Collection name:** \`${collection.name}\``,
    `**Layer:** ${collection.layer}`,
    `**Workspace-scoped:** ${yesNo(collection.workspaceScoped)}`,
    `**Internal:** ${yesNo(collection.internal)}`,
    '',
    '## Fields',
    '',
    '| Field | Type | Label | Cardinality | Reporting role | Searchable | Embeddable |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...fields.map(fieldRow),
    '',
  ].join('\n')
  return { path: `reference/${collection.name}.md`, content }
}

function indexPage(manifest: SchemaManifest, collections: readonly ManifestCollection[]): GeneratedPage {
  const rows = collections.map(
    (c) => `| [${c.label}](/reference/${c.name}/) | \`${c.name}\` | ${c.layer} | ${c.fields.length} |`,
  )
  const content = [
    '---',
    'title: Schema reference',
    'description: Generated DSL reference for every MOVP collection.',
    '---',
    '',
    GENERATED_BANNER,
    '',
    `Generated from manifest version ${manifest.manifestVersion} (generator ${manifest.generatorVersion}).`,
    '',
    '| Collection | Name | Layer | Fields |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n')
  return { path: 'reference/index.md', content }
}

export function generateDslReference(manifest: SchemaManifest): GeneratedPage[] {
  const collections = [...manifest.collections].sort((a, b) => a.name.localeCompare(b.name))
  const pages = [indexPage(manifest, collections), ...collections.map(collectionPage)]
  return pages.sort((a, b) => a.path.localeCompare(b.path))
}
