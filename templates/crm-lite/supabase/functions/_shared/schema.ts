import { defineCollection, defineSchema, f, schema as platformSchema } from '@movp/core-schema'

const contact = defineCollection({
  name: 'contact',
  label: 'Contact',
  labelPlural: 'Contacts',
  workspaceScoped: true,
  fields: {
    full_name: f.text({ label: 'Full name', required: true, searchable: true }),
    email: f.text({ label: 'Email', searchable: true }),
    title: f.text({ label: 'Title' }),
    company: f.relation('company', { label: 'Company', cardinality: 'many-to-one', graph: true }),
  },
})

const company = defineCollection({
  name: 'company',
  label: 'Company',
  labelPlural: 'Companies',
  workspaceScoped: true,
  fields: {
    name: f.text({ label: 'Name', required: true, searchable: true }),
    domain: f.text({ label: 'Domain' }),
    tier: f.enum(['smb', 'mid_market', 'enterprise'], { label: 'Tier', reporting: { role: 'dimension' } }),
  },
})

const deal = defineCollection({
  name: 'deal',
  label: 'Deal',
  labelPlural: 'Deals',
  workspaceScoped: true,
  fields: {
    name: f.text({ label: 'Name', required: true, searchable: true }),
    amount: f.number({ label: 'Amount', reporting: { role: 'measure' } }),
    stage: f.enum(['lead', 'qualified', 'proposal', 'won', 'lost'], {
      label: 'Stage', default: 'lead', reporting: { role: 'dimension' },
    }),
    company: f.relation('company', { label: 'Company', cardinality: 'many-to-one', graph: true }),
    primary_contact: f.relation('contact', { label: 'Primary contact', cardinality: 'many-to-one', graph: true }),
  },
})

// Project schema = platform schema + these three extensions. defineSchema({ extends }) stamps the
// three as layer:'project' and every inherited collection as layer:'platform' (06a).
export const schema = defineSchema({ extends: platformSchema, collections: [contact, company, deal] })
