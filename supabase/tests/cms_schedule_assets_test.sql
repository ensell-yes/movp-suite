begin;
select plan(11);

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

select * from finish();
rollback;
