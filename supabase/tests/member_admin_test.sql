begin;

select plan(13);

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","email":"owner@example.test"}';
select lives_ok($$select public.create_workspace('Acme')$$, 'owner can create workspace');

create temp table _ws as
  select id from public.workspace where name = 'Acme' limit 1;

select ok((select public.is_workspace_admin((select id from _ws))), 'creator is owner/admin');

create temp table _inv as
  select public.invite_member((select id from _ws), 'invitee@example.test', 'member') as r;

select ok((select r ? 'token' from _inv), 'invite returns one-time token');

reset role;
insert into public.workspace_membership (workspace_id, user_id, role)
  values ((select id from _ws), 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'member');

set local role authenticated;
set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc","email":"member@example.test"}';
select throws_ok(
  format($$select public.invite_member(%L, 'x@example.test', 'member')$$, (select id from _ws)),
  '42501',
  null,
  'non-admin cannot invite'
);

set local request.jwt.claims = '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","email":"wrong@example.test"}';
select throws_ok(
  format($$select public.accept_invite(%L)$$, (select r->>'token' from _inv)),
  '42501',
  null,
  'accept denied on email mismatch'
);

set local request.jwt.claims = '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","email":"invitee@example.test"}';
select lives_ok(
  format($$select public.accept_invite(%L)$$, (select r->>'token' from _inv)),
  'matching email accepts the invite'
);

reset role;
select is(
  (select role from public.workspace_membership where workspace_id = (select id from _ws) and user_id = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'),
  'member',
  'invitee is now a member'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","email":"invitee@example.test"}';
select throws_ok(
  format($$select public.accept_invite(%L)$$, (select r->>'token' from _inv)),
  'P0001',
  null,
  'accepted invite cannot be reused'
);

set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","email":"owner@example.test"}';
select lives_ok(
  format($$select public.set_member_role(%L, 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'admin')$$, (select id from _ws)),
  'admin promotes a member to admin'
);

set local request.jwt.claims = '{"sub":"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee","email":"invitee@example.test"}';
select throws_ok(
  format($$select public.set_member_role(%L, 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'member')$$, (select id from _ws)),
  '42501',
  null,
  'non-admin cannot set roles'
);

set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","email":"owner@example.test"}';
select throws_ok(
  format($$select public.set_member_role(%L, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'member')$$, (select id from _ws)),
  'P0001',
  null,
  'cannot demote the last owner'
);

select throws_ok(
  format($$select public.remove_member(%L, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')$$, (select id from _ws)),
  'P0001',
  null,
  'cannot remove the last owner'
);

select lives_ok(
  format($$select public.remove_member(%L, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee')$$, (select id from _ws)),
  'admin removes a non-owner member'
);

select * from finish();
rollback;
