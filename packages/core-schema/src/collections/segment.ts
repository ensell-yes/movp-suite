import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const segment = defineCollection({
  name: 'segment',
  label: 'Segment',
  labelPlural: 'Segments',
  workspaceScoped: true,
  fields: {
    name: f.text({ label: 'Name', required: true, searchable: true }),
    description: f.richText({ label: 'Description', searchable: true }),
    owner_ref: f.text({ label: 'Owner Ref' }),
    active: f.boolean({ label: 'Active', reporting: { role: 'dimension' } }),
    mode: f.enum(['dynamic', 'static'], { label: 'Mode', reporting: { role: 'dimension' } }),
  },
})
