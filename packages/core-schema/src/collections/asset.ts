import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const asset = defineCollection({
  name: 'asset',
  label: 'Asset',
  labelPlural: 'Assets',
  workspaceScoped: true,
  internal: true,
  fields: {
    filename: f.text({ label: 'Filename', required: true }),
    mime: f.text({ label: 'MIME Type', required: true, reporting: { role: 'dimension' } }),
    r2_key: f.text({ label: 'R2 Key', required: true }),
    size_bytes: f.number({ label: 'Size Bytes', reporting: { role: 'measure' } }),
    checksum: f.text({ label: 'Checksum' }),
    width: f.number({ label: 'Width' }),
    height: f.number({ label: 'Height' }),
    alt_text: f.text({ label: 'Alt Text', searchable: true }),
    uploaded_by: f.uuid({ label: 'Uploaded By', required: true }),
  },
})
