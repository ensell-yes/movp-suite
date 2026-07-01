import type { FieldDef } from './types.ts'

export type FieldOptions = Omit<FieldDef, 'type' | 'values' | 'target'>

export const f = {
  text: (o: FieldOptions): FieldDef => ({ type: 'text', ...o }),
  richText: (o: FieldOptions): FieldDef => ({ type: 'richText', ...o }),
  enum: (values: string[], o: FieldOptions): FieldDef => ({ type: 'enum', values, ...o }),
  number: (o: FieldOptions): FieldDef => ({ type: 'number', ...o }),
  boolean: (o: FieldOptions): FieldDef => ({ type: 'boolean', ...o }),
  date: (o: FieldOptions): FieldDef => ({ type: 'date', ...o }),
  datetime: (o: FieldOptions): FieldDef => ({ type: 'datetime', ...o }),
  json: (o: FieldOptions): FieldDef => ({ type: 'json', ...o }),
  uuid: (o: FieldOptions): FieldDef => ({ type: 'uuid', ...o }),
  // User references are plain f.uuid fields, not relation('user'); there is no
  // generated cross-schema FK to auth.users.
  relation: (target: string, o: FieldOptions): FieldDef => ({ type: 'relation', target, ...o }),
}
