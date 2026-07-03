import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const contentSeo = defineCollection({
  name: 'content_seo',
  label: 'Content SEO',
  labelPlural: 'Content SEO Records',
  workspaceScoped: true,
  internal: true,
  fields: {
    content_item: f.relation('content_item', { label: 'Content Item', cardinality: 'many-to-one', required: true }),
    meta: f.json({ label: 'Meta' }),
    jsonld: f.json({ label: 'JSON-LD' }),
    score: f.number({ label: 'Score', reporting: { role: 'measure' } }),
    checklist: f.json({ label: 'Checklist' }),
  },
})
