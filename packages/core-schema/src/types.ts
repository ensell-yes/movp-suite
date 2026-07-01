export type Cardinality = 'one-to-one' | 'one-to-many' | 'many-to-many'
export type ReportingRole = 'dimension' | 'measure'
export type FieldType =
  | 'text'
  | 'richText'
  | 'enum'
  | 'number'
  | 'boolean'
  | 'datetime'
  | 'uuid'
  | 'relation'

export interface FieldDef {
  type: FieldType
  label: string
  description?: string
  required?: boolean
  default?: string | number | boolean
  searchable?: boolean
  embeddable?: boolean
  reporting?: { role: ReportingRole }
  values?: string[]
  target?: string
  cardinality?: Cardinality
  graph?: boolean
}

export interface CollectionDef {
  name: string
  label: string
  labelPlural: string
  workspaceScoped: boolean
  fields: Record<string, FieldDef>
}

export interface MovpSchema {
  collections: CollectionDef[]
}
