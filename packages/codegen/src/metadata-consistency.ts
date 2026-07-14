import { metadataProjection, type MovpSchema } from '@movp/core-schema'

type Projection = ReturnType<typeof metadataProjection>
type CollectionMeta = Projection['collections'][number]
type FieldMeta = Projection['fields'][number]

export interface MetadataDbState {
  collections: CollectionMeta[]
  fields: FieldMeta[]
}

export type MetadataConsistencyCode =
  | 'missing_metadata_row'
  | 'altered_metadata_row'
  | 'stale_metadata_row'

export class MetadataConsistencyError extends Error {
  constructor(
    readonly code: MetadataConsistencyCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`)
    this.name = 'MetadataConsistencyError'
  }
}

function index<T>(rows: readonly T[], key: (row: T) => string): Map<string, T> {
  return new Map(rows.map((row) => [key(row), row]))
}

function diffColumns<T extends object>(
  expected: T,
  actual: T,
  columns: readonly (keyof T)[],
): string | null {
  for (const column of columns) {
    if (expected[column] !== actual[column]) return String(column)
  }
  return null
}

const COLLECTION_COLUMNS = ['name', 'label', 'label_plural', 'workspace_scoped', 'layer'] as const
const FIELD_COLUMNS = [
  'collection_name', 'name', 'type', 'label', 'cardinality', 'reporting_role',
  'searchable', 'embeddable', 'layer',
] as const

export function checkMetadataConsistency(schema: MovpSchema, db: MetadataDbState): void {
  const projection = metadataProjection(schema)
  const expectedCollections = index(projection.collections, (collection) => collection.name)
  const actualCollections = index(db.collections, (collection) => collection.name)

  for (const [name, expected] of expectedCollections) {
    const actual = actualCollections.get(name)
    if (!actual) throw new MetadataConsistencyError('missing_metadata_row', `collection "${name}"`)
    const column = diffColumns(expected, actual, COLLECTION_COLUMNS)
    if (column) {
      throw new MetadataConsistencyError('altered_metadata_row', `collection "${name}" column "${column}"`)
    }
  }
  for (const name of actualCollections.keys()) {
    if (!expectedCollections.has(name)) {
      throw new MetadataConsistencyError('stale_metadata_row', `collection "${name}"`)
    }
  }

  const fieldKey = (field: FieldMeta): string => `${field.collection_name}.${field.name}`
  const expectedFields = index(projection.fields, fieldKey)
  const actualFields = index(db.fields, fieldKey)
  for (const [key, expected] of expectedFields) {
    const actual = actualFields.get(key)
    if (!actual) throw new MetadataConsistencyError('missing_metadata_row', `field "${key}"`)
    const column = diffColumns(expected, actual, FIELD_COLUMNS)
    if (column) {
      throw new MetadataConsistencyError('altered_metadata_row', `field "${key}" column "${column}"`)
    }
  }
  for (const key of actualFields.keys()) {
    if (!expectedFields.has(key)) throw new MetadataConsistencyError('stale_metadata_row', `field "${key}"`)
  }
}
