import { describe, expect, it } from 'vitest'
import { comment } from '../src/collections/comment.ts'
import { note } from '../src/collections/note.ts'
import { tag } from '../src/collections/tag.ts'
import { defineSchema } from '../src/define.ts'
import { schema } from '../src/schema.ts'

describe('example collections', () => {
  it('note has the expected workspace-scoped fields', () => {
    expect(note.name).toBe('note')
    expect(note.label).toBe('Note')
    expect(note.labelPlural).toBe('Notes')
    expect(note.workspaceScoped).toBe(true)
    expect(note.fields.title).toEqual({ type: 'text', label: 'Title', required: true, searchable: true })
    expect(note.fields.body).toEqual({ type: 'richText', label: 'Body', searchable: true, embeddable: true })
    expect(note.fields.status.values).toEqual(['draft', 'published', 'archived'])
    expect(note.fields.status.default).toBe('draft')
    expect(note.fields.status.reporting).toEqual({ role: 'dimension' })
    expect(note.fields.tags).toEqual({
      type: 'relation',
      target: 'tag',
      label: 'Tags',
      cardinality: 'many-to-many',
      graph: true,
    })
  })

  it('tag has a required searchable name', () => {
    expect(tag.name).toBe('tag')
    expect(tag.workspaceScoped).toBe(true)
    expect(tag.fields.name).toEqual({ type: 'text', label: 'Name', required: true, searchable: true })
  })
})

describe('defineSchema aggregate', () => {
  it('aggregates the collections in order', () => {
    expect(schema.collections.map((c) => c.name)).toEqual([
      'note',
      'tag',
      'comment',
      'reaction',
      'saved_item',
      'mention',
      'share_link',
    ])
    expect(comment.internal).toBe(true)
  })

  it('rejects duplicate collection names', () => {
    expect(() => defineSchema([tag, tag])).toThrow(/duplicate/)
  })

  it('rejects a relation to a collection not in the set', () => {
    expect(() => defineSchema([note])).toThrow(/unknown collection "tag"/)
  })
})
