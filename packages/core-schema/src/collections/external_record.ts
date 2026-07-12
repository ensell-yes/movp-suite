import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

// The generated-delta registry owns this post-freeze collection's SQL migration.
export const externalRecord = defineCollection({
  name: 'external_record',
  label: 'External Record',
  labelPlural: 'External Records',
  workspaceScoped: true,
  fields: {
    source: f.text({ label: 'Source', required: true }),
    external_id: f.text({ label: 'External ID', required: true }),
    payload: f.json({ label: 'Payload' }),
  },
})
