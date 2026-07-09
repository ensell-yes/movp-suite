begin;
select plan(5);

insert into public.workspace (id, name) values
  ('11111111-1111-1111-1111-111111111111', 'Acme');

insert into public.workspace_membership (workspace_id, user_id, role) values
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner'),
  ('11111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'member');

select has_function('public', 'workspace_settings', array['uuid'], 'workspace_settings exists');

set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is(public.workspace_settings('11111111-1111-1111-1111-111111111111') ->> 'name', 'Acme', 'settings returns name');
select is((public.workspace_settings('11111111-1111-1111-1111-111111111111') ->> 'member_count')::int, 2, 'settings returns member count');

set local request.jwt.claims = '{"sub":"dddddddd-dddd-dddd-dddd-dddddddddddd"}';
select throws_ok(
  $$select public.workspace_settings('11111111-1111-1111-1111-111111111111')$$,
  '42501',
  null,
  'non-member denied settings'
);

set local request.jwt.claims = '{"sub":"cccccccc-cccc-cccc-cccc-cccccccccccc"}';
select is((public.workspace_settings('11111111-1111-1111-1111-111111111111') ->> 'member_count')::int, 2, 'plain member can read settings');

select * from finish();
rollback;
