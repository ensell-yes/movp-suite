import { describe, expect, it } from 'vitest'
import { f } from '../src/builders.ts'
import { comment } from '../src/collections/comment.ts'
import { note } from '../src/collections/note.ts'
import { tag } from '../src/collections/tag.ts'
import { defineCollection, defineEvent, defineSchema } from '../src/define.ts'
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
      'event_type',
      'note',
      'tag',
      'comment',
      'reaction',
      'saved_item',
      'mention',
      'share_link',
      'task_status_option',
      'task_priority_option',
      'task',
      'task_revision',
      'task_assignment',
      'task_observer',
      'task_dependency',
      'task_status_history',
      'task_attachment',
      'content_type',
      'content_item',
      'content_revision',
      'content_approval',
      'content_approval_vote',
      'content_publish_event',
      'content_schedule',
      'asset',
      'content_collection',
      'content_collection_entry',
      'content_seo',
      'marketing_plan',
      'campaign',
      'campaign_channel',
      'campaign_deliverable',
      'campaign_calendar_event',
      'campaign_metric',
      'campaign_segment',
      'platform_event',
      'external_record',
      'segment',
      'segment_rule',
      'segment_membership',
      'segment_snapshot',
      'segment_snapshot_member',
      'segment_recompute_run',
      'automation_rule',
      'webhook_subscription',
      'workflow_run',
    ])
    expect(schema.events.map((event) => event.key)).toContain('task.completed')
    expect(comment.internal).toBe(true)
  })

  it('rejects duplicate collection names', () => {
    expect(() => defineSchema({ collections: [tag, tag] })).toThrow(/duplicate/)
  })

  it('rejects a relation to a collection not in the set', () => {
    expect(() => defineSchema({ collections: [note] })).toThrow(/unknown collection "tag"/)
  })
})

describe('defineSchema layer composition', () => {
  it('tags a non-extends schema entirely platform', () => {
    expect(schema.collections.every((c) => c.layer === 'platform')).toBe(true)
    expect(schema.projectCollections).toEqual([])
    expect(schema.platformCollections).toHaveLength(schema.collections.length)
  })

  it('tags inherited collections platform and local collections project when extends is set', () => {
    const contact = defineCollection({
      name: 'contact',
      label: 'Contact',
      labelPlural: 'Contacts',
      workspaceScoped: true,
      fields: { full_name: f.text({ label: 'Full name', required: true }) },
    })
    const contactCreated = defineEvent({
      key: 'contact.created',
      domain: 'lifecycle',
      payloadSchema: {},
      version: 1,
    })
    const extended = defineSchema({ extends: schema, collections: [contact], events: [contactCreated] })
    expect(extended.collections.find((c) => c.name === 'contact')?.layer).toBe('project')
    expect(extended.collections.find((c) => c.name === 'note')?.layer).toBe('platform')
    expect(extended.projectCollections.map((c) => c.name)).toEqual(['contact'])
    expect(extended.platformCollections.every((c) => c.layer === 'platform')).toBe(true)
    expect(extended.projectEvents.map((event) => event.key)).toEqual(['contact.created'])
    expect(extended.platformEvents.map((event) => event.key)).toEqual(schema.events.map((event) => event.key))
  })

  it('preserves project ownership through nested extensions', () => {
    const contact = defineCollection({
      name: 'contact', label: 'Contact', labelPlural: 'Contacts', workspaceScoped: true, fields: {},
    })
    const company = defineCollection({
      name: 'company', label: 'Company', labelPlural: 'Companies', workspaceScoped: true, fields: {},
    })
    const contactCreated = defineEvent({
      key: 'contact.created', domain: 'lifecycle', payloadSchema: {}, version: 1,
    })
    const companyCreated = defineEvent({
      key: 'company.created', domain: 'lifecycle', payloadSchema: {}, version: 1,
    })
    const template = defineSchema({
      extends: schema, collections: [contact], events: [contactCreated],
    })
    const project = defineSchema({
      extends: template, collections: [company], events: [companyCreated],
    })

    expect(project.platformCollections.map((collection) => collection.name)).toEqual(
      schema.collections.map((collection) => collection.name),
    )
    expect(project.projectCollections.map((collection) => collection.name)).toEqual(['contact', 'company'])
    expect(project.platformEvents.map((event) => event.key)).toEqual(schema.events.map((event) => event.key))
    expect(project.projectEvents.map((event) => event.key)).toEqual(['contact.created', 'company.created'])
  })

  it('rejects an extension that redeclares a platform collection name', () => {
    const dupNote = defineCollection({
      name: 'note',
      label: 'Note',
      labelPlural: 'Notes',
      workspaceScoped: true,
      fields: { title: f.text({ label: 'Title', required: true }) },
    })
    expect(() => defineSchema({ extends: schema, collections: [dupNote] })).toThrow(/duplicate/)
  })

  it('does not mutate the shared collection singleton (stamps copies)', () => {
    defineSchema({ extends: schema, collections: [] })
    expect((note as { layer?: string }).layer).toBeUndefined()
  })
})
