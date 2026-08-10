begin;
select plan(57);

insert into public.workspace (id, name) values
  ('e7000000-0000-0000-0000-000000000001', 'Edit capability workspace');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('e7000000-0000-0000-0000-000000000001', 'e7000000-0000-0000-0000-000000000011', 'owner'),
  ('e7000000-0000-0000-0000-000000000001', 'e7000000-0000-0000-0000-000000000012', 'admin'),
  ('e7000000-0000-0000-0000-000000000001', 'e7000000-0000-0000-0000-000000000013', 'member');

insert into public.content_type (id, workspace_id, key, label, field_schema) values
  (
    'e7000000-0000-0000-0000-000000000101',
    'e7000000-0000-0000-0000-000000000001',
    'base_article',
    'Base article',
    '[{"name":"body","type":"richtext"}]'::jsonb
  );
insert into public.content_item (id, workspace_id, content_type_id, slug, status) values
  (
    'e7000000-0000-0000-0000-000000000201',
    'e7000000-0000-0000-0000-000000000001',
    'e7000000-0000-0000-0000-000000000101',
    'published-one',
    'published'
  ),
  (
    'e7000000-0000-0000-0000-000000000202',
    'e7000000-0000-0000-0000-000000000001',
    'e7000000-0000-0000-0000-000000000101',
    'published-two',
    'published'
  );
insert into public.content_revision
  (id, workspace_id, content_item_id, revision_number, data, content_hash, author_id)
values
  (
    'e7000000-0000-0000-0000-000000000301',
    'e7000000-0000-0000-0000-000000000001',
    'e7000000-0000-0000-0000-000000000201',
    1,
    '{"body":"one"}'::jsonb,
    'edit-capability-base-one',
    'e7000000-0000-0000-0000-000000000011'
  ),
  (
    'e7000000-0000-0000-0000-000000000302',
    'e7000000-0000-0000-0000-000000000001',
    'e7000000-0000-0000-0000-000000000202',
    1,
    '{"body":"two"}'::jsonb,
    'edit-capability-base-two',
    'e7000000-0000-0000-0000-000000000011'
  );
insert into public.content_approval
  (id, workspace_id, content_item_id, state, policy, approvals_required)
values
  (
    'e7000000-0000-0000-0000-000000000401',
    'e7000000-0000-0000-0000-000000000001',
    'e7000000-0000-0000-0000-000000000201',
    'pending',
    'single',
    1
  );
insert into public.content_collection (id, workspace_id, key, label) values
  (
    'e7000000-0000-0000-0000-000000000501',
    'e7000000-0000-0000-0000-000000000001',
    'base_collection',
    'Base collection'
  );
insert into public.content_schedule
  (id, workspace_id, content_item_id, action, revision_id, run_at, scheduled_by, state)
values
  (
    'e7000000-0000-0000-0000-000000000430',
    'e7000000-0000-0000-0000-000000000001',
    'e7000000-0000-0000-0000-000000000201',
    'publish',
    'e7000000-0000-0000-0000-000000000301',
    now() + interval '30 minutes',
    'e7000000-0000-0000-0000-000000000011',
    'scheduled'
  );
insert into public.asset
  (id, workspace_id, filename, mime, r2_key, uploaded_by)
values
  (
    'e7000000-0000-0000-0000-000000000440',
    'e7000000-0000-0000-0000-000000000001',
    'base.png',
    'image/png',
    'base/base.png',
    'e7000000-0000-0000-0000-000000000011'
  );
insert into public.content_collection_entry
  (id, workspace_id, collection_id, content_item_id, position)
values
  (
    'e7000000-0000-0000-0000-000000000520',
    'e7000000-0000-0000-0000-000000000001',
    'e7000000-0000-0000-0000-000000000501',
    'e7000000-0000-0000-0000-000000000201',
    0
  );
insert into public.content_seo
  (id, workspace_id, content_item_id, score)
values
  (
    'e7000000-0000-0000-0000-000000000530',
    'e7000000-0000-0000-0000-000000000001',
    'e7000000-0000-0000-0000-000000000201',
    70
  );
insert into public.campaign (id, workspace_id, name, owner_id) values
  (
    'e7000000-0000-0000-0000-000000000601',
    'e7000000-0000-0000-0000-000000000001',
    'Base campaign',
    'e7000000-0000-0000-0000-000000000011'
  );
insert into public.campaign_deliverable
  (id, workspace_id, campaign_id, name, deliverable_type)
values
  (
    'e7000000-0000-0000-0000-000000000602',
    'e7000000-0000-0000-0000-000000000001',
    'e7000000-0000-0000-0000-000000000601',
    'Base deliverable',
    'post'
  );

create temp table expected_content_write_policy (
  tablename text not null,
  cmd text not null,
  policyname text not null,
  capability text not null
) on commit drop;
insert into expected_content_write_policy (tablename, cmd, policyname, capability) values
  ('asset', 'INSERT', 'asset_edit_insert', 'edit'),
  ('asset', 'UPDATE', 'asset_edit_update', 'edit'),
  ('content_approval', 'INSERT', 'content_approval_edit_insert', 'edit'),
  ('content_approval', 'UPDATE', 'content_approval_approve_update', 'approve'),
  ('content_approval_vote', 'INSERT', 'content_approval_vote_approve_insert', 'approve'),
  ('content_collection', 'INSERT', 'content_collection_edit_insert', 'edit'),
  ('content_collection', 'UPDATE', 'content_collection_edit_update', 'edit'),
  ('content_collection_entry', 'INSERT', 'content_collection_entry_edit_insert', 'edit'),
  ('content_collection_entry', 'UPDATE', 'content_collection_entry_edit_update', 'edit'),
  ('content_item', 'DELETE', 'content_item_edit_delete', 'edit'),
  ('content_item', 'INSERT', 'content_item_edit_insert', 'edit'),
  ('content_item', 'UPDATE', 'content_item_edit_update', 'edit'),
  ('content_publish_event', 'INSERT', 'content_publish_event_publish_insert', 'publish'),
  ('content_revision', 'INSERT', 'content_revision_edit_insert', 'edit'),
  ('content_schedule', 'INSERT', 'content_schedule_publish_insert', 'publish'),
  ('content_schedule', 'UPDATE', 'content_schedule_publish_update', 'publish'),
  ('content_seo', 'INSERT', 'content_seo_edit_insert', 'edit'),
  ('content_seo', 'UPDATE', 'content_seo_edit_update', 'edit'),
  ('content_type', 'DELETE', 'content_type_edit_delete', 'edit'),
  ('content_type', 'INSERT', 'content_type_edit_insert', 'edit'),
  ('content_type', 'UPDATE', 'content_type_edit_update', 'edit'),
  ('edges', 'DELETE', 'edges_content_edit_delete', 'edit'),
  ('edges', 'INSERT', 'edges_content_edit_insert', 'edit'),
  ('edges', 'UPDATE', 'edges_content_edit_update', 'edit'),
  ('experiment', 'DELETE', 'experiment_publish_delete', 'publish'),
  ('experiment', 'INSERT', 'experiment_publish_insert', 'publish'),
  ('experiment', 'UPDATE', 'experiment_publish_update', 'publish'),
  ('experiment_assignment', 'DELETE', 'experiment_assignment_publish_delete', 'publish'),
  ('experiment_assignment', 'INSERT', 'experiment_assignment_publish_insert', 'publish'),
  ('experiment_assignment', 'UPDATE', 'experiment_assignment_publish_update', 'publish'),
  ('experiment_variant', 'DELETE', 'experiment_variant_publish_delete', 'publish'),
  ('experiment_variant', 'INSERT', 'experiment_variant_publish_insert', 'publish'),
  ('experiment_variant', 'UPDATE', 'experiment_variant_publish_update', 'publish');

select results_eq(
  $$
    select
      p.tablename::text collate "C",
      p.cmd::text collate "C",
      p.policyname::text collate "C",
      array_to_string(
        array_remove(array[
          case
            when concat_ws(' ', p.qual, p.with_check) like '%''approve''%'
              then 'approve'
          end,
          case
            when concat_ws(' ', p.qual, p.with_check) like '%''edit''%'
              then 'edit'
          end,
          case
            when concat_ws(' ', p.qual, p.with_check) like '%''publish''%'
              then 'publish'
          end
        ], null),
        ','
      )::text collate "C" as capability
    from pg_catalog.pg_policies p
    where p.schemaname = 'public'
      and p.tablename in (
        'content_type',
        'content_item',
        'content_revision',
        'content_approval',
        'content_approval_vote',
        'content_publish_event',
        'content_schedule',
        'asset',
        'content_collection',
        'content_collection_entry',
        'content_seo',
        'edges',
        'experiment',
        'experiment_assignment',
        'experiment_variant'
      )
      and p.cmd <> 'SELECT'
    order by 1, 2, 3
  $$,
  $$
    select
      tablename collate "C",
      cmd collate "C",
      policyname collate "C",
      capability collate "C"
    from expected_content_write_policy
    order by 1, 2, 3
  $$,
  'CMS write policies exactly match the capability-literal allowlist'
);

select ok(
  (
    select p.prosecdef
    from pg_catalog.pg_proc p
    where p.oid = 'public.has_content_capability(uuid,text)'::regprocedure
  ),
  'has_content_capability remains SECURITY DEFINER'
);
select ok(
  (
    select 'search_path=""' = any (p.proconfig)
    from pg_catalog.pg_proc p
    where p.oid = 'public.has_content_capability(uuid,text)'::regprocedure
  ),
  'has_content_capability pins an empty search path'
);
select ok(
  not has_function_privilege(
    'public',
    'public.has_content_capability(uuid,text)',
    'execute'
  ),
  'PUBLIC cannot execute has_content_capability'
);
select ok(
  not has_function_privilege(
    'anon',
    'public.has_content_capability(uuid,text)',
    'execute'
  ),
  'anon cannot execute has_content_capability'
);
select ok(
  has_function_privilege(
    'authenticated',
    'public.has_content_capability(uuid,text)',
    'execute'
  ),
  'authenticated can execute has_content_capability'
);
select ok(
  coalesce((
    select
      not p.prosecdef
      and 'search_path=""' = any (p.proconfig)
      and (t.tgtype & 1) = 1
      and (t.tgtype & 2) = 2
      and (t.tgtype & 4) = 4
      and (t.tgtype & 16) = 16
      and pg_catalog.pg_get_functiondef(p.oid) like '%tg_op = ''INSERT''%'
      and pg_catalog.pg_get_functiondef(p.oid) like '%has_content_capability(new.workspace_id, ''approve'')%'
      and pg_catalog.pg_get_functiondef(p.oid) like '%has_content_capability(new.workspace_id, ''publish'')%'
      and pg_catalog.pg_get_functiondef(p.oid) like '%old.status in (''published'', ''archived'')%'
      and pg_catalog.pg_get_functiondef(p.oid) like '%not is_system_demotion%'
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    join pg_catalog.pg_trigger t
      on t.tgfoid = p.oid
     and t.tgrelid = 'public.content_item'::regclass
     and t.tgname = 'content_item_publication_transition_guard_tg'
     and not t.tgisinternal
    where n.nspname = 'movp_internal'
      and p.proname = 'guard_content_publication_transition'
      and p.pronargs = 0
  ), false),
  'publication guard covers inserts, updates, withdrawal, and the narrow system demotion'
);

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"e7000000-0000-0000-0000-000000000011","role":"authenticated"}';
select ok(
  public.has_content_capability(
    'e7000000-0000-0000-0000-000000000001',
    'edit'
  ),
  'owner has edit'
);
select ok(
  not public.has_content_capability(
    'e7000000-0000-0000-0000-000000000001',
    'unknown'
  ),
  'unknown capability fails closed'
);

set local request.jwt.claims =
  '{"sub":"e7000000-0000-0000-0000-000000000012","role":"authenticated"}';
select ok(
  public.has_content_capability(
    'e7000000-0000-0000-0000-000000000001',
    'edit'
  ),
  'admin has edit'
);

set local request.jwt.claims =
  '{"sub":"e7000000-0000-0000-0000-000000000013","role":"authenticated"}';
select ok(
  not public.has_content_capability(
    'e7000000-0000-0000-0000-000000000001',
    'edit'
  ),
  'member lacks edit'
);
select throws_ok(
  $$
    insert into public.content_type
      (id, workspace_id, key, label, field_schema)
    values
      ('e7000000-0000-0000-0000-000000000111',
       'e7000000-0000-0000-0000-000000000001',
       'member_type',
       'Member type',
       '[]'::jsonb)
  $$,
  '42501',
  null,
  'member cannot insert content types'
);
select throws_ok(
  $$
    insert into public.content_item
      (id, workspace_id, content_type_id, slug, status)
    values
      ('e7000000-0000-0000-0000-000000000211',
       'e7000000-0000-0000-0000-000000000001',
       'e7000000-0000-0000-0000-000000000101',
       'member-item',
       'draft')
  $$,
  '42501',
  null,
  'member cannot insert content items'
);
select throws_ok(
  $$
    update public.content_type
       set label = 'Member rewrite'
     where id = 'e7000000-0000-0000-0000-000000000101'
  $$,
  '42501',
  null,
  'member content type updates fail loudly'
);
select throws_ok(
  $$
    update public.content_item
       set slug = 'member-rewrite'
     where id = 'e7000000-0000-0000-0000-000000000201'
  $$,
  '42501',
  null,
  'member content item updates fail loudly'
);
select throws_ok(
  $$
    insert into public.content_revision
      (id, workspace_id, content_item_id, revision_number, data, content_hash, author_id)
    values
      ('e7000000-0000-0000-0000-000000000311',
       'e7000000-0000-0000-0000-000000000001',
       'e7000000-0000-0000-0000-000000000201',
       2,
       '{"body":"member"}'::jsonb,
       'edit-capability-member',
       'e7000000-0000-0000-0000-000000000013')
  $$,
  '42501',
  null,
  'member cannot insert revisions'
);
select throws_ok(
  $$
    insert into public.content_approval
      (id, workspace_id, content_item_id, state, policy, approvals_required)
    values
      ('e7000000-0000-0000-0000-000000000411',
       'e7000000-0000-0000-0000-000000000001',
       'e7000000-0000-0000-0000-000000000202',
       'pending',
       'single',
       1)
  $$,
  '42501',
  null,
  'member cannot submit approvals'
);
select throws_ok(
  $$
    update public.content_approval
       set state = 'rejected',
           decided_at = now(),
           decided_by = 'e7000000-0000-0000-0000-000000000013'
     where id = 'e7000000-0000-0000-0000-000000000401'
  $$,
  '42501',
  null,
  'member approval decisions fail loudly'
);
select is(
  (
    select state
    from public.content_approval
    where id = 'e7000000-0000-0000-0000-000000000401'
  ),
  'pending',
  'member approval decision changes no row'
);
select throws_ok(
  $$
    insert into public.content_approval_vote
      (id, workspace_id, approval_id, voter_id, vote)
    values
      ('e7000000-0000-0000-0000-000000000412',
       'e7000000-0000-0000-0000-000000000001',
       'e7000000-0000-0000-0000-000000000401',
       'e7000000-0000-0000-0000-000000000013',
       'approve')
  $$,
  '42501',
  null,
  'member cannot insert approval votes'
);
select throws_ok(
  $$
    insert into public.content_publish_event
      (id, workspace_id, content_item_id, action, revision_id, content_hash, actor_id)
    values
      ('e7000000-0000-0000-0000-000000000421',
       'e7000000-0000-0000-0000-000000000001',
       'e7000000-0000-0000-0000-000000000201',
       'publish',
       'e7000000-0000-0000-0000-000000000301',
       'edit-capability-base-one',
       'e7000000-0000-0000-0000-000000000013')
  $$,
  '42501',
  null,
  'member cannot insert publish events'
);
select throws_ok(
  $$
    insert into public.content_schedule
      (id, workspace_id, content_item_id, action, revision_id, run_at, scheduled_by, state)
    values
      ('e7000000-0000-0000-0000-000000000431',
       'e7000000-0000-0000-0000-000000000001',
       'e7000000-0000-0000-0000-000000000201',
       'publish',
       'e7000000-0000-0000-0000-000000000301',
       now() + interval '1 hour',
       'e7000000-0000-0000-0000-000000000013',
       'scheduled')
  $$,
  '42501',
  null,
  'member cannot schedule publication'
);
select throws_ok(
  $$
    update public.content_schedule
       set state = 'canceled'
     where id = 'e7000000-0000-0000-0000-000000000430'
  $$,
  '42501',
  null,
  'member schedule updates fail loudly'
);
select throws_ok(
  $$
    insert into public.asset
      (id, workspace_id, filename, mime, r2_key, uploaded_by)
    values
      ('e7000000-0000-0000-0000-000000000441',
       'e7000000-0000-0000-0000-000000000001',
       'member.png',
       'image/png',
       'member/member.png',
       'e7000000-0000-0000-0000-000000000013')
  $$,
  '42501',
  null,
  'member cannot insert assets'
);
select throws_ok(
  $$
    update public.asset
       set filename = 'member.png'
     where id = 'e7000000-0000-0000-0000-000000000440'
  $$,
  '42501',
  null,
  'member asset updates fail loudly'
);
select throws_ok(
  $$
    insert into public.content_collection
      (id, workspace_id, key, label)
    values
      ('e7000000-0000-0000-0000-000000000511',
       'e7000000-0000-0000-0000-000000000001',
       'member_collection',
       'Member collection')
  $$,
  '42501',
  null,
  'member cannot insert collections'
);
select throws_ok(
  $$
    update public.content_collection
       set label = 'Member collection'
     where id = 'e7000000-0000-0000-0000-000000000501'
  $$,
  '42501',
  null,
  'member collection updates fail loudly'
);
select throws_ok(
  $$
    insert into public.content_collection_entry
      (id, workspace_id, collection_id, content_item_id, position)
    values
      ('e7000000-0000-0000-0000-000000000521',
       'e7000000-0000-0000-0000-000000000001',
       'e7000000-0000-0000-0000-000000000501',
       'e7000000-0000-0000-0000-000000000201',
       1)
  $$,
  '42501',
  null,
  'member cannot insert collection entries'
);
select throws_ok(
  $$
    update public.content_collection_entry
       set position = 9
     where id = 'e7000000-0000-0000-0000-000000000520'
  $$,
  '42501',
  null,
  'member collection-entry updates fail loudly'
);
select throws_ok(
  $$
    insert into public.content_seo
      (id, workspace_id, content_item_id, score)
    values
      ('e7000000-0000-0000-0000-000000000531',
       'e7000000-0000-0000-0000-000000000001',
       'e7000000-0000-0000-0000-000000000201',
       80)
  $$,
  '42501',
  null,
  'member cannot insert SEO rows'
);
select throws_ok(
  $$
    update public.content_seo
       set score = 1
     where id = 'e7000000-0000-0000-0000-000000000530'
  $$,
  '42501',
  null,
  'member SEO updates fail loudly'
);
select lives_ok(
  $$
    insert into public.edges
      (workspace_id, src_type, src_id, rel, dst_type, dst_id)
    values
      ('e7000000-0000-0000-0000-000000000001',
       'campaign_deliverable',
       'e7000000-0000-0000-0000-000000000602',
       'produces',
       'content_item',
       'e7000000-0000-0000-0000-000000000201')
  $$,
  'member may insert inbound campaign produces edges'
);
select throws_ok(
  $$
    insert into public.edges
      (workspace_id, src_type, src_id, rel, dst_type, dst_id)
    values
      ('e7000000-0000-0000-0000-000000000001',
       'content_item',
       'e7000000-0000-0000-0000-000000000201',
       'references',
       'asset',
       'e7000000-0000-0000-0000-000000000701')
  $$,
  '42501',
  null,
  'member cannot insert content-originated edges'
);
select throws_ok(
  $$
    insert into public.edges
      (workspace_id, src_type, src_id, rel, dst_type, dst_id)
    values
      ('e7000000-0000-0000-0000-000000000001',
       'content_item',
       'e7000000-0000-0000-0000-000000000202',
       'future_authoring_relation',
       'asset',
       'e7000000-0000-0000-0000-000000000702')
  $$,
  '42501',
  null,
  'future content-originated relations fail closed for members'
);
select throws_ok(
  $$
    update public.edges
       set src_type = 'content_item',
           src_id = 'e7000000-0000-0000-0000-000000000202'
     where workspace_id = 'e7000000-0000-0000-0000-000000000001'
       and src_type = 'campaign_deliverable'
       and src_id = 'e7000000-0000-0000-0000-000000000602'
       and rel = 'produces'
  $$,
  '42501',
  null,
  'member cannot rewrite an inbound edge into a content-originated edge'
);

set local request.jwt.claims =
  '{"sub":"e7000000-0000-0000-0000-000000000014","role":"authenticated"}';
select ok(
  not public.has_content_capability(
    'e7000000-0000-0000-0000-000000000001',
    'edit'
  ),
  'non-member lacks edit'
);
select throws_ok(
  $$
    insert into public.content_type
      (id, workspace_id, key, label, field_schema)
    values
      ('e7000000-0000-0000-0000-000000000112',
       'e7000000-0000-0000-0000-000000000001',
       'outsider_type',
       'Outsider type',
       '[]'::jsonb)
  $$,
  '42501',
  null,
  'non-member cannot insert content types'
);

set local request.jwt.claims =
  '{"sub":"e7000000-0000-0000-0000-000000000011","role":"authenticated"}';
select lives_ok(
  $$
    insert into public.content_type
      (id, workspace_id, key, label, field_schema)
    values
      ('e7000000-0000-0000-0000-000000000121',
       'e7000000-0000-0000-0000-000000000001',
       'owner_type',
       'Owner type',
       '[]'::jsonb)
  $$,
  'owner can insert content types'
);
select lives_ok(
  $$
    insert into public.content_item
      (id, workspace_id, content_type_id, slug, status)
    values
      ('e7000000-0000-0000-0000-000000000221',
       'e7000000-0000-0000-0000-000000000001',
       'e7000000-0000-0000-0000-000000000101',
       'owner-item',
       'draft')
  $$,
  'owner can insert content items'
);
select lives_ok(
  $$
    insert into public.content_revision
      (id, workspace_id, content_item_id, revision_number, data, content_hash, author_id)
    values
      ('e7000000-0000-0000-0000-000000000321',
       'e7000000-0000-0000-0000-000000000001',
       'e7000000-0000-0000-0000-000000000201',
       3,
       '{"body":"owner"}'::jsonb,
       'edit-capability-owner',
       'e7000000-0000-0000-0000-000000000011')
  $$,
  'owner can insert revisions'
);
select lives_ok(
  $$
    update public.content_revision
       set content_hash = 'tampered'
     where id = 'e7000000-0000-0000-0000-000000000301'
  $$,
  'revision UPDATE is filtered by RLS without escalating'
);
select is(
  (
    select content_hash
    from public.content_revision
    where id = 'e7000000-0000-0000-0000-000000000301'
  ),
  'edit-capability-base-one',
  'revision UPDATE changes no row for owners'
);
select lives_ok(
  $$
    delete from public.content_revision
     where id = 'e7000000-0000-0000-0000-000000000301'
  $$,
  'revision DELETE is filtered by RLS without escalating'
);
select is(
  (
    select count(*)::integer
    from public.content_revision
    where id = 'e7000000-0000-0000-0000-000000000301'
  ),
  1,
  'revision DELETE removes no row for owners'
);
select lives_ok(
  $$
    insert into public.content_approval
      (id, workspace_id, content_item_id, state, policy, approvals_required)
    values
      ('e7000000-0000-0000-0000-000000000422',
       'e7000000-0000-0000-0000-000000000001',
       'e7000000-0000-0000-0000-000000000202',
       'pending',
       'single',
       1)
  $$,
  'owner can submit approvals'
);
select lives_ok(
  $$
    insert into public.content_publish_event
      (id, workspace_id, content_item_id, action, revision_id, content_hash, actor_id)
    values
      ('e7000000-0000-0000-0000-000000000423',
       'e7000000-0000-0000-0000-000000000001',
       'e7000000-0000-0000-0000-000000000201',
       'publish',
       'e7000000-0000-0000-0000-000000000301',
       'edit-capability-base-one',
       'e7000000-0000-0000-0000-000000000011')
  $$,
  'owner can insert publish events'
);
select throws_ok(
  $$
    insert into public.content_publish_event
      (id, workspace_id, content_item_id, action, revision_id, content_hash, actor_id)
    values
      ('e7000000-0000-0000-0000-000000000424',
       'e7000000-0000-0000-0000-000000000001',
       'e7000000-0000-0000-0000-000000000201',
       'publish',
       'e7000000-0000-0000-0000-000000000301',
       'edit-capability-base-one',
       'e7000000-0000-0000-0000-000000000012')
  $$,
  '42501',
  null,
  'owner cannot forge another actor on a publish event'
);
select lives_ok(
  $$
    insert into public.content_schedule
      (id, workspace_id, content_item_id, action, revision_id, run_at, scheduled_by, state)
    values
      ('e7000000-0000-0000-0000-000000000432',
       'e7000000-0000-0000-0000-000000000001',
       'e7000000-0000-0000-0000-000000000202',
       'publish',
       'e7000000-0000-0000-0000-000000000302',
       now() + interval '1 hour',
       'e7000000-0000-0000-0000-000000000011',
       'scheduled')
  $$,
  'owner can schedule publication'
);
select throws_ok(
  $$
    insert into public.content_schedule
      (id, workspace_id, content_item_id, action, revision_id, run_at, scheduled_by, state)
    values
      ('e7000000-0000-0000-0000-000000000433',
       'e7000000-0000-0000-0000-000000000001',
       'e7000000-0000-0000-0000-000000000202',
       'publish',
       'e7000000-0000-0000-0000-000000000302',
       now() + interval '2 hours',
       'e7000000-0000-0000-0000-000000000012',
       'scheduled')
  $$,
  '42501',
  null,
  'owner cannot forge another scheduler identity'
);
select lives_ok(
  $$
    insert into public.asset
      (id, workspace_id, filename, mime, r2_key, uploaded_by)
    values
      ('e7000000-0000-0000-0000-000000000442',
       'e7000000-0000-0000-0000-000000000001',
       'owner.png',
       'image/png',
       'owner/owner.png',
       'e7000000-0000-0000-0000-000000000011')
  $$,
  'owner can insert assets'
);
select lives_ok(
  $$
    insert into public.content_collection
      (id, workspace_id, key, label)
    values
      ('e7000000-0000-0000-0000-000000000512',
       'e7000000-0000-0000-0000-000000000001',
       'owner_collection',
       'Owner collection')
  $$,
  'owner can insert collections'
);
select lives_ok(
  $$
    insert into public.content_collection_entry
      (id, workspace_id, collection_id, content_item_id, position)
    values
      ('e7000000-0000-0000-0000-000000000522',
       'e7000000-0000-0000-0000-000000000001',
       'e7000000-0000-0000-0000-000000000501',
       'e7000000-0000-0000-0000-000000000202',
       2)
  $$,
  'owner can insert collection entries'
);
select lives_ok(
  $$
    insert into public.content_seo
      (id, workspace_id, content_item_id, score)
    values
      ('e7000000-0000-0000-0000-000000000532',
       'e7000000-0000-0000-0000-000000000001',
       'e7000000-0000-0000-0000-000000000202',
       90)
  $$,
  'owner can insert SEO rows'
);
select lives_ok(
  $$
    insert into public.edges
      (workspace_id, src_type, src_id, rel, dst_type, dst_id)
    values
      ('e7000000-0000-0000-0000-000000000001',
       'content_item',
       'e7000000-0000-0000-0000-000000000201',
       'owner_reference',
       'asset',
       'e7000000-0000-0000-0000-000000000703')
  $$,
  'owner can insert content-originated edges'
);

set local request.jwt.claims =
  '{"sub":"e7000000-0000-0000-0000-000000000012","role":"authenticated"}';
select lives_ok(
  $$
    update public.content_approval
       set state = 'approved',
           approved_revision_id = 'e7000000-0000-0000-0000-000000000301',
           approved_content_hash = 'edit-capability-base-one',
           decided_at = now(),
           decided_by = 'e7000000-0000-0000-0000-000000000012'
     where id = 'e7000000-0000-0000-0000-000000000401'
  $$,
  'admin can decide approvals'
);
select lives_ok(
  $$
    insert into public.content_approval_vote
      (id, workspace_id, approval_id, voter_id, vote)
    values
      ('e7000000-0000-0000-0000-000000000413',
       'e7000000-0000-0000-0000-000000000001',
       'e7000000-0000-0000-0000-000000000401',
       'e7000000-0000-0000-0000-000000000012',
       'approve')
  $$,
  'admin can insert approval votes'
);
select throws_ok(
  $$
    insert into public.content_approval_vote
      (id, workspace_id, approval_id, voter_id, vote)
    values
      ('e7000000-0000-0000-0000-000000000414',
       'e7000000-0000-0000-0000-000000000001',
       'e7000000-0000-0000-0000-000000000401',
       'e7000000-0000-0000-0000-000000000011',
       'approve')
  $$,
  '42501',
  null,
  'admin cannot forge another voter identity'
);

select * from finish();
rollback;
