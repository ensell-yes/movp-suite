begin;
select plan(17);

-- Shared seed (as table owner; RLS bypassed).
-- W1 members: A (owner), C (member). B is NOT a member of W1. W2 has no seeded members.
insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'W1'),
  ('22222222-2222-2222-2222-222222222222', 'W2');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('11111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'member');
insert into public.note (id, workspace_id, title, body) values
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'N1', 'body one'),
  ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', 'N2', 'body two');

-- Task 2: structural - tables, composite uniques, entity indexes.
select has_table('public', 'comment',    'comment table exists');
select has_table('public', 'reaction',   'reaction table exists');
select has_table('public', 'saved_item', 'saved_item table exists');
select has_table('public', 'mention',    'mention table exists');
select has_table('public', 'share_link', 'share_link table exists');

select is((select count(*)::int from pg_constraint where conname = 'reaction_uniq' and contype = 'u'),
          1, 'reaction has its composite unique constraint');
select is((select count(*)::int from pg_constraint where conname = 'saved_item_uniq' and contype = 'u'),
          1, 'saved_item has its composite unique constraint');
select is((select count(*)::int from pg_constraint where conname = 'share_link_token_uniq' and contype = 'u'),
          1, 'share_link has its token unique constraint');

select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='comment_entity_idx'),
          1, 'comment entity index exists');
select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='reaction_entity_idx'),
          1, 'reaction entity index exists');
select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='saved_item_entity_idx'),
          1, 'saved_item entity index exists');
select is((select count(*)::int from pg_indexes where schemaname='public' and indexname='mention_entity_idx'),
          1, 'mention entity index exists');

-- Task 3: can_access_entity (act as member A of W1).
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is(public.can_access_entity('note','33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111'),
          true,  'member + entity in ws -> true');
select is(public.can_access_entity('note','44444444-4444-4444-4444-444444444444','11111111-1111-1111-1111-111111111111'),
          false, 'entity not in the passed workspace -> false');
select is(public.can_access_entity('task','99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111'),
          false, 'unknown entity_type -> false (fail closed) even for a member');
-- Act as non-member B (not in W1).
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is(public.can_access_entity('note','33333333-3333-3333-3333-333333333333','11111111-1111-1111-1111-111111111111'),
          false, 'non-member -> false');
select is(public.can_access_entity('task','99999999-9999-9999-9999-999999999999','11111111-1111-1111-1111-111111111111'),
          false, 'unknown entity_type -> false (fail closed), non-member');

select * from finish();
rollback;
