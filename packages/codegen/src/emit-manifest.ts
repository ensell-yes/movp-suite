import { schemaFingerprint, type CollectionDef, type MovpSchema } from '@movp/core-schema'

export interface ManifestField {
  name: string
  type: string
  label: string
  cardinality: string | null
  reporting_role: string | null
  searchable: boolean
  embeddable: boolean
}

export interface ManifestCollection {
  name: string
  internal: boolean
  label: string
  workspaceScoped: boolean
  layer: 'platform' | 'project'
  fields: ManifestField[]
}

export interface SchemaManifest {
  manifestVersion: 1
  generatorVersion: string
  schemaFingerprint: string
  collections: ManifestCollection[]
}

function manifestCollection(collection: CollectionDef): ManifestCollection {
  return {
    name: collection.name,
    internal: collection.internal === true,
    label: collection.label,
    workspaceScoped: collection.workspaceScoped,
    layer: collection.layer ?? 'platform',
    fields: Object.entries(collection.fields)
      .map(([name, field]) => ({
        name,
        type: field.type,
        label: field.label,
        cardinality: field.cardinality ?? null,
        reporting_role: field.reporting?.role ?? null,
        searchable: field.searchable === true,
        embeddable: field.embeddable === true,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  }
}

export function emitManifest(
  schema: MovpSchema,
  options: { generatorVersion: string },
): SchemaManifest {
  return {
    manifestVersion: 1,
    generatorVersion: options.generatorVersion,
    schemaFingerprint: schemaFingerprint(schema),
    collections: schema.collections
      .map(manifestCollection)
      .sort((left, right) => left.name.localeCompare(right.name)),
  }
}

export function serializeManifest(manifest: SchemaManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}
