begin;

select plan(4);

insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111','W1'),
  ('22222222-2222-2222-2222-222222222222','W2');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','member'),
  ('22222222-2222-2222-2222-222222222222','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','member');
insert into public.note (id, workspace_id, title) values
  ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111','W1 note'),
  ('bbbbbbbb-0000-0000-0000-000000000001','22222222-2222-2222-2222-222222222222','W2 note');

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select lives_ok(
  $$update public.note set title = 'edited' where id = 'aaaaaaaa-0000-0000-0000-000000000001'$$,
  'workspace member can update same-workspace note through generated RLS'
);
select is(
  (select title from public.note where id = 'aaaaaaaa-0000-0000-0000-000000000001'),
  'edited',
  'same-workspace update persisted'
);
select lives_ok(
  $$update public.note set title = 'foreign edit' where id = 'bbbbbbbb-0000-0000-0000-000000000001'$$,
  'foreign-workspace update is filtered by RLS, not thrown'
);
reset role;
select is(
  (select title from public.note where id = 'bbbbbbbb-0000-0000-0000-000000000001'),
  'W2 note',
  'foreign-workspace note remains unchanged'
);

select * from finish();
rollback;
