import type { FieldDef } from './types.ts'

export type FieldOptions = Omit<FieldDef, 'type' | 'values' | 'target'>

export const f = {
  text: (o: FieldOptions): FieldDef => ({ type: 'text', ...o }),
  richText: (o: FieldOptions): FieldDef => ({ type: 'richText', ...o }),
  enum: (values: string[], o: FieldOptions): FieldDef => ({ type: 'enum', values, ...o }),
  number: (o: FieldOptions): FieldDef => ({ type: 'number', ...o }),
  boolean: (o: FieldOptions): FieldDef => ({ type: 'boolean', ...o }),
  datetime: (o: FieldOptions): FieldDef => ({ type: 'datetime', ...o }),
  uuid: (o: FieldOptions): FieldDef => ({ type: 'uuid', ...o }),
  relation: (target: string, o: FieldOptions): FieldDef => ({ type: 'relation', target, ...o }),
}
