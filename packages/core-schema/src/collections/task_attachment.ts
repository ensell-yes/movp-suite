import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const taskAttachment = defineCollection({
  name: 'task_attachment',
  label: 'Task Attachment',
  labelPlural: 'Task Attachments',
  workspaceScoped: true,
  internal: true,
  fields: {
    task: f.relation('task', { label: 'Task', cardinality: 'many-to-one', required: true }),
    r2_key: f.text({ label: 'R2 Key', required: true }),
    filename: f.text({ label: 'Filename', required: true }),
    content_type: f.text({ label: 'Content Type' }),
    bytes: f.number({ label: 'Bytes' }),
    uploaded_by: f.uuid({ label: 'Uploaded By', required: true }),
  },
})
