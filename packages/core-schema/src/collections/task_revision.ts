import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const taskRevision = defineCollection({
  name: 'task_revision',
  label: 'Task Revision',
  labelPlural: 'Task Revisions',
  workspaceScoped: true,
  internal: true,
  fields: {
    task: f.relation('task', { label: 'Task', cardinality: 'many-to-one', required: true }),
    body: f.richText({ label: 'Body', required: true, searchable: true, embeddable: true }),
    content_hash: f.text({ label: 'Content Hash', required: true }),
    author_id: f.uuid({ label: 'Author', required: true }),
  },
})
