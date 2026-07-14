export const schema = {
  collections: [
    {
      name: 'contact',
      label: 'Contact',
      labelPlural: 'Contacts',
      workspaceScoped: true,
      layer: 'project',
      fields: { email: { type: 'text', label: 'Email' } },
    },
  ],
  events: [],
}
