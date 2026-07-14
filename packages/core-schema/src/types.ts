// 'many-to-one' / 'one-to-one' means this row holds a `<field>_id` FK column.
// 'one-to-many' is the inverse side. 'many-to-many' uses the typed edges graph.
export type Cardinality = 'one-to-one' | 'one-to-many' | 'many-to-one' | 'many-to-many'
export type ReportingRole = 'dimension' | 'measure'
export type FieldType =
  | 'text'
  | 'richText'
  | 'enum'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'json'
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
  /**
   * Internal collections still generate tables/types, but are intentionally
   * skipped by generic public surfaces when writes need bespoke atomic logic.
  */
  internal?: boolean
  /**
   * Tier marker distinguishing platform-owned collections from project extensions. Stamped by
   * defineSchema: 'platform' for a non-extends (monorepo) schema and for inherited collections;
   * 'project' for collections declared locally in an `extends` schema. Optional on hand-authored
   * defs (absent === 'platform').
   */
  layer?: 'platform' | 'project'
  fields: Record<string, FieldDef>
}

export interface EventDef {
  key: string
  domain: 'collaboration' | 'task' | 'cms' | 'campaign' | 'segmentation' | 'lifecycle' | 'workflow'
  payloadSchema: Record<string, unknown>
  version: number
  label?: string
  description?: string
}

export interface MovpSchema {
  collections: CollectionDef[]
  events: EventDef[]
  /** Derived: collections with layer === 'platform'. */
  platformCollections: CollectionDef[]
  /** Derived: collections with layer === 'project' (empty for a non-extends schema). */
  projectCollections: CollectionDef[]
}
