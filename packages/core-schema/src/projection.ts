import { createHash } from 'node:crypto'
import type { CollectionDef, FieldDef, MovpSchema } from './types.ts'

export interface CollectionMeta {
  name: string
  label: string
  label_plural: string
  workspace_scoped: boolean
  layer: string
}

export interface FieldMeta {
  collection_name: string
  name: string
  type: string
  label: string
  cardinality: string | null
  reporting_role: string | null
  searchable: boolean
  embeddable: boolean
  layer: string
}

function collectionMeta(c: CollectionDef): CollectionMeta {
  return {
    name: c.name,
    label: c.label,
    label_plural: c.labelPlural,
    workspace_scoped: c.workspaceScoped,
    layer: c.layer ?? 'platform',
  }
}

function fieldMeta(collection: CollectionDef, name: string, field: FieldDef): FieldMeta {
  return {
    collection_name: collection.name,
    name,
    type: field.type,
    label: field.label,
    cardinality: field.cardinality ?? null,
    reporting_role: field.reporting?.role ?? null,
    searchable: !!field.searchable,
    embeddable: !!field.embeddable,
    layer: collection.layer ?? 'platform',
  }
}

export function metadataProjection(schema: MovpSchema): { collections: CollectionMeta[]; fields: FieldMeta[] } {
  const collections = schema.collections
    .map(collectionMeta)
    .sort((a, b) => a.name.localeCompare(b.name))

  const fields: FieldMeta[] = []
  for (const c of schema.collections) {
    for (const [name, field] of Object.entries(c.fields)) fields.push(fieldMeta(c, name, field))
  }
  fields.sort((a, b) =>
    a.collection_name === b.collection_name
      ? a.name.localeCompare(b.name)
      : a.collection_name.localeCompare(b.collection_name),
  )

  return { collections, fields }
}

export function schemaFingerprint(schema: MovpSchema): string {
  return createHash('sha256').update(JSON.stringify(metadataProjection(schema))).digest('hex')
}
