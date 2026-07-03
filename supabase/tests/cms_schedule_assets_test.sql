begin;
select plan(24);

insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111','W1');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','owner');
insert into public.content_type (id, workspace_id, key, label, field_schema) values
  ('0000000c-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','article','Article','[{"name":"title","type":"text"}]'::jsonb);
insert into public.content_item (id, workspace_id, content_type_id, slug, status) values
  ('00000001-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','0000000c-0000-0000-0000-000000000000','published-one','published'),
  ('00000002-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','0000000c-0000-0000-0000-000000000000','draft-two','draft');
insert into public.content_revision (id, workspace_id, content_item_id, revision_number, data, content_hash, author_id) values
  ('000000a1-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','00000001-0000-0000-0000-000000000000',1,'{"title":"Hello World Article"}'::jsonb,'hash-a1','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('000000a2-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','00000002-0000-0000-0000-000000000000',1,'{"title":"Draft Two"}'::jsonb,'hash-a2','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
update public.content_item set published_revision_id='000000a1-0000-0000-0000-000000000000',
  current_revision_id='000000a1-0000-0000-0000-000000000000' where id='00000001-0000-0000-0000-000000000000';
update public.content_item set current_revision_id='000000a2-0000-0000-0000-000000000000'
  where id='00000002-0000-0000-0000-000000000000';
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';

select has_table('public','content_schedule','content_schedule table exists');
select has_table('public','asset','asset table exists');
select has_table('public','content_collection','content_collection table exists');
select has_table('public','content_collection_entry','content_collection_entry table exists');
select has_table('public','content_seo','content_seo table exists');
select has_column('public','content_schedule','content_item_id','content_schedule.content_item_id FK column');
select has_column('public','content_schedule','revision_id','content_schedule.revision_id FK column (the pinned revision)');
select has_column('public','content_schedule','scheduled_by','content_schedule.scheduled_by column');
select has_column('public','content_collection_entry','collection_id','content_collection_entry.collection_id FK column');
select has_column('public','content_collection_entry','content_item_id','content_collection_entry.content_item_id FK column');
select has_column('public','content_seo','content_item_id','content_seo.content_item_id FK column');

insert into public.content_schedule (id, workspace_id, content_item_id, action, revision_id, run_at, scheduled_by, state) values
  ('000000e1-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   '00000001-0000-0000-0000-000000000000','publish','000000a1-0000-0000-0000-000000000000',
   now() + interval '1 hour','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','scheduled');
select is((select count(*)::int from movp_internal.movp_events
           where type='content.scheduled' and payload->>'schedule_id'='000000e1-0000-0000-0000-000000000000'),
          1, 'inserting a content_schedule row emits exactly one content.scheduled event');

insert into public.content_collection (id, workspace_id, key, label) values
  ('000000c1-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111','featured','Featured');
select throws_ok($$
  insert into public.content_collection (workspace_id, key, label)
  values ('11111111-1111-1111-1111-111111111111','featured','Dupe')
$$, '23505', null, 'content_collection(workspace_id, key) is unique');

set local role authenticated;
select lives_ok($$
  insert into public.content_collection_entry (workspace_id, collection_id, content_item_id, position)
  values ('11111111-1111-1111-1111-111111111111','000000c1-0000-0000-0000-000000000000',
          '00000001-0000-0000-0000-000000000000',0)
$$, 'a member may add a PUBLISHED item to a collection');
select throws_ok($$
  insert into public.content_collection_entry (workspace_id, collection_id, content_item_id, position)
  values ('11111111-1111-1111-1111-111111111111','000000c1-0000-0000-0000-000000000000',
          '00000002-0000-0000-0000-000000000000',1)
$$, '42501', null, 'adding a DRAFT item is rejected by RLS (curation is published-only)');
reset role;

select throws_ok($$
  insert into public.content_collection_entry (workspace_id, collection_id, content_item_id, position)
  values ('11111111-1111-1111-1111-111111111111','000000c1-0000-0000-0000-000000000000',
          '00000001-0000-0000-0000-000000000000',2)
$$, '23505', null, 'content_collection_entry(collection_id, content_item_id) is unique');

insert into public.content_seo (workspace_id, content_item_id) values
  ('11111111-1111-1111-1111-111111111111','00000001-0000-0000-0000-000000000000');
select throws_ok($$
  insert into public.content_seo (workspace_id, content_item_id)
  values ('11111111-1111-1111-1111-111111111111','00000001-0000-0000-0000-000000000000')
$$, '23505', null, 'content_seo(content_item_id) is unique (one SEO row per item)');

insert into public.content_schedule (id, workspace_id, content_item_id, action, revision_id, run_at, scheduled_by, state) values
  ('000000e2-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   '00000002-0000-0000-0000-000000000000','publish','000000a2-0000-0000-0000-000000000000',
   now() - interval '1 minute','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','scheduled');
select count(*) from public.claim_due_schedules(50);
select public.run_scheduled_publish('000000e2-0000-0000-0000-000000000000');
select is((select count(*)::int from public.content_publish_event
           where content_item_id='00000002-0000-0000-0000-000000000000'
             and revision_id='000000a2-0000-0000-0000-000000000000' and action='publish'),
          1, 'a due schedule appends exactly one content_publish_event for the PINNED revision');
select is((select status from public.content_item where id='00000002-0000-0000-0000-000000000000'),
          'published', 'the scheduled publish advances content_item.status to published');
select is((select count(*)::int from public.claim_due_schedules(50)), 0,
          'a second claim finds nothing due (the row is already fired)');
select is((select count(*)::int from public.content_publish_event
           where content_item_id='00000002-0000-0000-0000-000000000000'
             and revision_id='000000a2-0000-0000-0000-000000000000' and action='publish'),
          1, 'a re-run claims nothing (fired) so the publish is exactly-once');
select is((select count(*)::int from movp_internal.movp_events
           where type='content.published' and payload->>'id'='00000002-0000-0000-0000-000000000000'),
          1, 'exactly one content.published event');

insert into public.content_schedule (id, workspace_id, content_item_id, action, revision_id, run_at, scheduled_by, state) values
  ('000000e3-0000-0000-0000-000000000000','11111111-1111-1111-1111-111111111111',
   '00000002-0000-0000-0000-000000000000','unpublish','000000a2-0000-0000-0000-000000000000',
   now() - interval '1 minute','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','scheduled');
select count(*) from public.claim_due_schedules(50);
select public.run_scheduled_publish('000000e3-0000-0000-0000-000000000000');
select is((select status from public.content_item where id='00000002-0000-0000-0000-000000000000'),
          'archived', 'a scheduled unpublish sets content_item.status to archived');
select is((select count(*)::int from movp_internal.movp_events
           where type='content.unpublished' and payload->>'id'='00000002-0000-0000-0000-000000000000'),
          1, 'a scheduled unpublish emits exactly one content.unpublished event');

select * from finish();
rollback;
