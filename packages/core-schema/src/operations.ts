import type { CollectionDef, FieldDef, GenericWriteMode } from './types.ts'

export function genericWriteMode(collection: CollectionDef): GenericWriteMode {
  return collection.genericWrite ?? (collection.internal ? 'none' : 'crud')
}

export function isStoredRelation(field: FieldDef): boolean {
  return field.type === 'relation'
    && (field.cardinality === 'many-to-one' || field.cardinality === 'one-to-one')
}

export function isGenericInputField(field: FieldDef): boolean {
  return field.type !== 'relation' || isStoredRelation(field)
}
