import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  compressHTML: true,
  integrations: [
    starlight({
      title: 'MOVP',
      description: 'Scaffold an agent-connected product in minutes.',
      sidebar: [
        { label: 'Quickstart', slug: 'quickstart' },
        {
          label: 'Templates',
          items: [
            { label: 'CRM-lite', slug: 'guides/crm-lite' },
            { label: 'Marketing site', slug: 'guides/marketing' },
            { label: 'Support desk', slug: 'guides/support' },
            { label: 'Knowledge base', slug: 'guides/knowledge-base' },
          ],
        },
        { label: 'Agent connectivity', slug: 'agents/connectivity' },
        { label: 'Schema reference', items: [{ autogenerate: { directory: 'reference' } }] },
      ],
    }),
  ],
})
