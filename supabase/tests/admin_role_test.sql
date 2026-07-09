begin;
select plan(5);

insert into public.workspace (id, name) values ('11111111-1111-1111-1111-111111111111', 'W1');
insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'admin'),
  ('11111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'member');

select has_function('public', 'is_workspace_admin', array['uuid'], 'is_workspace_admin exists');

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select ok(public.is_workspace_admin('11111111-1111-1111-1111-111111111111'), 'owner is admin');
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select ok(public.is_workspace_admin('11111111-1111-1111-1111-111111111111'), 'admin is admin');
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
select ok(not public.is_workspace_admin('11111111-1111-1111-1111-111111111111'), 'member is not admin');
set local request.jwt.claims = '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd"}';
select ok(not public.is_workspace_admin('11111111-1111-1111-1111-111111111111'), 'non-member is not admin');
reset role;

select * from finish();
rollback;
