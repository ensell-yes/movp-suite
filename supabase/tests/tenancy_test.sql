begin;
select plan(7);

select has_table('public', 'workspace', 'workspace table exists');
select has_table('public', 'workspace_membership', 'membership table exists');
select has_function('public', 'is_workspace_member', array['uuid'], 'membership helper exists');

-- seed as the migration owner (RLS is bypassed for the table owner)
insert into public.workspace (id, name)
  values ('11111111-1111-1111-1111-111111111111', 'Acme');
insert into public.workspace_membership (workspace_id, user_id, role)
  values ('11111111-1111-1111-1111-111111111111',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner');

-- act as member A
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is(public.is_workspace_member('11111111-1111-1111-1111-111111111111'),
          true, 'member is recognized');
select is((select count(*)::int from public.workspace),
          1, 'member sees the workspace row via RLS');

-- act as non-member B
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is(public.is_workspace_member('11111111-1111-1111-1111-111111111111'),
          false, 'non-member is excluded');
select is((select count(*)::int from public.workspace),
          0, 'non-member sees zero rows via RLS');

select * from finish();
rollback;
