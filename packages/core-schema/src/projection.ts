import { createHash } from 'node:crypto'
import type { CollectionDef, EventDef, FieldDef, MovpSchema } from './types.ts'

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

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson }

function canonicalJson(value: unknown): CanonicalJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (typeof value === 'object') {
    const result: { [key: string]: CanonicalJson } = {}
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key]
      if (child !== undefined) result[key] = canonicalJson(child)
    }
    return result
  }
  throw new Error(`runtime_projection_invalid_value: unsupported ${typeof value}`)
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

function runtimeCollection(collection: CollectionDef) {
  return {
    name: collection.name,
    label: collection.label,
    labelPlural: collection.labelPlural,
    workspaceScoped: collection.workspaceScoped,
    internal: collection.internal === true,
    layer: collection.layer ?? 'platform',
    fields: Object.entries(collection.fields)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, field]) => ({
        name,
        type: field.type,
        label: field.label,
        description: field.description ?? null,
        required: field.required === true,
        default: field.default ?? null,
        searchable: field.searchable === true,
        embeddable: field.embeddable === true,
        reportingRole: field.reporting?.role ?? null,
        values: field.values ?? null,
        target: field.target ?? null,
        cardinality: field.cardinality ?? null,
        graph: field.graph === true,
      })),
  }
}

function runtimeEvent(event: EventDef) {
  return {
    key: event.key,
    domain: event.domain,
    payloadSchema: canonicalJson(event.payloadSchema),
    version: event.version,
    label: event.label ?? null,
    description: event.description ?? null,
    layer: event.layer ?? 'platform',
  }
}

export function runtimeProjection(schema: Pick<MovpSchema, 'collections' | 'events'>) {
  return {
    collections: schema.collections.map(runtimeCollection).sort((a, b) => a.name.localeCompare(b.name)),
    events: schema.events.map(runtimeEvent).sort((a, b) => a.key.localeCompare(b.key)),
  }
}

export function runtimeFingerprint(schema: Pick<MovpSchema, 'collections' | 'events'>): string {
  return createHash('sha256').update(JSON.stringify(runtimeProjection(schema))).digest('hex')
}
