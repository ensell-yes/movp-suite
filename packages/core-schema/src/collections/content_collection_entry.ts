import { f } from '../builders.ts'
import { defineCollection } from '../define.ts'

export const contentCollectionEntry = defineCollection({
  name: 'content_collection_entry',
  label: 'Content Collection Entry',
  labelPlural: 'Content Collection Entries',
  workspaceScoped: true,
  internal: true,
  fields: {
    collection: f.relation('content_collection', { label: 'Collection', cardinality: 'many-to-one', required: true }),
    content_item: f.relation('content_item', { label: 'Content Item', cardinality: 'many-to-one', required: true }),
    position: f.number({ label: 'Position', required: true }),
  },
})
