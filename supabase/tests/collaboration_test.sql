begin;
select plan(29);

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

-- Task 4: RLS matrix (still role=authenticated).
-- Member A authors a comment on the accessible note.
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
insert into public.comment (id, workspace_id, entity_type, entity_id, body, author_id)
  values ('55555555-5555-5555-5555-555555555555','11111111-1111-1111-1111-111111111111',
          'note','33333333-3333-3333-3333-333333333333','hello','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select is((select count(*)::int from public.comment where id='55555555-5555-5555-5555-555555555555'),
          1, 'author (member) sees own comment');
-- Non-member B sees nothing.
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is((select count(*)::int from public.comment where id='55555555-5555-5555-5555-555555555555'),
          0, 'non-member sees no comment');
-- Member C (non-author) sees the comment on the accessible entity.
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
select is((select count(*)::int from public.comment where id='55555555-5555-5555-5555-555555555555'),
          1, 'member (non-author) sees comment on accessible entity');
-- Author A edits own comment.
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
update public.comment set body='edited' where id='55555555-5555-5555-5555-555555555555';
select is((select body from public.comment where id='55555555-5555-5555-5555-555555555555'),
          'edited', 'author can edit own comment');
-- Member C cannot edit A's comment (UPDATE filtered by RLS -> no-op).
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
update public.comment set body='hacked' where id='55555555-5555-5555-5555-555555555555';
select is((select body from public.comment where id='55555555-5555-5555-5555-555555555555'),
          'edited', 'non-author member cannot edit the comment');
-- saved_item is owner-only.
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
insert into public.saved_item (workspace_id, entity_type, entity_id, user_id)
  values ('11111111-1111-1111-1111-111111111111','note','33333333-3333-3333-3333-333333333333',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
select is((select count(*)::int from public.saved_item), 1, 'owner sees own saved_item');
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
select is((select count(*)::int from public.saved_item), 0, 'saved_item is private to its owner');
-- Mentions target workspace members only.
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
insert into public.mention (workspace_id, comment_id, mentioned_user_id, entity_type, entity_id)
  values ('11111111-1111-1111-1111-111111111111','55555555-5555-5555-5555-555555555555',
          'cccccccc-cccc-cccc-cccc-cccccccccccc','note','33333333-3333-3333-3333-333333333333');
select throws_ok(
  $$insert into public.mention (workspace_id, comment_id, mentioned_user_id, entity_type, entity_id)
    values ('11111111-1111-1111-1111-111111111111','55555555-5555-5555-5555-555555555555',
            'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','note','33333333-3333-3333-3333-333333333333')$$,
  '42501', NULL,
  'a mention targeting a non-member is denied (mentions target workspace members only)');
-- Mentioned member C sees their own mention.
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
select is((select count(*)::int from public.mention where mentioned_user_id='cccccccc-cccc-cccc-cccc-cccccccccccc'),
          1, 'mentioned member sees their own mention');

-- Negative assertions proving write tightening.
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select throws_ok(
  $$insert into public.saved_item (workspace_id, entity_type, entity_id, user_id)
    values ('11111111-1111-1111-1111-111111111111','note','33333333-3333-3333-3333-333333333333',
            'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')$$,
  '42501', NULL,
  'non-member cannot save into a workspace they do not belong to');

set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
select throws_ok(
  $$insert into public.mention (workspace_id, comment_id, mentioned_user_id, entity_type, entity_id)
    values ('11111111-1111-1111-1111-111111111111','55555555-5555-5555-5555-555555555555',
            'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','note','33333333-3333-3333-3333-333333333333')$$,
  '42501', NULL,
  'a member who did not author the comment cannot mention on it');

reset role;
delete from public.workspace_membership
  where workspace_id='11111111-1111-1111-1111-111111111111'
    and user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
update public.comment set body='edited-after-removal' where id='55555555-5555-5555-5555-555555555555';
delete from public.comment where id='55555555-5555-5555-5555-555555555555';
reset role;
select is((select body from public.comment where id='55555555-5555-5555-5555-555555555555'),
          'edited', 'removed author cannot update or delete their old comment');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner');
set local role authenticated;

select * from finish();
rollback;
