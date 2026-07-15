-- Knowledge-base demo seed. Every referenced row is created here, so db reset is self-contained.
insert into public.workspace (id, name)
  values ('__WORKSPACE_ID__', 'Docs Demo')
  on conflict (id) do nothing;
insert into public.workspace_membership (workspace_id, user_id, role)
  values ('__WORKSPACE_ID__', 'c0000000-0000-0000-0000-0000000000aa', 'owner')
  on conflict (workspace_id, user_id) do nothing;

insert into public.kb_category (id, workspace_id, name, slug)
  values ('c1000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__', 'Getting Started', 'getting-started')
  on conflict (id) do nothing;
insert into public.kb_article (id, workspace_id, title, body, category_id, status)
  values ('c2000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__', 'Install the CLI',
          'Run npm create movp@latest to scaffold a project.',
          'c1000000-0000-0000-0000-000000000001', 'published')
  on conflict (id) do nothing;
