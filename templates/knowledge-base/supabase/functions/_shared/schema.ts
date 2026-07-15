import { defineCollection, defineSchema, f, schema as platformSchema } from '@movp/core-schema'

const kbCategory = defineCollection({
  name: 'kb_category',
  label: 'KB Category',
  labelPlural: 'KB Categories',
  workspaceScoped: true,
  fields: {
    name: f.text({ label: 'Name', required: true, searchable: true }),
    slug: f.text({ label: 'Slug', required: true }),
  },
})

const kbArticle = defineCollection({
  name: 'kb_article',
  label: 'KB Article',
  labelPlural: 'KB Articles',
  workspaceScoped: true,
  fields: {
    title: f.text({ label: 'Title', required: true, searchable: true }),
    body: f.richText({ label: 'Body', required: true, searchable: true, embeddable: true }),
    category: f.relation('kb_category', { label: 'Category', cardinality: 'many-to-one' }),
    status: f.enum(['draft', 'published'], {
      label: 'Status',
      default: 'draft',
      reporting: { role: 'dimension' },
    }),
  },
})

export const schema = defineSchema({
  extends: platformSchema,
  collections: [kbCategory, kbArticle],
})

export default schema
