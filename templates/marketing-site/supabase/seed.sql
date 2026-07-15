-- Marketing-site demo seed. Every referenced row is created here, so db reset is self-contained.
insert into public.workspace (id, name)
  values ('__WORKSPACE_ID__', 'Marketing Demo')
  on conflict (id) do nothing;
insert into public.workspace_membership (workspace_id, user_id, role)
  values ('__WORKSPACE_ID__', 'a0000000-0000-0000-0000-0000000000aa', 'owner')
  on conflict (workspace_id, user_id) do nothing;

insert into public.content_type (id, workspace_id, key, label, field_schema, moderation_policy, approval_policy)
  values ('a1000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__',
          'blog_post', 'Blog Post', '{"type":"object"}'::jsonb, 'none', 'single')
  on conflict (id) do nothing;

insert into public.author (id, workspace_id, full_name, bio, avatar_url, twitter_handle)
  values ('a2000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__',
          'Ada Lovelace', 'Writes about analytical engines.', null, 'ada')
  on conflict (id) do nothing;
insert into public.newsletter_subscriber (id, workspace_id, email, status, source)
  values ('a3000000-0000-0000-0000-000000000001', '__WORKSPACE_ID__',
          'reader@example.com', 'subscribed', 'homepage')
  on conflict (id) do nothing;
