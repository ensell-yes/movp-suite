import { defineCollection, defineSchema, f, schema as platformSchema } from '@movp/core-schema'

const author = defineCollection({
  name: 'author',
  label: 'Author',
  labelPlural: 'Authors',
  workspaceScoped: true,
  fields: {
    full_name: f.text({ label: 'Full name', required: true, searchable: true }),
    bio: f.richText({ label: 'Bio', searchable: true, embeddable: true }),
    avatar_url: f.text({ label: 'Avatar URL' }),
    twitter_handle: f.text({ label: 'Twitter handle' }),
  },
})

const newsletterSubscriber = defineCollection({
  name: 'newsletter_subscriber',
  label: 'Newsletter Subscriber',
  labelPlural: 'Newsletter Subscribers',
  workspaceScoped: true,
  fields: {
    email: f.text({ label: 'Email', required: true }),
    status: f.enum(['subscribed', 'unsubscribed'], {
      label: 'Status',
      default: 'subscribed',
      reporting: { role: 'dimension' },
    }),
    source: f.text({ label: 'Source' }),
  },
})

export const schema = defineSchema({
  extends: platformSchema,
  collections: [author, newsletterSubscriber],
})

export default schema
