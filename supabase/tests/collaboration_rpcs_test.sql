begin;
select plan(14);

-- Structure + grants.
select has_function('public', 'inbox_feed', array['uuid','text','integer'], 'inbox_feed exists');
select has_function('public', 'resolve_share_link', array['text'], 'resolve_share_link exists');
select is(has_function_privilege('authenticated', 'public.inbox_feed(uuid,text,integer)', 'execute'),
          true, 'authenticated can execute inbox_feed');
select is(has_function_privilege('anon', 'public.inbox_feed(uuid,text,integer)', 'execute'),
          false, 'anon cannot execute inbox_feed');
select is(has_function_privilege('authenticated', 'public.resolve_share_link(text)', 'execute'),
          true, 'authenticated can execute resolve_share_link');

-- Atomic comment+mentions write RPC (SECURITY INVOKER): structure + grants only.
select has_function('public', 'create_comment_with_mentions',
                    array['uuid','text','uuid','text','uuid','uuid[]'], 'create_comment_with_mentions exists');
select is(has_function_privilege('authenticated',
            'public.create_comment_with_mentions(uuid,text,uuid,text,uuid,uuid[])', 'execute'),
          true, 'authenticated can execute create_comment_with_mentions');
select is(has_function_privilege('anon',
            'public.create_comment_with_mentions(uuid,text,uuid,text,uuid,uuid[])', 'execute'),
          false, 'anon cannot execute create_comment_with_mentions');

-- Seed as superuser (reset role bypasses RLS).
reset role;
insert into public.workspace (id, name)
  values ('44444444-4444-4444-4444-444444444444', 'CollabWs') on conflict (id) do nothing;
insert into public.workspace_membership (workspace_id, user_id, role)
  values ('44444444-4444-4444-4444-444444444444', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner')
  on conflict do nothing;
insert into public.note (id, workspace_id, title, body, status)
  values ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444', 'N', 'b', 'draft')
  on conflict (id) do nothing;
insert into public.comment (id, workspace_id, entity_type, entity_id, body, author_id)
  values ('66666666-6666-6666-6666-666666666666', '44444444-4444-4444-4444-444444444444',
          'note', '55555555-5555-5555-5555-555555555555', 'hi', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  on conflict (id) do nothing;
insert into public.mention (workspace_id, comment_id, mentioned_user_id, entity_type, entity_id)
  values ('44444444-4444-4444-4444-444444444444', '66666666-6666-6666-6666-666666666666',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'note', '55555555-5555-5555-5555-555555555555');
insert into public.saved_item (workspace_id, user_id, entity_type, entity_id)
  values ('44444444-4444-4444-4444-444444444444', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          'note', '55555555-5555-5555-5555-555555555555');
insert into public.share_link (workspace_id, entity_type, entity_id, token_hash, scope, created_by)
  values ('44444444-4444-4444-4444-444444444444', 'note', '55555555-5555-5555-5555-555555555555',
          'deadbeefhash', 'view', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
insert into public.share_link (workspace_id, entity_type, entity_id, token_hash, scope, created_by, expires_at)
  values ('44444444-4444-4444-4444-444444444444', 'note', '55555555-5555-5555-5555-555555555555',
          'expiredhash', 'view', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', now() - interval '1 hour');

-- As the member: mentions / saved return their rows; assigned is empty.
set local role authenticated;
set local request.jwt.claims = '{"sub":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}';
select is(jsonb_array_length(public.inbox_feed('44444444-4444-4444-4444-444444444444','mentions',20)),
          1, 'mentions tab returns the mention');
select is(jsonb_array_length(public.inbox_feed('44444444-4444-4444-4444-444444444444','saved',20)),
          1, 'saved tab returns the saved item');
select is(jsonb_array_length(public.inbox_feed('44444444-4444-4444-4444-444444444444','assigned',20)),
          0, 'assigned tab is empty (phase-3 seam)');

-- A non-member gets an empty feed even for a real ws.
set local request.jwt.claims = '{"sub":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}';
select is(jsonb_array_length(public.inbox_feed('44444444-4444-4444-4444-444444444444','mentions',20)),
          0, 'non-member feed is empty');

-- Share link resolves by hash (non-expired); expired resolves to null.
select is((public.resolve_share_link('deadbeefhash'))->>'entity_id',
          '55555555-5555-5555-5555-555555555555', 'resolve_share_link returns the entity ref');
select ok(public.resolve_share_link('expiredhash') is null, 'expired share link resolves to null');

select * from finish();
rollback;
