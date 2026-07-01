import { describe, expect, it } from 'vitest'
import { f } from '../src/builders.ts'
import { defineCollection } from '../src/define.ts'

describe('f field builders', () => {
  it('text sets type and carries options', () => {
    expect(f.text({ label: 'Title', required: true, searchable: true })).toEqual({
      type: 'text',
      label: 'Title',
      required: true,
      searchable: true,
    })
  })

  it('enum injects values + type', () => {
    expect(f.enum(['a', 'b'], { label: 'S', default: 'a' })).toEqual({
      type: 'enum',
      values: ['a', 'b'],
      label: 'S',
      default: 'a',
    })
  })

  it('relation injects target + type', () => {
    expect(f.relation('tag', { label: 'Tags', cardinality: 'many-to-many', graph: true })).toEqual({
      type: 'relation',
      target: 'tag',
      label: 'Tags',
      cardinality: 'many-to-many',
      graph: true,
    })
  })

  it('the remaining builders set their type', () => {
    expect(f.richText({ label: 'B' }).type).toBe('richText')
    expect(f.number({ label: 'N' }).type).toBe('number')
    expect(f.boolean({ label: 'Bn' }).type).toBe('boolean')
    expect(f.datetime({ label: 'D' }).type).toBe('datetime')
    expect(f.uuid({ label: 'U' }).type).toBe('uuid')
  })
})

describe('defineCollection validation', () => {
  const base = { name: 'note', label: 'Note', labelPlural: 'Notes', workspaceScoped: true }

  it('accepts a valid collection and returns it unchanged', () => {
    const def = { ...base, fields: { title: f.text({ label: 'T' }) } }
    expect(defineCollection(def)).toBe(def)
  })

  it('rejects an invalid (non-snake_case) collection name', () => {
    expect(() => defineCollection({ ...base, name: 'Note', fields: {} })).toThrow(/collection name/)
  })

  it('rejects a field with no label', () => {
    expect(() => defineCollection({ ...base, fields: { title: { type: 'text', label: '' } } })).toThrow(
      /requires a label/,
    )
  })

  it('rejects an enum with empty values', () => {
    expect(() => defineCollection({ ...base, fields: { s: { type: 'enum', label: 'S', values: [] } } })).toThrow(
      /non-empty values/,
    )
  })

  it('rejects a relation with no target', () => {
    expect(() =>
      defineCollection({
        ...base,
        fields: { r: { type: 'relation', label: 'R', cardinality: 'one-to-many' } },
      }),
    ).toThrow(/requires a target/)
  })
})
